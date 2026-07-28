/**
 * Save, load and migration (PRD 7.4).
 *
 * The read and write paths are `loadFromBytes` and `saveToBytes`; everything
 * else here exists so a caller can stop at an intermediate stage — inspect a
 * header without inflating a file, migrate a payload without a container,
 * hash a state without writing one.
 *
 * Storage is not here. `packages/sim` has no DOM, so IndexedDB and the Files
 * app live in `packages/app/src/save`, which uses this module for the bytes.
 */

export {
  base64ToBytes,
  bytesToBase64,
  checksumBytes,
  concatBytes,
  orientBytes,
  utf8Decode,
  utf8Encode,
  HOST_IS_LITTLE_ENDIAN,
} from './bytes'

export {
  CURRENT_SAVE_VERSION,
  FIRST_SUPPORTED_SAVE_VERSION,
  MAX_SAVED_LOG_ENTRIES,
  SAVE_CONTAINER_VERSION,
  SAVE_FILE_EXTENSION,
  SAVE_HEADER,
  SAVE_HEADER_BYTES,
  SAVE_MAGIC,
  SaveError,
} from './format'
export type {
  ContractState,
  DirectorateState,
  EconomyState,
  LogEntry,
  MapSettings,
  PostState,
  RoutineState,
  SaveErrorCode,
  SaveFile,
  SaveHeader,
  SerialisedEntity,
  SerialisedGrid,
  SerialisedRngState,
  SerialisedRoom,
  SerialisedSector,
  StandingOrdersState,
} from './format'

export { compressionAvailable, gunzipBytes, gzipBytes } from './gzip'

export { MIGRATIONS, migrationSteps } from './migrations'
export type { Migration } from './migrations'

export { encodeSaveFile, saveToBytes, serialiseGrid, toSaveFile } from './serialise'
export type { SaveOptions } from './serialise'

export {
  assertSaveFile,
  decodeSaveFile,
  deserialiseGrid,
  deserialiseSave,
  loadFromBytes,
  migrateSave,
  readSaveHeader,
} from './deserialise'
export type { LoadOptions } from './deserialise'

export { hashSaveState, saveStateWorld } from './state'
export type { SaveState } from './state'
