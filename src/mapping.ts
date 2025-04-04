import { BigInt, log, ethereum, TypedMap } from '@graphprotocol/graph-ts';
import { GlobalState, JobsPerEpoch, Task, Generator, TotalJobsPerEpoch, Delegation, TotalDelegation, Snapshot, EpochState, GeneratorMarketInfo, User } from '../generated/schema';
import { ProofCreated, ProverRewardShareSet, Initialized, TaskCreated } from '../generated/ProofMarketplace/ProofMarketplace';
import { SnapshotConfirmed, VaultSnapshotSubmitted, StakeLocked } from '../generated/SymbioticStaking/SymbioticStaking';
import { ProverJoinedMarketplace, ProverRegistered } from '../generated/ProverManager/ProverManager';

import { EPOCH_LENGTH, GLOBAL_STATE_ID, POINTS_PER_EPOCH, START_TIME, ZERO_ADDRESS } from './constants';
import { getCurrentEpoch, distributePoints } from './utils';

// Check if the epoch is over before running any function
// If the epoch is over, calculate the points for each user and the generator and distribute them

// Every time snapshot is submitted, record the delegations of users
export function handleSnapshotConfirmed(event: SnapshotConfirmed): void {
    distributePoints(event.block.timestamp);

    // update the snapshot with the confirmed timestamp
    let snapshot = Snapshot.load(event.params.confirmedTimestamp.toString());
    if (snapshot == null) {
        log.error('Snapshot not found when snapshot {} was confirmed', [event.params.confirmedTimestamp.toString()]);
        return;
    }

    snapshot.confirmedAt = event.block.timestamp;
    snapshot.save();

    // update the snapshot index in the global state
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if (globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }

    let confirmedSnapshots = globalState.confirmedSnapshots;
    globalState.confirmedSnapshots = confirmedSnapshots.concat([snapshot.id]);
    globalState.save();

    const delegations = snapshot.delegations.load();
    const totalDelegations = snapshot.totalDelegations.load();

    const delegationsByProver = new TypedMap<string, Array<string>>();
    const totalDelegationsByProver = new TypedMap<string, Array<string>>();

    for(let i=0; i < delegations.length; i++) {
        let generatorDelegations = delegationsByProver.get(delegations[i].generator);
        if(!generatorDelegations) {
            generatorDelegations = new Array<string>();
        }
        generatorDelegations.push(delegations[i].id);
        delegationsByProver.set(delegations[i].generator, generatorDelegations);
    }

    for(let i=0; i < totalDelegations.length; i++) {
        let generatorTotalDelegations = totalDelegationsByProver.get(totalDelegations[i].generator);
        if(!generatorTotalDelegations) {
            generatorTotalDelegations = new Array<string>();
        }
        generatorTotalDelegations.push(totalDelegations[i].id);
        totalDelegationsByProver.set(totalDelegations[i].generator, generatorTotalDelegations);
    }

    for(let i=0; i < delegationsByProver.entries.length; i++) {
        let generator = delegationsByProver.entries[i].key;
        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator {} not found when saving delegations', [generator]);
            continue;
        }
        
        let delegations = delegationsByProver.entries[i].value;
        generatorEntity.delegations = delegations;
        generatorEntity.save();
    };

    for(let i = 0; i < totalDelegationsByProver.entries.length; i++) {
        let generator = totalDelegationsByProver.entries[i].key;
        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator {} not found when saving total delegations', [generator]);
            continue;
        }

        let totalDelegations = totalDelegationsByProver.entries[i].value;
        
        generatorEntity.totalDelegation = totalDelegations;
        generatorEntity.save();
    }
}

export function handleVaultSnapshotSubmitted(event: VaultSnapshotSubmitted): void {
    distributePoints(event.block.timestamp);
    const snapshotData = event.params.vaultSnapshotData;
    const snapshotTs = event.params.captureTimestamp;
    let snapshotEntity = Snapshot.load(snapshotTs.toString());
    if(snapshotEntity == null) {
        snapshotEntity = new Snapshot(snapshotTs.toString());
        snapshotEntity.index = GLOBAL_STATE_ID;
        snapshotEntity.transmitter = event.params.transmitter.toHexString();
        snapshotEntity.snapshotTs = snapshotTs;
        snapshotEntity.save();
    }

    const snapshotDataDecodedRaw = ethereum.decode("(address,address,address,uint256)[]", snapshotData);
    if(snapshotDataDecodedRaw == null) {
        log.error('Failed to decode stake data in snapshot {}', [snapshotData.toHexString()]);
        return;
    }
    const snapshotDataDecodedArray = snapshotDataDecodedRaw.toArray();
    let totalDelegation = new TypedMap<string, TypedMap<string, BigInt>>();
    // iterate decoded snapshot data and save the delegation for each user
    for(let i=0; i < snapshotDataDecodedArray.length; i++) {
        const snapshotDataDecoded = snapshotDataDecodedArray[i].toTuple();
        let generator = snapshotDataDecoded[0].toAddress().toHexString();
        let delegator = snapshotDataDecoded[1].toAddress().toHexString();
        let token = snapshotDataDecoded[2].toAddress().toHexString();
        let amount = snapshotDataDecoded[3].toBigInt();

        // check if the generator is registered
        // if not, create a new generator entity
        let generatorEntity = Generator.load(generator);
        if (generatorEntity == null) {
            generatorEntity = new Generator(generator);
            generatorEntity.address = generator;
            generatorEntity.delegations = [];
            generatorEntity.totalDelegation = [];
            generatorEntity.save();
        }

        // check if the delegator exists
        // if not, create a new user entity
        // and set the points to 0
        let delegatorEntity = User.load(delegator);
        if (delegatorEntity == null) {
            delegatorEntity = new User(delegator);
            delegatorEntity.address = delegator;
            delegatorEntity.points = BigInt.fromI32(0);
            delegatorEntity.save();
        }

        // create userDelegation entity for each user
        let userDelegation = Delegation.load(delegator + '-' + generator + '-' + token + '-' + snapshotTs.toString());
        if(userDelegation == null) {
            userDelegation = new Delegation(delegator + '-' + generator + '-' + token + '-' + snapshotTs.toString());
            userDelegation.delegator = delegator;
            userDelegation.generator = generator;
            userDelegation.token = token;
            userDelegation.amount = BigInt.fromI32(0);
            userDelegation.snapshot = snapshotTs.toString();
        }

        userDelegation.amount = userDelegation.amount.plus(amount);
        userDelegation.save();

        // total delegation for generator per token
        let generatorDelegation = totalDelegation.get(generator);
        if(!generatorDelegation) {
            generatorDelegation = new TypedMap<string, BigInt>();
        }
        let tokenDelegation = generatorDelegation.get(token);
        if(!tokenDelegation) {
            tokenDelegation = BigInt.fromI32(0);
        }
        tokenDelegation = tokenDelegation.plus(amount);
        generatorDelegation.set(token, tokenDelegation);
        totalDelegation.set(generator, generatorDelegation);
    }

    // save the total delegation for each generator
    for(let i=0; i < totalDelegation.entries.length; i++) {
        let generator = totalDelegation.entries[i].key;
        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator {} not found when saving total delegation', [generator]);
            continue;
        }

        let generatorDelegation = totalDelegation.entries[i].value;
        for(let i=0; i < generatorDelegation.entries.length; i++) {
            let token = generatorDelegation.entries[i].key;
            let totalDelegation = TotalDelegation.load(generator + '-' + token + '-' + snapshotTs.toString());
            if(totalDelegation == null) {
                totalDelegation = new TotalDelegation(generator + '-' + token + '-' + snapshotTs.toString());
                totalDelegation.generator = generator;
                totalDelegation.token = token;
                totalDelegation.amount = BigInt.fromI32(0);
                totalDelegation.snapshot = snapshotTs.toString();
            }
            totalDelegation.amount = totalDelegation.amount.plus(generatorDelegation.entries[i].value);
            totalDelegation.save();
        }
    }
}

export function handleProverRegistered(event: ProverRegistered): void {
    let generator = Generator.load(event.params.prover.toHexString());
    if (generator == null) {
        generator = new Generator(event.params.prover.toHexString());
        generator.address = event.params.prover.toHexString();
        generator.delegations = [];
        generator.totalDelegation = [];
        generator.save();
    }

    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if (globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }
    let generatorList = globalState.generators;
    globalState.generators = generatorList.concat([generator.id]);
    globalState.save();
}

export function handleProverJoinedMarketplace(event: ProverJoinedMarketplace): void {
    let generator = Generator.load(event.params.prover.toHexString());
    if (generator == null) {
        generator = new Generator(event.params.prover.toHexString());
        generator.address = event.params.prover.toHexString();
        generator.delegations = [];
        generator.totalDelegation = [];
        generator.save();
    }

    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if (globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }
    let marketInfo = GeneratorMarketInfo.load(event.params.prover.toHexString()+ '-' + event.params.marketId.toString());
    if (marketInfo == null) {
        marketInfo = new GeneratorMarketInfo(event.params.prover.toHexString()+ '-' + event.params.marketId.toString());
        marketInfo.generator = event.params.prover.toHexString();
        marketInfo.marketId = event.params.marketId;
    }
    marketInfo.commission = event.params.commission;
    marketInfo.save();
}

export function handleStakeLocked(event: StakeLocked): void {
    distributePoints(event.block.timestamp);
    let task = Task.load(event.params.bidId.toString());
    if (task == null) {
        task = new Task(event.params.bidId.toString());
        task.assignedAt = event.block.timestamp;
        task.epoch = getCurrentEpoch(event.block.timestamp);
        task.token = event.params.token.toHexString();
        task.generator = ZERO_ADDRESS.toHexString();
        task.save();
    }

    let epochState = EpochState.load(task.epoch.toString());
    if (epochState == null) {
        epochState = new EpochState(task.epoch.toString());
        epochState.tokenList = [];
    }

    if(epochState.tokenList.indexOf(task.token) == -1) {
        epochState.tokenList = epochState.tokenList.concat([task.token]);
    }
    epochState.save();
}

export function handleTaskCreated(event: TaskCreated): void {
    distributePoints(event.block.timestamp);
    let task = Task.load(event.params.bidId.toString());
    if (task == null) {
        // Task is created on stake locked event which is handled before this event
        log.error('Task {} not found when task was created', [event.params.bidId.toString()]);
        return;
    }

    task.generator = event.params.prover.toHexString();
    task.save();
}

// Each time a job is completed, record it against jobs completed for that epoch
export function handleProofCreated(event: ProofCreated): void {
    distributePoints(event.block.timestamp);
    let currentTimestamp = event.block.timestamp;
    const epoch = getCurrentEpoch(currentTimestamp);

    // update the task with the completion time
    let task = Task.load(event.params.bidId.toString());
    if (task == null) {
        log.error('Task {} not found for askId when proof was generated', [event.params.bidId.toString()]);
        return;
    }

    task.completedAt = event.block.timestamp;
    task.save();

    // add count of jobs completed for this epoch to the generator
    let jobsPerEpoch = JobsPerEpoch.load(epoch.toString() + '-' + task.generator + '-' + task.token);
    if (jobsPerEpoch == null) {
        jobsPerEpoch = new JobsPerEpoch(epoch.toString() + '-' + task.generator + '-' + task.token);
        jobsPerEpoch.address = task.generator;
        jobsPerEpoch.epoch = epoch;
        jobsPerEpoch.token = task.token;
        jobsPerEpoch.jobCount = BigInt.fromI32(0);
        jobsPerEpoch.jobs = [];
    }

    jobsPerEpoch.jobCount = jobsPerEpoch.jobCount.plus(BigInt.fromI32(1));
    jobsPerEpoch.jobs = jobsPerEpoch.jobs.concat([task.id]);
    jobsPerEpoch.save();

    // add count of jobs completed for this epoch to the global epoch state
    let globalJobsPerEpoch = TotalJobsPerEpoch.load(epoch.toString());
    if (globalJobsPerEpoch == null) {
        globalJobsPerEpoch = new TotalJobsPerEpoch(epoch.toString());
        globalJobsPerEpoch.index = GLOBAL_STATE_ID;
        globalJobsPerEpoch.epoch = epoch;
        globalJobsPerEpoch.jobCount = BigInt.fromI32(0);
        globalJobsPerEpoch.jobs = [];
    }

    globalJobsPerEpoch.jobCount = globalJobsPerEpoch.jobCount.plus(BigInt.fromI32(1));
    globalJobsPerEpoch.jobs = globalJobsPerEpoch.jobs.concat([task.id]);
    globalJobsPerEpoch.save();
}

// pick a start time and define an epoch as 1 day
export function handleInitialized(event: Initialized): void {
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if (globalState == null) {
        globalState = new GlobalState(GLOBAL_STATE_ID);
        globalState.pointsPerEpoch = POINTS_PER_EPOCH;
        globalState.startTime = START_TIME;
        globalState.epochLength = EPOCH_LENGTH;
        globalState.generators = [];
        globalState.pointsDistributedTillEpoch = BigInt.fromI32(-1);
        globalState.confirmedSnapshots = [];
        globalState.save();
    }
}