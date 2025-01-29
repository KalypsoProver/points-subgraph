import { Address, BigInt, Bytes, } from '@graphprotocol/graph-ts';

export const START_TIME = BigInt.fromI32(1738121400); // 2025-01-29 03:30:00
export const EPOCH_LENGTH = BigInt.fromI32(86400); // 1 day
export const GLOBAL_STATE_ID = '1';
export const POINTS_PER_EPOCH = BigInt.fromI32(500000);

export const ZERO_ADDRESS = Address.fromHexString('0x0000000000000000000000000000000000000000');
export const E18 = BigInt.fromI32(10).pow(18);