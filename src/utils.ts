import { Address, BigInt, Bytes, log, store, TypedMap } from '@graphprotocol/graph-ts';
import { Delegation, EpochState, Generator, GlobalState, JobsPerEpoch, Task, TotalDelegation, TotalJobsPerEpoch, User } from '../generated/schema';

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

    // distribute points for all epochs between last distributed epoch and current epoch - 1
    while(lastDistributedEpoch.lt(currentEpoch.minus(BigInt.fromI32(1)))) {
        lastDistributedEpoch = lastDistributedEpoch.plus(BigInt.fromI32(1));
        distributePointsForEpoch(lastDistributedEpoch);
    }
    globalState.pointsDistributedTillEpoch = lastDistributedEpoch;
    globalState.save();
}

function distributePointsForEpoch(epoch: BigInt): void {
    // Points distribution for an epoch is done as follows:
    // 1. Get the total number of tasks for the epoch
    // 2. Get the list of generators
    // 3. Get the number of tasks per generator for the epoch
    // 4. Calculate the rewards for each generator based on the number of tasks
    // 5. Distribute the rewards to the generators
    // 6. Get the total delegations by token for each generator
    // 7. Get weight of rewards for each token
    // 8. Get the jobs completed by generator for each token
    // 9. Calculate the rewards for each token based on the weight of rewards
    // 10. Distribute the rewards to the delegators based on the amount delegated
    
    // 1. Get the total number of tasks for the epoch
    let totalJobsPerEpoch = TotalJobsPerEpoch.load(epoch.toString());
    if(totalJobsPerEpoch == null) {
        log.info('No jobs found for epoch', [epoch.toString()]);
        return;
    }
    let totalJobs = totalJobsPerEpoch.jobCount;

    // 2. Get the list of generators
    let globalState = GlobalState.load(GLOBAL_STATE_ID);
    if(globalState == null) {
        log.error('Global state not initialized', []);
        return;
    }
    let generatorList = globalState.generators;

    // 3. Get the number of tasks per generator for the epoch
    let generatorJobs = new TypedMap<string, BigInt>();
    let generatorJobsPerToken = new TypedMap<string, TypedMap<string, BigInt>>();

    let epochState = EpochState.load(epoch.toString());
    if(epochState == null) {
        log.warning('Epoch state not found when distributing rewards', [epoch.toString()]);
        return;
    }
    for(let i=0; i < generatorList.length; i++) {
        const generator = generatorList[i];
        let totalGeneratorJobsInEpoch = BigInt.fromI32(0);
        let generatorJobsPerToken = new TypedMap<string, BigInt>();
        for(let j=0; j < epochState.tokenList.length; j++) {
            const token = epochState.tokenList[j];
            let jobsPerEpoch = JobsPerEpoch.load(epoch.toString() + '-' + generator + '-' + token);
            if(jobsPerEpoch == null) {
                log.info('No jobs found for generator using token in the epoch', [epoch.toString(), generator, token]);
                continue;
            }
            totalGeneratorJobsInEpoch = totalGeneratorJobsInEpoch.plus(jobsPerEpoch.jobCount);
            generatorJobsPerToken.set(token, jobsPerEpoch.jobCount);
        }

        let reward = globalState.pointsPerEpoch.times(totalGeneratorJobsInEpoch).div(totalJobs);

        let generatorUserEntity = User.load(generator);
        if(generatorUserEntity == null) {
            generatorUserEntity = new User(generator);
            generatorUserEntity.address = generator;
            generatorUserEntity.points = BigInt.fromI32(0);
        }

        let generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator not registered when distributing rewards', [generator]);
            continue;
        }

        const generatorShare = reward.times(generatorEntity.commission).div(BigInt.fromString('10').pow(18));
        generatorUserEntity.points = generatorUserEntity.points.plus(generatorShare);
        generatorUserEntity.save();
        reward = reward.minus(generatorShare);

        let rewardsPerToken = new TypedMap<string, BigInt>();
        for(let j=0; j < generatorJobsPerToken.entries.length; j++) {
            const token = generatorJobsPerToken.entries[j].key;
            const count = generatorJobsPerToken.entries[j].value;
            const rewardForToken = reward.times(count).div(totalGeneratorJobsInEpoch);

            let totalDelegationForToken = TotalDelegation.load(generator + '-' + token + '-' + epoch.toString());
            if(totalDelegationForToken == null) {
                log.warning('Total delegation not found for generator using token in the epoch', [generator, token, epoch.toString()]);
                continue;
            }

            rewardsPerToken.set(token, rewardForToken.div(totalDelegationForToken.amount));
        }

        const delegations = generatorEntity.delegations;
        for(let j=0; j < delegations.length; j++) {
            const delegationId = delegations[j];
            let delegation = Delegation.load(delegationId);
            if(delegation == null) {
                log.warning('Delegation not found when distributing rewards', [delegationId]);
                return;
            }

            const rewardPerToken = rewardsPerToken.get(delegation.token);
            if (!rewardPerToken) {
                log.warning('No reward found for this token', [delegation.token]);
                return;
            }

            const userShare = rewardPerToken.times(delegation.amount)
            let user = User.load(delegation.delegator);
            if(user == null) {
                user = new User(delegation.delegator);
                user.address = delegation.delegator;
                user.points = BigInt.fromI32(0);
            }
            user.points = user.points.plus(userShare);
            user.save();
        }





        // let jobsPerEpochId = epoch.toString() + '-' + generator;
        // let jobsPerEpoch = JobsPerEpoch.load(jobsPerEpochId);
        // if(jobsPerEpoch == null) {
        //     jobsPerEpoch = new JobsPerEpoch(jobsPerEpochId);
        //     jobsPerEpoch.address = generator;
        //     jobsPerEpoch.epoch = epoch;
        //     jobsPerEpoch.jobCount = BigInt.fromI32(0);
        //     jobsPerEpoch.jobs = [];
        // }
        // let jobs = jobsPerEpoch.jobs;
        // let jobsCount = BigInt.fromI32(jobs.length);

        // // 4. Calculate the rewards for each generator based on the number of tasks
        // let reward = globalState.pointsPerEpoch.times(jobsCount).div(totalJobs);

        // let userEntity = User.load(generator);
        // if(userEntity == null) {
        //     userEntity = new User(generator);
        //     userEntity.address = generator;
        //     userEntity.points = BigInt.fromI32(0);
        // }

        // let generatorEntity = Generator.load(generator);
        // if(generatorEntity == null) {
        //     log.warning('Generator not found when distributing rewards', [generator]);
        //     return;
        // }

        // // 5. Distribute the rewards to the generators
        // const generatorShare = reward.times(generatorEntity.commission).div(BigInt.fromString('1e18'));
        // userEntity.points = userEntity.points.plus(generatorShare);
        // userEntity.save();
        // generatorRewards.set(generator, reward.minus(generatorShare));

        // const rewardPerJob = reward.minus(generatorShare).div(jobsCount);

        // // 8. Get the jobs completed by generator for each token
        // let rewardsByToken = new TypedMap<string, BigInt>();
        // for(let j=0; j < jobs.length; j++) {
        //     const job = jobs[i];
        //     let task = Task.load(job);
        //     if(task == null) {
        //         log.warning('Task not found when distributing rewards', [job]);
        //         return;
        //     }
        //     let token = task.token;
        //     let count = rewardsByToken.get(token);
        //     if(!count) {
        //         count = BigInt.fromI32(0);
        //     }
        //     rewardsByToken.set(
        //         token, 
        //         count.plus(rewardPerJob)
        //     );
        // }
        // generatorRewardsPerToken.set(generator, rewardsByToken);

        // const latestSnapshot = globalState.confirmedSnapshots.pop();
        // if(latestSnapshot == null) {
        //     log.warning('No snapshot found for distributing rewards', []);
        //     return;
        // }

        // // 6. Get the total delegations by token for each generator
        // const generatorDelegationsByToken = new TypedMap<string, BigInt>();
        // const rewardPerToken = generatorRewardsPerToken.get(generator);
        // if(!rewardPerToken) return;
        // for(let j=0; j < rewardPerToken.entries.length; j++) {
        //     const token = rewardPerToken.entries[j].key;
        //     const totalDelegation = TotalDelegation.load(generator + '-' + token + '-' + latestSnapshot.toString());
        //     if(totalDelegation == null) {
        //         log.warning('Total delegation not found for token', [generator, token]);
        //         continue;
        //     }
        //     generatorDelegationsByToken.set(token, totalDelegation.amount);
        // }

        // // 9. Calculate the rewards for each token based on the weight of rewards
        // const delegations = generatorEntity.delegations;
        // for(let j=0; j < delegations.length; j++) {
        //     const delegationId = delegations[j];
        //     let delegation = Delegation.load(delegationId);
        //     if(delegation == null) {
        //         log.warning('Delegation not found when distributing rewards', [delegationId]);
        //         return;
        //     }

        //     const totalDelegations = generatorDelegationsByToken.get(delegation.token);
        //     if (!totalDelegations) {
        //         log.warning('Total delegations not found for token', [delegation.token]);
        //         return;
        //     }

        //     const userShare = rewardPerJob.times(delegation.amount).div(totalDelegations);
        //     let user = User.load(delegation.delegator);
        //     if(user == null) {
        //         user = new User(delegation.delegator);
        //         user.address = delegation.delegator;
        //         user.points = BigInt.fromI32(0);
        //     }
        //     user.points = user.points.plus(userShare);
        //     user.save();
        // }
    }
}