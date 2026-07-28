/**
 * Reading a save (PRD 7.4).
 *
 * The mirror of `serialise.ts`, with one extra stage and a different attitude.
 * A save file is the only input to the simulation that comes from outside it:
 * an older build wrote it, a device lost power halfway through writing it, or
 * a player picked the wrong file in the Files app. So every stage validates,
 * and every failure is a `SaveError` with a code — never a `TypeError` from
 * reading a property of undefined, and never a half-built world handed to the
 * simulation.
 *
 * The stages, in order:
 *
 *   1. `readSaveHeader` — magic number, container version, declared lengths.
 *      Cheap, and it rejects a file that is not ours before inflating it.
 *   2. gunzip, then check the plaintext against the header's length and
 *      checksum. Damage that survives gzip's own CRC is caught here.
 *   3. UTF-8 decode and `JSON.parse`.
 *   4. Migrate from the file's version up to `CURRENT_SAVE_VERSION`.
 *   5. Validate the result against the current schema. This runs *after* the
 *      chain, because only the current shape is fully known — an older shape
 *      is whatever the migration for it says it is.
 *   6. `deserialiseSave` rebuilds the `TileGrid` and hands back a `SaveState`.
 */

import type { JsonObject, JsonValue } from '../core/commands'
import type { EventSink } from '../core/simulation'
import { nullEventSink } from '../core/simulation'
import { MAX_GRID_SIZE } from '../world/coords'
import { TILE_FIELDS, TILE_FIELD_BYTES, TileGrid } from '../world/tileGrid'
import type { TileField, TileGridBuffers } from '../world/tileGrid'

import { base64ToBytes, checksumBytes, orientBytes, utf8Decode } from './bytes'
import {
  CURRENT_SAVE_VERSION,
  FIRST_SUPPORTED_SAVE_VERSION,
  SAVE_CONTAINER_VERSION,
  SAVE_HEADER,
  SAVE_HEADER_BYTES,
  SAVE_MAGIC,
  SaveError,
} from './format'
import type { SaveFile, SaveHeader, SerialisedGrid } from './format'
import { gunzipBytes } from './gzip'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'
import type { SaveState } from './state'

export interface LoadOptions {
  /** Where migrations and load failures are reported. */
  readonly events?: EventSink
}

export interface MigrateOptions extends LoadOptions {
  /**
   * The chain to walk. Defaults to the real one; tests substitute a broken
   * table to prove the guards below actually fire.
   */
  readonly migrations?: Readonly<Record<number, Migration>>
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string, expected: string, actual: JsonValue | undefined): SaveError {
  const found =
    actual === undefined
      ? 'nothing'
      : actual === null
        ? 'null'
        : Array.isArray(actual)
          ? 'an array'
          : typeof actual
  return new SaveError('invalid-save', `save field '${path}' must be ${expected}, found ${found}`)
}

function requireObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) throw invalid(path, 'an object', value)
  return value
}

function requireArray(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw invalid(path, 'an array', value)
  return value
}

function requireString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') throw invalid(path, 'a string', value)
  return value
}

function requireInteger(
  value: JsonValue | undefined,
  path: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number') {
    throw invalid(path, `an integer in ${min}..${max}`, value)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SaveError(
      'invalid-save',
      `save field '${path}' must be an integer in ${min}..${max}, found ${value}`,
    )
  }
  return value
}

const UINT32_MAX = 0xffff_ffff
/** No prison runs for 4 billion ticks, but a number that large is not a tick. */
const MAX_PLAYED_TICKS = Number.MAX_SAFE_INTEGER

/** Reads the plaintext header. Does not inflate anything. */
export function readSaveHeader(bytes: Uint8Array): SaveHeader {
  if (bytes.length < SAVE_HEADER_BYTES) {
    throw new SaveError(
      'truncated',
      `a save file is at least ${SAVE_HEADER_BYTES} bytes, received ${bytes.length}`,
    )
  }

  const header = new DataView(bytes.buffer, bytes.byteOffset, SAVE_HEADER_BYTES)
  if (header.getUint32(SAVE_HEADER.MAGIC, true) !== SAVE_MAGIC) {
    throw new SaveError('not-a-save', 'this file is not a Blockwork save')
  }

  const containerVersion = header.getUint32(SAVE_HEADER.CONTAINER_VERSION, true)
  if (containerVersion !== SAVE_CONTAINER_VERSION) {
    throw new SaveError(
      'unsupported-container',
      `this save uses container version ${containerVersion}, and this build reads ` +
        `version ${SAVE_CONTAINER_VERSION}`,
    )
  }

  return {
    containerVersion,
    schemaVersion: header.getUint32(SAVE_HEADER.SCHEMA_VERSION, true),
    payloadBytes: header.getUint32(SAVE_HEADER.PAYLOAD_BYTES, true),
    payloadChecksum: header.getUint32(SAVE_HEADER.PAYLOAD_CHECKSUM, true),
  }
}

/**
 * Runs the chain from `fromVersion` to `CURRENT_SAVE_VERSION`.
 *
 * Exported because the migration chain is worth testing on its own, without a
 * container, a gzip stream or a grid in the way.
 */
export function migrateSave(
  save: JsonObject,
  fromVersion: number,
  options: MigrateOptions = {},
): JsonObject {
  const events = options.events ?? nullEventSink
  const migrations = options.migrations ?? MIGRATIONS

  if (fromVersion > CURRENT_SAVE_VERSION) {
    throw new SaveError(
      'unsupported-version',
      `this save was written by a newer build (save version ${fromVersion}, this build ` +
        `reads up to ${CURRENT_SAVE_VERSION}). Update Blockwork to open it.`,
    )
  }
  if (fromVersion < FIRST_SUPPORTED_SAVE_VERSION) {
    throw new SaveError(
      'unsupported-version',
      `save version ${fromVersion} is older than the oldest supported version ` +
        `${FIRST_SUPPORTED_SAVE_VERSION}`,
    )
  }

  let migrated = save
  for (let version = fromVersion; version < CURRENT_SAVE_VERSION; version += 1) {
    const step = migrations[version]
    if (step === undefined) {
      throw new SaveError(
        'migration-failed',
        `no migration from save version ${version} to ${version + 1}, so the chain to ` +
          `version ${CURRENT_SAVE_VERSION} is broken`,
      )
    }

    let result: JsonObject
    try {
      result = step(migrated)
    } catch (error) {
      throw new SaveError(
        'migration-failed',
        `migrating a save from version ${version} to ${version + 1} failed`,
        { cause: error },
      )
    }

    if (result['version'] !== version + 1) {
      throw new SaveError(
        'migration-failed',
        `the migration from version ${version} produced a save stamped ` +
          `${String(result['version'])} instead of ${version + 1}`,
      )
    }

    migrated = result
    events.emit({
      tick: 0,
      kind: 'save.migrated',
      causeIds: [],
      data: { from: version, to: version + 1 },
    })
  }

  return migrated
}

/**
 * The RNG must restore exactly or the run diverges, so every stream state has
 * to be a real `uint32` and every stream has to be nameable.
 */
function checkRngState(value: JsonValue | undefined): void {
  const object = requireObject(value, 'rngState')
  requireInteger(object['seed'], 'rngState.seed', 0, UINT32_MAX)

  requireArray(object['streams'], 'rngState.streams').forEach((entry, index) => {
    const stream = requireObject(entry, `rngState.streams[${index}]`)
    const name = requireString(stream['name'], `rngState.streams[${index}].name`)
    if (name.length === 0) {
      throw invalid(`rngState.streams[${index}].name`, 'a non-empty string', stream['name'])
    }
    requireInteger(stream['state'], `rngState.streams[${index}].state`, 0, UINT32_MAX)
  })
}

function checkGrid(value: JsonValue | undefined): void {
  const object = requireObject(value, 'grid')
  for (const field of TILE_FIELDS) {
    requireString(object[field], `grid.${field}`)
  }
}

function checkRecords(value: JsonValue | undefined, path: string): readonly JsonObject[] {
  return requireArray(value, path).map((entry, index) => requireObject(entry, `${path}[${index}]`))
}

/** Records the format keys things by. A missing id is a broken save, not a gap. */
function checkIdentifiedRecords(value: JsonValue | undefined, path: string): void {
  checkRecords(value, path).forEach((record, index) => {
    requireInteger(record['id'], `${path}[${index}].id`, 0, UINT32_MAX)
  })
}

/**
 * Checks that a migrated save really is a `SaveFile` of the current version.
 *
 * Strict about the scalars the loader depends on — the grid size decides an
 * allocation, the seed and stream states must be `uint32` for the RNG to
 * restore — and structural about the parts that are still opaque JSON:
 * present, an object or an array, and carrying whatever identity the format
 * already relies on.
 */
export function assertSaveFile(save: JsonObject): asserts save is SaveFile {
  const version = requireInteger(save['version'], 'version', 1, UINT32_MAX)
  if (version !== CURRENT_SAVE_VERSION) {
    throw new SaveError(
      'invalid-save',
      `expected a version ${CURRENT_SAVE_VERSION} save after migration, found ${version}`,
    )
  }

  requireInteger(save['seed'], 'seed', 0, UINT32_MAX)
  requireString(save['createdAt'], 'createdAt')
  requireInteger(save['playedTicks'], 'playedTicks', 0, MAX_PLAYED_TICKS)
  requireInteger(save['mapSize'], 'mapSize', 1, MAX_GRID_SIZE)
  requireObject(save['settings'], 'settings')
  checkGrid(save['grid'])
  checkIdentifiedRecords(save['entities'], 'entities')
  checkIdentifiedRecords(save['rooms'], 'rooms')
  checkIdentifiedRecords(save['sectors'], 'sectors')
  requireObject(save['economy'], 'economy')
  requireObject(save['directorate'], 'directorate')
  checkRecords(save['contracts'], 'contracts')
  requireObject(save['routines'], 'routines')
  requireObject(save['standingOrders'], 'standingOrders')
  checkRecords(save['posts'], 'posts')

  checkRecords(save['log'], 'log').forEach((entry, index) => {
    requireInteger(entry['tick'], `log[${index}].tick`, 0, MAX_PLAYED_TICKS)
  })

  checkRngState(save['rngState'])
}

function parsePayload(text: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SaveError('malformed-json', 'the save payload is not valid JSON', { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SaveError('invalid-save', 'the save payload must be a JSON object')
  }
  return parsed as JsonObject
}

/**
 * Turns any failure on the read path into a reported `SaveError`.
 *
 * A load that fails is a failure the Trace panel should be able to explain
 * (CLAUDE.md rule 5), and the tick is 0 because a save that will not open
 * never reached a tick.
 */
function reportFailure(events: EventSink, error: unknown): SaveError {
  const failure =
    error instanceof SaveError
      ? error
      : new SaveError('invalid-save', 'the save file could not be read', { cause: error })

  events.emit({
    tick: 0,
    kind: 'save.load.failed',
    causeIds: [],
    data: { code: failure.code, message: failure.message },
  })
  return failure
}

/**
 * Bytes to a validated, current-version `SaveFile`.
 *
 * Anything that goes wrong throws a `SaveError`; a caller that wants to keep
 * running can show `error.message` and offer another slot.
 */
export async function decodeSaveFile(
  bytes: Uint8Array,
  options: LoadOptions = {},
): Promise<SaveFile> {
  const events = options.events ?? nullEventSink

  try {
    const header = readSaveHeader(bytes)
    const payload = await gunzipBytes(bytes.subarray(SAVE_HEADER_BYTES))

    if (payload.length !== header.payloadBytes) {
      throw new SaveError(
        'truncated',
        `the save payload is ${payload.length} bytes but its header declares ` +
          `${header.payloadBytes}`,
      )
    }
    if (checksumBytes(payload) !== header.payloadChecksum) {
      throw new SaveError('corrupt-payload', 'the save payload failed its checksum')
    }

    const parsed = parsePayload(utf8Decode(payload))
    const fileVersion = requireInteger(parsed['version'], 'version', 1, UINT32_MAX)
    const migrated = migrateSave(parsed, fileVersion, { events })
    assertSaveFile(migrated)
    return migrated
  } catch (error) {
    throw reportFailure(events, error)
  }
}

/** Rebuilds the tile grid from its base64 arrays. */
export function deserialiseGrid(grid: SerialisedGrid, size: number): TileGrid {
  const buffers: Partial<Record<TileField, ArrayBufferLike>> = {}

  for (const field of TILE_FIELDS) {
    const bytesPerElement = TILE_FIELD_BYTES[field]
    const decoded = orientBytes(base64ToBytes(grid[field], `grid.${field}`), bytesPerElement)
    const expected = size * size * bytesPerElement
    if (decoded.length !== expected) {
      throw new SaveError(
        'corrupt-payload',
        `grid.${field} decodes to ${decoded.length} bytes, but a ${size}x${size} grid ` +
          `needs ${expected}`,
      )
    }
    // `base64ToBytes` allocates exactly, and `orientBytes` either passes that
    // through or returns a same-length copy, so the buffer is never oversized.
    buffers[field] = decoded.buffer
  }

  try {
    return TileGrid.fromBuffers(size, buffers as TileGridBuffers)
  } catch (error) {
    throw new SaveError('corrupt-payload', 'the saved tile grid could not be rebuilt', {
      cause: error,
    })
  }
}

/** A validated `SaveFile` to the live state the simulation runs on. */
export function deserialiseSave(file: SaveFile): SaveState {
  return {
    seed: file.seed,
    playedTicks: file.playedTicks,
    settings: file.settings,
    grid: deserialiseGrid(file.grid, file.mapSize),
    entities: file.entities,
    rooms: file.rooms,
    sectors: file.sectors,
    economy: file.economy,
    directorate: file.directorate,
    contracts: file.contracts,
    routines: file.routines,
    standingOrders: file.standingOrders,
    posts: file.posts,
    log: file.log,
    rngState: file.rngState,
  }
}

/** `decodeSaveFile` then `deserialiseSave`: the whole read path in one call. */
export async function loadFromBytes(
  bytes: Uint8Array,
  options: LoadOptions = {},
): Promise<SaveState> {
  const events = options.events ?? nullEventSink
  const file = await decodeSaveFile(bytes, options)

  // `decodeSaveFile` reports its own failures. Rebuilding the grid can still
  // fail on a base64 array that survived validation, and that failure has to
  // be reported too.
  try {
    return deserialiseSave(file)
  } catch (error) {
    throw reportFailure(events, error)
  }
}
