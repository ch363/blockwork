/**
 * The save format (PRD 7.4): what a `.blockwork` file contains and how its
 * bytes are laid out.
 *
 * Two versions live here and they are deliberately separate.
 *
 *   - `SAVE_CONTAINER_VERSION` versions the *envelope*: the magic number, the
 *     header fields, the compression. It changes when the bytes around the
 *     payload change, which should be almost never.
 *   - `CURRENT_SAVE_VERSION` versions the *payload*, the `SaveFile` object.
 *     It is the number the migration chain walks, and it moves whenever a
 *     system changes the shape of what it stores.
 *
 * Splitting them means a reader can decide whether it understands a file, and
 * which migrations it must run, without decompressing a megabyte first. It
 * also means a payload migration never has to care about compression.
 *
 * **Placeholder state types.** Most of the systems PRD 7.4 lists do not exist
 * yet; they arrive across phases 1 to 5. Their state is typed here as opaque
 * JSON so that the save format is complete from day one and so that the ticket
 * which builds each system replaces one alias rather than the whole format.
 * Opaque does not mean unchecked: the loader still verifies that each field is
 * present and is JSON of the right broad shape, and a system that later gives
 * its state a real interface gets a migration, not a silent reinterpretation.
 */

import type { JsonObject } from '../core/commands'
import type { TileField } from '../world/tileGrid'

/**
 * The payload schema version this build writes and migrates towards.
 *
 * v1 was the format at T0.6. v2 is identical to it and exists so the migration
 * chain has a real step in it from the start (see `migrations/`): a chain with
 * no entries is a chain nobody has ever run.
 */
export const CURRENT_SAVE_VERSION = 2

/** The oldest payload version the migration chain can still bring forward. */
export const FIRST_SUPPORTED_SAVE_VERSION = 1

/** `'BWSV'`, big-endian ASCII. Rejects a file that was never one of ours. */
export const SAVE_MAGIC = 0x42575356

/** The envelope version. See the module comment for why it is not the schema version. */
export const SAVE_CONTAINER_VERSION = 1

/**
 * Header layout, all little-endian `uint32`. The payload follows immediately:
 * a gzip stream whose plaintext is the UTF-8 JSON of a `SaveFile`.
 */
export const SAVE_HEADER = {
  MAGIC: 0,
  CONTAINER_VERSION: 4,
  /** The payload's `version`, readable without decompressing. */
  SCHEMA_VERSION: 8,
  /** Plaintext length in bytes, so a truncated gzip stream is caught. */
  PAYLOAD_BYTES: 12,
  /** FNV-1a over the plaintext bytes, so a flipped bit is caught. */
  PAYLOAD_CHECKSUM: 16,
} as const

export const SAVE_HEADER_BYTES = 20

/** The extension used for export and import through the Files app. */
export const SAVE_FILE_EXTENSION = '.blockwork'

/**
 * PRD 7.4 caps the saved log at 2000 entries. A format limit rather than a
 * balance number: it bounds the file, and the oldest entries are the ones a
 * player will never scroll back to.
 */
export const MAX_SAVED_LOG_ENTRIES = 2000

/**
 * Why a save could not be written or read.
 *
 * Load is the one place where the input is genuinely untrusted — a file the
 * player picked, a record written by an older build, a partial write from a
 * device that lost power — so every failure mode gets a code a caller can
 * branch on and a message a player could be shown.
 */
export type SaveErrorCode =
  /** Not a `.blockwork` file: the magic number does not match. */
  | 'not-a-save'
  /** Fewer bytes than the header needs, or a payload shorter than declared. */
  | 'truncated'
  /** A container version this build does not know how to open. */
  | 'unsupported-container'
  /** Gzip refused the payload on the way out. Should never happen. */
  | 'compression-failed'
  /** Gzip refused the payload on the way in: the bytes are damaged. */
  | 'decompression-failed'
  /** The plaintext checksum or length disagrees with the header. */
  | 'corrupt-payload'
  /** The plaintext is not valid UTF-8 JSON. */
  | 'malformed-json'
  /** Valid JSON, but not the shape a `SaveFile` of that version must have. */
  | 'invalid-save'
  /** Older than `FIRST_SUPPORTED_SAVE_VERSION`, or newer than this build. */
  | 'unsupported-version'
  /** The chain is missing a step, or a step threw. */
  | 'migration-failed'
  /** The host has no Compression Streams implementation. */
  | 'compression-unavailable'

/** Every failure this module raises. Never a bare `Error`, never a crash. */
export class SaveError extends Error {
  override readonly name = 'SaveError'
  readonly code: SaveErrorCode

  constructor(code: SaveErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/**
 * New-game options that stay fixed for the life of a prison.
 *
 * T6.5 gives this a real shape when map creation and settings land.
 */
export type MapSettings = JsonObject

/**
 * The tile grid as base64, one string per parallel array (PRD 7.4's
 * `{ [K in keyof TileGrid]: string }`, narrowed to the fields that are
 * actually arrays).
 *
 * The bytes inside are little-endian regardless of the host that wrote them,
 * so a save is portable between architectures.
 */
export type SerialisedGrid = { readonly [K in TileField]: string }

/** T2.4 and T2.7 replace this when inmates and staff land. */
export interface SerialisedEntity extends JsonObject {
  /** Stable entity id. 0 is never a live entity. */
  readonly id: number
}

/** T1.3 replaces this when room detection lands. */
export interface SerialisedRoom extends JsonObject {
  readonly id: number
}

/** T4.1 replaces this when sectors land. */
export interface SerialisedSector extends JsonObject {
  readonly id: number
}

/** T3.6: opaque until save wiring serialises `EconomyLedger`. */
export type EconomyState = JsonObject

/** T5.1 replaces this when the Directorate lands. */
export type DirectorateState = JsonObject

/** T3.7: opaque until save wiring serialises `ContractBook`. */
export type ContractState = JsonObject

/**
 * 24 hourly Routine blocks per security category (T2.6, PRD 5.7).
 *
 * Keys are security category ids; each value is length 24.
 */
export type RoutineState = {
  readonly [categoryId: string]: readonly string[]
}

/** T4.3 replaces this when Standing Orders land. */
export type StandingOrdersState = JsonObject

/** T4.1 replaces this when staff posts land. */
export type PostState = JsonObject

/** T3.1 replaces this when the event log lands. */
export interface LogEntry extends JsonObject {
  /** The tick the entry was recorded on. */
  readonly tick: number
}

/**
 * `RngState` as plain JSON, assignable in both directions.
 *
 * It is restated here rather than reused because an interface has no implicit
 * index signature, so `RngState` is not assignable to `JsonValue` even though
 * every value of it is JSON. Keep the two in step: the RNG must restore
 * exactly or a loaded run diverges from the one that was saved.
 */
export type SerialisedRngState = {
  readonly seed: number
  readonly streams: readonly {
    readonly name: string
    /** The stream's mulberry32 internal state. */
    readonly state: number
  }[]
}

/**
 * One save, exactly as PRD 7.4 specifies it.
 *
 * It extends `JsonObject` on purpose: a `SaveFile` is required to be plain
 * JSON with no cycles and no class instances, and the migration chain works on
 * `JsonObject` because a save being migrated is, by definition, not yet a
 * `SaveFile` of the current version.
 */
export interface SaveFile extends JsonObject {
  /** Integer, bumped on any breaking change to this shape. */
  readonly version: number
  readonly seed: number
  /** ISO 8601, supplied by the caller: sim code may not read the wall clock. */
  readonly createdAt: string
  readonly playedTicks: number
  readonly mapSize: number
  readonly settings: MapSettings
  readonly grid: SerialisedGrid
  readonly entities: readonly SerialisedEntity[]
  readonly rooms: readonly SerialisedRoom[]
  readonly sectors: readonly SerialisedSector[]
  readonly economy: EconomyState
  readonly directorate: DirectorateState
  readonly contracts: readonly ContractState[]
  readonly routines: RoutineState
  readonly standingOrders: StandingOrdersState
  readonly posts: readonly PostState[]
  /** Capped at `MAX_SAVED_LOG_ENTRIES`, newest kept. */
  readonly log: readonly LogEntry[]
  readonly rngState: SerialisedRngState
}

/**
 * What a reader can learn from the header alone, before it commits to
 * decompressing anything. The store uses it to list saves cheaply.
 */
export interface SaveHeader {
  readonly containerVersion: number
  readonly schemaVersion: number
  readonly payloadBytes: number
  readonly payloadChecksum: number
}
