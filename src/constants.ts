import { Address, BigInt, Bytes, } from '@graphprotocol/graph-ts';

export const START_TIME = BigInt.fromI32(1730419200); // 2024-11-01 00:00:00
export const EPOCH_LENGTH = BigInt.fromI32(86400); // 1 day
export const GLOBAL_STATE_ID = '1';
export const POINTS_PER_EPOCH = BigInt.fromI32(500000);

export function getTokenShare(token: String): BigInt {
    // get the token share from the token registry
    if(token == '0x') {
        return BigInt.fromI32(1);
    } else if(token == '0x') {
        return BigInt.fromI32(1);
    } else {
        return BigInt.fromI32(0);
    }
}