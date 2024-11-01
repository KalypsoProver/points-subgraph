import { Address, BigInt, Bytes, log, store, ethereum } from '@graphprotocol/graph-ts';
import { GlobalState, JobsPerEpoch, Task, Generator, TotalJobsPerEpoch } from '../generated/schema';
import { ProofCreated, OperatorRewardShareSet, Initialized, TaskCreated } from '../generated/ProofMarketplace/ProofMarketplace';
import { SnapshotConfirmed, VaultSnapshotSubmitted } from '../generated/SymbioticStaking/SymbioticStaking';
import { RegisteredGenerator } from '../generated/GeneratorRegistry/GeneratorRegistry';

import { EPOCH_LENGTH, GLOBAL_STATE_ID, POINTS_PER_EPOCH, START_TIME,  } from './constants';
import { getCurrentEpoch, getEncodedInput } from './utils';

// Check if the epoch is over before running any function
// If the epoch is over, calculate the rewards for each user and the generator and distribute them

export function handleRegisteredGenerator(event: RegisteredGenerator): void {
    let generator = Generator.load(event.params.generator.toHexString());
    if (generator == null) {
        generator = new Generator(event.params.generator.toHexString());
        generator.address = event.params.generator.toHexString();
        generator.save();
    }
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

export function handleTaskCreated(event: TaskCreated): void {
    let task = Task.load(event.params.askId.toString());
    if (task == null) {
        task = new Task(event.params.askId.toString());
        task.assignedAt = event.block.timestamp;
        task.generator = event.params.generator.toHexString();
        task.epoch = getCurrentEpoch(event.block.timestamp);
        task.save();
    }
}

// Each time a job is completed, record it against jobs completed for that epoch
export function handleProofCreated(event: ProofCreated): void {

    let currentTimestamp = event.block.timestamp;
    const epoch = getCurrentEpoch(currentTimestamp);

    let task = Task.load(event.params.askId.toString());
    if (task == null) {
        log.error('Task not found for askId when proof was generated', [event.params.askId.toString()]);
        return;
    }

    task.completedAt = event.block.timestamp;
    task.save();

    // add count of jobs completed for this epoch to the generator
    let jobsPerEpoch = JobsPerEpoch.load(epoch.toString() + '-' + task.generator);
    if (jobsPerEpoch == null) {
        jobsPerEpoch = new JobsPerEpoch(epoch.toString() + '-' + task.generator);
        jobsPerEpoch.address = task.generator;
        jobsPerEpoch.epoch = epoch;
        jobsPerEpoch.jobCount = BigInt.fromI32(0);
    }

    jobsPerEpoch.jobCount = jobsPerEpoch.jobCount.plus(BigInt.fromI32(1));
    jobsPerEpoch.save();

    // add count of jobs completed for this epoch to the global epoch state
    let globalJobsPerEpoch = TotalJobsPerEpoch.load(epoch.toString());
    if (globalJobsPerEpoch == null) {
        globalJobsPerEpoch = new TotalJobsPerEpoch(epoch.toString());
        globalJobsPerEpoch.index = GLOBAL_STATE_ID;
        globalJobsPerEpoch.epoch = epoch;
        globalJobsPerEpoch.jobCount = BigInt.fromI32(0);
    }

    globalJobsPerEpoch.jobCount = globalJobsPerEpoch.jobCount.plus(BigInt.fromI32(1));
    globalJobsPerEpoch.save();
}

// Every time snapshot is submitted, record the delegations of users
export function handleSnapshotConfirmed(event: SnapshotConfirmed): void {
    
}

export function handleVaultSnapshotSubmitted(event: VaultSnapshotSubmitted): void {
    // Note: Assuming that snapshot is always submitted by EOA
    const data = event.transaction.input;
    const inputData = getEncodedInput(data);
    const decoded = ethereum.decode("(uint256,uint256,uint256,bytes32,bytes,bytes)", inputData);
    if(decoded == null) {
        log.error('Failed to decode snapshot data', []);
        return;
    }
    const snapshotData = decoded[4].toString();
    const snapshotDataDecoded = ethereum.decode("((address,address,address,uint256)[])", snapshotData);
    if(snapshotDataDecoded == null) {
        log.error('Failed to decode snapshot data', []);
        return;
    }

    for(let i=0; i<snapshotDataDecoded[0].length; i++) {
        let generator = snapshotDataDecoded[0][i].value0.toHexString();
        let user = snapshotDataDecoded[0][i].value1.toHexString();
        let token = snapshotDataDecoded[0][i].value2.toHexString();
        let amount = snapshotDataDecoded[0][i].value3;

        let userDelegation = JobsPerEpoch.load(user + '-' + GLOBAL_STATE_ID);
    }
}

// pick a start time and define an epoch as 1 day
export function handleInitialized(event: Initialized): void {
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if (globalState == null) {
        globalState = new GlobalState(GLOBAL_STATE_ID);
        globalState.pointsPerEpoch = POINTS_PER_EPOCH;
        globalState.startTime = START_TIME;
        globalState.epochLength = EPOCH_LENGTH;
        globalState.save();
    }
}