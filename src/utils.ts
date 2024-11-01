import { Address, BigInt, Bytes, log, store } from '@graphprotocol/graph-ts';
import { Generator, GlobalState, JobsPerEpoch, TotalDelegation, TotalJobsPerEpoch, User } from '../generated/schema';

import { GLOBAL_STATE_ID, getTokenShare } from './constants';

export function getCurrentEpoch(ts: BigInt): BigInt {
    let globalState = GlobalState.load(GLOBAL_STATE_ID);

    if(globalState == null) {
        log.error('Global state not initialized', []);
        return BigInt.fromI32(0);
    }

    return ts.minus(globalState.startTime).div(globalState.epochLength);
}

export function getEncodedInput(data: Bytes): Bytes {
    let inputDataRaw = data.toHexString().slice(10);
    const inputDataFormatted = '0x0000000000000000000000000000000000000000000000000000000000000020' + inputDataRaw; // prepend tuple offset
    return Bytes.fromHexString(inputDataFormatted) as Bytes;
}

export function distributePoints(ts: BigInt): void {
    let currentEpoch = getCurrentEpoch(ts);

    // check the last epoch for which points were distributed
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if(globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }
    let lastDistributedEpoch = globalState.pointsDistributedTillEpoch;

    while(lastDistributedEpoch.lt(currentEpoch.minus(BigInt.fromI32(1)))) {
        distributePointsForEpoch(lastDistributedEpoch);
        lastDistributedEpoch = lastDistributedEpoch.plus(BigInt.fromI32(1));
    }
    globalState.pointsDistributedTillEpoch = lastDistributedEpoch;
    globalState.save();
}

function distributePointsForEpoch(epoch: BigInt): void {
    // get the total number of tasks for the epoch
    let totalJobsPerEpoch = TotalJobsPerEpoch.load(epoch.toString());
    if(totalJobsPerEpoch == null) {
        totalJobsPerEpoch = new TotalJobsPerEpoch(epoch.toString());
        totalJobsPerEpoch.index = GLOBAL_STATE_ID;
        totalJobsPerEpoch.jobCount = BigInt.fromI32(0);
        totalJobsPerEpoch.epoch = epoch;
        totalJobsPerEpoch.save();
    }
    let totalJobs = totalJobsPerEpoch.jobCount;

    // get generator list
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if(globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }
    let generatorList = globalState.generators;

    // get all the tasks per generator for the epoch
    // calculate the rewards for each generator
    let generatorRewards = new Map<Address, BigInt>();
    generatorList.forEach((generator) => {
        let jobsPerEpoch = JobsPerEpoch.load(epoch.toString() + '-' + generator);
        if(jobsPerEpoch == null) {
            jobsPerEpoch = new JobsPerEpoch(epoch.toString() + '-' + generator);
            jobsPerEpoch.address = generator;
            jobsPerEpoch.epoch = epoch;
            jobsPerEpoch.jobCount = BigInt.fromI32(0);
        }
        let jobs = jobsPerEpoch.jobCount;

        let reward = globalState.pointsPerEpoch.times(jobs).div(totalJobs);
        generatorRewards.set(Address.fromHexString(generator), reward);
        store.remove('JobsPerEpoch', jobsPerEpoch.id);
    });

    // distribute generator rewards
    generatorRewards.forEach((reward, generator) => {
        let userEntity = User.load(generator.toHexString());
        if(userEntity == null) {
            userEntity = new User(generator.toHexString());
            userEntity.address = generator.toHexString();
            userEntity.points = BigInt.fromI32(0);
        }
        
        let generatorEntity = Generator.load(generator.toHexString());
        if(generatorEntity == null) {
            log.warning('Generator not found when distributing rewards', [generator.toHexString()]);
            return;
        }

        const generatorShare = reward.times(generatorEntity.commission).div(BigInt.fromString('1e18'));
        userEntity.points = userEntity.points.plus(generatorShare);
        userEntity.save();
        generatorRewards.set(generator, reward.minus(generatorShare));

        // get total delegations for each generator
        const totalDelegations = new Map<String, BigInt>();
        const totalDelegationEntities = generatorEntity.totalDelegation.load();
        totalDelegationEntities.forEach((delegation) => {
            totalDelegations.set(delegation.token, delegation.amount);
        });

        // get delegations for each user to each generator
        const delegations = generatorEntity.delegations.load();
        delegations.forEach((delegation) => {
            let user = User.load(delegation.delegator);
            if(user == null) {
                user = new User(delegation.delegator);
                user.address = delegation.delegator;
                user.points = BigInt.fromI32(0);
            }

            // distribute rewards for each user
            const rewardForToken = reward.times(getTokenShare(delegation.token)).div(BigInt.fromString('1e18'));
            let tokenDelegations = totalDelegations.get(delegation.token);
            if(!tokenDelegations) {
                let totalTokenDelegation = TotalDelegation.load(delegation.generator + '-' + delegation.token);
                if(totalTokenDelegation == null) {
                    log.warning('Total delegation not found for token', [delegation.generator, delegation.token]);
                    tokenDelegations = BigInt.fromI32(0);
                } else {
                    tokenDelegations = totalTokenDelegation.amount;
                }
            }
            const userShare = rewardForToken.times(delegation.amount).div(tokenDelegations);
            user.points = user.points.plus(userShare);
            user.save();
        });
    });
}