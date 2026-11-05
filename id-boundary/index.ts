export {
  MAX_BIGINT_ID,
  InvalidIdError,
  toBigIntId,
  isValidId,
  fromBigIntId,
  toBigIntIdOrNull,
  fromBigIntIdOrNull,
  toBigIntIds,
  fromBigIntIds,
  compareIds,
  createSyntheticId,
  createSyntheticSerialId,
} from './id-codec'
export { createIdBoundaryExtension } from './extension'
export type { DmmfSource, IdBoundaryExtension } from './extension'
