import { BigInt, log, ethereum, TypedMap, Address } from '@graphprotocol/graph-ts';
import { GlobalState, JobsPerEpoch, Task, Generator, TotalJobsPerEpoch, Delegation, TotalDelegation, Snapshot, EpochState } from '../generated/schema';
import { ProofCreated, OperatorRewardShareSet, Initialized, TaskCreated } from '../generated/ProofMarketplace/ProofMarketplace';
import { SnapshotConfirmed, VaultSnapshotSubmitted, StakeLocked } from '../generated/SymbioticStaking/SymbioticStaking';
import { RegisteredGenerator } from '../generated/GeneratorRegistry/GeneratorRegistry';

import { EPOCH_LENGTH, GLOBAL_STATE_ID, POINTS_PER_EPOCH, START_TIME, ZERO_ADDRESS } from './constants';
import { getCurrentEpoch, getEncodedInput, distributePoints } from './utils';

// Check if the epoch is over before running any function
// If the epoch is over, calculate the points for each user and the generator and distribute them

// Every time snapshot is submitted, record the delegations of users
export function handleSnapshotConfirmed(event: SnapshotConfirmed): void {
    distributePoints(event.block.timestamp);

    // update the snapshot with the confirmed timestamp
    let snapshot = Snapshot.load(event.params.confirmedTimestamp.toString());
    if (snapshot == null) {
        log.error('Snapshot not found when snapshot was confirmed', [event.params.confirmedTimestamp.toString()]);
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

    globalState.confirmedSnapshots.push(snapshot.id);
    globalState.save();

    const delegations = snapshot.delegations.load();
    const totalDelegations = snapshot.totalDelegations.load();

    const delegationsByProver = new TypedMap<string, Array<string>>();
    const totalDelegationsByProver = new TypedMap<string, Array<string>>();

    for(let i=0; i < delegations.length; i++) {
        const generatorDelegations = delegationsByProver.get(delegations[i].generator);
        if(!generatorDelegations) {
            delegationsByProver.set(delegations[i].generator, new Array<string>());
        } else {
            generatorDelegations.push(delegations[i].id);
            delegationsByProver.set(delegations[i].generator, generatorDelegations);
        }
    }

    for(let i=0; i < totalDelegations.length; i++) {
        const generatorTotalDelegations = totalDelegationsByProver.get(totalDelegations[i].generator);
        if(!generatorTotalDelegations) {
            totalDelegationsByProver.set(totalDelegations[i].generator, new Array<string>());
        } else {
            generatorTotalDelegations.push(totalDelegations[i].id);
            totalDelegationsByProver.set(totalDelegations[i].generator, generatorTotalDelegations);
        }
    }

    for(let i=0; i < delegationsByProver.entries.length; i++) {
        let generator = delegationsByProver.entries[i].key;
        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator not found when saving delegations', [generator]);
            return;
        }
        
        let delegations = delegationsByProver.entries[i].value;
        generatorEntity.delegations = delegations;
        generatorEntity.save();
    };

    for(let i = 0; i < totalDelegationsByProver.entries.length; i++) {
        let generator = totalDelegationsByProver.entries[i].key;
        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator not found when saving total delegations', [generator]);
            return;
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

    const snapshotDataDecodedRaw = ethereum.decode("((address,address,address,uint256)[])", snapshotData);
    if(snapshotDataDecodedRaw == null) {
        log.error('Failed to decode stake data in snapshot', [snapshotData.toHexString()]);
        return;
    }
    const snapshotDataDecodedArray = snapshotDataDecodedRaw.toArray();
    let totalDelegation = new TypedMap<string, TypedMap<string, BigInt>>();
    // iterate decoded snapshot data and save the delegation for each user
    for(let i=0; i < snapshotDataDecodedArray.length; i++) {
        const snapshotDataDecodedElementRaw = snapshotDataDecodedArray[i];
        const snapshotDataDecoded = snapshotDataDecodedElementRaw.toTuple();
        let generator = snapshotDataDecoded[0].toAddress().toHexString();
        let delegator = snapshotDataDecoded[1].toAddress().toHexString();
        let token = snapshotDataDecoded[2].toAddress().toHexString();
        let amount = snapshotDataDecoded[3].toBigInt();

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
            log.warning('Generator not found when saving total delegation', [generator]);
            return;
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

export function handleRegisteredGenerator(event: RegisteredGenerator): void {
    let generator = Generator.load(event.params.generator.toHexString());
    if (generator == null) {
        generator = new Generator(event.params.generator.toHexString());
        generator.address = event.params.generator.toHexString();
        generator.commission = BigInt.fromI32(0);
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
    generatorList.push(generator.id);
    globalState.generators = generatorList;
    globalState.save();
}

// Record the commission of the generator
export function handleOperatorRewardShareSet(event: OperatorRewardShareSet): void {
    let generator = Generator.load(event.params.operator.toHexString());
    if (generator == null) {
        log.warning('Generator not found when setting operator reward share', [event.params.operator.toHexString()]);
        return;
    }

    generator.commission = event.params.rewardShare;
    generator.save();
}

export function handleStakeLocked(event: StakeLocked): void {
    distributePoints(event.block.timestamp);
    let task = Task.load(event.params.jobId.toString());
    if (task == null) {
        task = new Task(event.params.jobId.toString());
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
        epochState.tokenList.push(task.token);
    }
    epochState.save();
}

export function handleTaskCreated(event: TaskCreated): void {
    distributePoints(event.block.timestamp);
    let task = Task.load(event.params.askId.toString());
    if (task == null) {
        // Task is created on stake locked event which is handled before this event
        log.error('Task not found when task was created', [event.params.askId.toString()]);
        return;
    }

    task.generator = event.params.generator.toHexString();
    task.save();
}

// Each time a job is completed, record it against jobs completed for that epoch
export function handleProofCreated(event: ProofCreated): void {
    distributePoints(event.block.timestamp);
    let currentTimestamp = event.block.timestamp;
    const epoch = getCurrentEpoch(currentTimestamp);

    // update the task with the completion time
    let task = Task.load(event.params.askId.toString());
    if (task == null) {
        log.error('Task not found for askId when proof was generated', [event.params.askId.toString()]);
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
    jobsPerEpoch.jobs.push(task.id);
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
    globalJobsPerEpoch.jobs.push(task.id);
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
        globalState.pointsDistributedTillEpoch = BigInt.fromI32(0);
        globalState.confirmedSnapshots = [];
        globalState.save();
    }
}