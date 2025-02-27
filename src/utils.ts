import { BigInt, log, TypedMap } from '@graphprotocol/graph-ts';
import { Delegation, EpochState, Generator, GeneratorMarketInfo, GlobalState, JobsPerEpoch, PointsByEpoch, PointsByGenerator, TotalDelegation, TotalJobsPerEpoch, User } from '../generated/schema';

import { E18, GLOBAL_STATE_ID } from './constants';

export function getCurrentEpoch(ts: BigInt): BigInt {
    let globalState = GlobalState.load(GLOBAL_STATE_ID);

    if(globalState == null) {
        log.error('Global state not initialized', []);
        return BigInt.fromI32(0);
    }

    return ts.minus(globalState.startTime).div(globalState.epochLength);
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
        log.info('No jobs found for epoch {}', [epoch.toString()]);
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
    if(globalState.confirmedSnapshots.length == 0) {
        log.warning('No snapshot found for distributing rewards', []);
        return;
    }
    const latestSnapshot = globalState.confirmedSnapshots.pop() || '0';

    let epochState = EpochState.load(epoch.toString());
    if(epochState == null) {
        log.warning('Epoch state for {} not found when distributing rewards', [epoch.toString()]);
        return;
    }
    
    // Track points by epoch for each user
    let pointsTrackingByAddress = new TypedMap<string, BigInt>();
    let pointsTrackingByGeneratorAndUser = new TypedMap<string, BigInt>();
    
    for(let i=0; i < generatorList.length; i++) {
        const generator = generatorList[i];
        let totalGeneratorJobsInEpoch = BigInt.fromI32(0);
        let generatorJobsPerToken = new TypedMap<string, BigInt>();
        for(let j=0; j < epochState.tokenList.length; j++) {
            const token = epochState.tokenList[j];
            let jobsPerEpoch = JobsPerEpoch.load(epoch.toString() + '-' + generator + '-' + token);
            if(jobsPerEpoch == null) {
                log.info('No jobs found for generator {} using token {} in epoch {}', [generator, token, epoch.toString()]);
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

        // TODO: Introduce commission by market
        let generatorMarketEntity = GeneratorMarketInfo.load(generator+'-'+BigInt.fromI32(1).toString());
        if(generatorMarketEntity == null) {
            log.warning('Generator {} commission not registered when distributing rewards', [generator]);
            continue;
        }
        const commission = generatorMarketEntity.commission;

        const generatorShare = reward.times(commission).div(E18);
        generatorUserEntity.points = generatorUserEntity.points.plus(generatorShare);
        generatorUserEntity.save();
        
        // Track generator's points for this epoch
        let existingPoints = pointsTrackingByAddress.get(generator);
        let newPoints = existingPoints ? existingPoints.plus(generatorShare) : generatorShare;
        pointsTrackingByAddress.set(generator, newPoints);
        
        // TODO: Self generation of points for generator isn't considered
        // Track this specific generator's points as its own source (self-generation)
        let generatorSelfKey = generator + '-' + generator;
        let currentGeneratorSelfPoints = pointsTrackingByGeneratorAndUser.get(generatorSelfKey);
        let updatedGeneratorSelfPoints = currentGeneratorSelfPoints ? currentGeneratorSelfPoints.plus(generatorShare) : generatorShare;
        pointsTrackingByGeneratorAndUser.set(generatorSelfKey, updatedGeneratorSelfPoints);
        
        reward = reward.minus(generatorShare);

        let rewardsPerToken = new TypedMap<string, BigInt>();
        for(let j=0; j < generatorJobsPerToken.entries.length; j++) {
            const token = generatorJobsPerToken.entries[j].key;
            const count = generatorJobsPerToken.entries[j].value;
            const rewardForToken = reward.times(count).div(totalGeneratorJobsInEpoch);

            let totalDelegationForToken = TotalDelegation.load(generator + '-' + token + '-' + latestSnapshot.toString());
            if(totalDelegationForToken == null) {
                log.warning('Total delegation not found for generator {} using token {} in the snapshot {}', [generator, token, latestSnapshot.toString()]);
                continue;
            }

            rewardsPerToken.set(token, rewardForToken.times(E18).div(totalDelegationForToken.amount));
        }

        const generatorEntity = Generator.load(generator);
        if(generatorEntity == null) {
            log.warning('Generator {} not found when distributing rewards', [generator]);
            continue;
        }
        const delegations = generatorEntity.delegations;
        for(let j=0; j < delegations.length; j++) {
            const delegationId = delegations[j];
            let delegation = Delegation.load(delegationId);
            if(delegation == null) {
                log.warning('Delegation {} not found when distributing rewards', [delegationId]);
                continue;
            }

            const rewardPerToken = rewardsPerToken.get(delegation.token);
            if (!rewardPerToken) {
                log.warning('No reward found for token {}', [delegation.token]);
                continue;
            }

            const userShare = rewardPerToken.times(delegation.amount).div(E18);
            let user = User.load(delegation.delegator);
            if(user == null) {
                user = new User(delegation.delegator);
                user.address = delegation.delegator;
                user.points = BigInt.fromI32(0);
            }
            user.points = user.points.plus(userShare);
            user.save();
            
            // Track delegator's points for this epoch
            let currentDelegatorPoints = pointsTrackingByAddress.get(delegation.delegator);
            let updatedDelegatorPoints = currentDelegatorPoints ? currentDelegatorPoints.plus(userShare) : userShare;
            pointsTrackingByAddress.set(delegation.delegator, updatedDelegatorPoints);
            
            // Track points by generator for this delegator
            let delegatorGeneratorKey = delegation.delegator + '-' + generator;
            let currentDelegatorGeneratorPoints = pointsTrackingByGeneratorAndUser.get(delegatorGeneratorKey);
            let updatedDelegatorGeneratorPoints = currentDelegatorGeneratorPoints ? currentDelegatorGeneratorPoints.plus(userShare) : userShare;
            pointsTrackingByGeneratorAndUser.set(delegatorGeneratorKey, updatedDelegatorGeneratorPoints);
        }
    }
    
    // Save accumulated points by epoch
    for (let i = 0; i < pointsTrackingByAddress.entries.length; i++) {
        const address = pointsTrackingByAddress.entries[i].key;
        const points = pointsTrackingByAddress.entries[i].value;
        
        let pointsByEpoch = PointsByEpoch.load(epoch.toString() + '-' + address);
        if (pointsByEpoch == null) {
            pointsByEpoch = new PointsByEpoch(epoch.toString() + '-' + address);
            pointsByEpoch.address = address;
            pointsByEpoch.epoch = epoch;
            pointsByEpoch.points = BigInt.fromI32(0);
            pointsByEpoch.pointsByGenerator = [];
        }
        
        pointsByEpoch.points = pointsByEpoch.points.plus(points);
        pointsByEpoch.save();
    }
    
    // Save points by generator
    for (let i = 0; i < pointsTrackingByGeneratorAndUser.entries.length; i++) {
        const key = pointsTrackingByGeneratorAndUser.entries[i].key;
        const points = pointsTrackingByGeneratorAndUser.entries[i].value;
        
        const keyParts = key.split('-');
        const address = keyParts[0];
        const generator = keyParts[1];
        
        let pointsByGenerator = PointsByGenerator.load(epoch.toString() + '-' + address + '-' + generator);
        if (pointsByGenerator == null) {
            pointsByGenerator = new PointsByGenerator(epoch.toString() + '-' + address + '-' + generator);
            pointsByGenerator.address = address;
            pointsByGenerator.epoch = epoch;
            pointsByGenerator.generator = generator;
            pointsByGenerator.points = BigInt.fromI32(0);
        }
        
        pointsByGenerator.points = pointsByGenerator.points.plus(points);
        pointsByGenerator.save();
        
        // Link to parent PointsByEpoch entity
        let pointsByEpoch = PointsByEpoch.load(epoch.toString() + '-' + address);
        if (pointsByEpoch != null) {
            pointsByEpoch.pointsByGenerator = pointsByEpoch.pointsByGenerator.concat([pointsByGenerator.id]);
            pointsByEpoch.save();
        }
    }
}