/**
 * Writing a save (PRD 7.4).
 *
 * Two steps, kept apart on purpose:
 *
 *   1. `toSaveFile` turns a live `SaveState` into the JSON `SaveFile`. Pure,
 *      synchronous, and the only place that knows how a `TileGrid` becomes
 *      base64.
 *   2. `encodeSaveFile` turns that object into the bytes of a `.blockwork`
 *      file: a fixed header, then gzipped UTF-8 JSON.
 *
 * Migrations only ever see the output of step 1, so they never have to think
 * about compression, and the autosave path can hash or inspect a save without
 * paying for gzip.
 *
 * **No wall clock.** `createdAt` is a parameter. Sim code may not read the
 * time (CLAUDE.md rule 3, and lint enforces it), and a timestamp baked in by
 * the simulation would also make an otherwise deterministic save differ
 * between two identical runs.
 */

import type { RngState } from '../core/rng'
import type { EventSink } from '../core/simulation'
import { nullEventSink } from '../core/simulation'
import { TILE_FIELDS, TILE_FIELD_BYTES } from '../world/tileGrid'
import type { TileField, TileGrid } from '../world/tileGrid'

import { bytesToBase64, checksumBytes, orientBytes, utf8Encode } from './bytes'
import {
  CURRENT_SAVE_VERSION,
  MAX_SAVED_LOG_ENTRIES,
  SAVE_CONTAINER_VERSION,
  SAVE_HEADER,
  SAVE_HEADER_BYTES,
  SAVE_MAGIC,
} from './format'
import type { SaveFile, SerialisedGrid, SerialisedRngState } from './format'
import { gzipBytes } from './gzip'
import type { SaveState } from './state'

export interface SaveOptions {
  /**
   * ISO 8601 timestamp for the file. The caller owns it because the
   * simulation may not read the wall clock.
   */
  readonly createdAt: string
  /** Where a truncated log is reported. Defaults to discarding the event. */
  readonly events?: EventSink
}

/**
 * Copies the RNG state into plain JSON. A copy rather than a reference so the
 * file cannot alias live simulation state, and so the streams are guaranteed
 * to be plain objects whatever produced them.
 */
function serialiseRngState(rngState: RngState): SerialisedRngState {
  return {
    seed: rngState.seed,
    streams: rngState.streams.map((stream) => ({ name: stream.name, state: stream.state })),
  }
}

/** Base64 of one tile array, in the format's little-endian byte order. */
function encodeField(grid: TileGrid, field: TileField): string {
  const view = grid.array(field)
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  return bytesToBase64(orientBytes(raw, TILE_FIELD_BYTES[field]))
}

/** The whole grid as base64, one string per parallel array. */
export function serialiseGrid(grid: TileGrid): SerialisedGrid {
  const encoded: Partial<Record<TileField, string>> = {}
  for (const field of TILE_FIELDS) {
    encoded[field] = encodeField(grid, field)
  }
  // Every key of TileField was just written, which the compiler cannot see
  // through a Partial built in a loop.
  return encoded as SerialisedGrid
}

/**
 * Builds the `SaveFile` for a state.
 *
 * The log is capped at `MAX_SAVED_LOG_ENTRIES`, keeping the newest. Dropping
 * player-visible history is exactly the kind of thing that should be
 * reconstructable later, so it emits a `CausalEvent` (CLAUDE.md rule 5) rather
 * than trimming quietly.
 */
export function toSaveFile(state: SaveState, options: SaveOptions): SaveFile {
  const events = options.events ?? nullEventSink

  let log = state.log
  if (log.length > MAX_SAVED_LOG_ENTRIES) {
    const dropped = log.length - MAX_SAVED_LOG_ENTRIES
    log = log.slice(dropped)
    events.emit({
      tick: state.playedTicks,
      kind: 'save.log.truncated',
      causeIds: [],
      data: { dropped, kept: MAX_SAVED_LOG_ENTRIES },
    })
  }

  return {
    version: CURRENT_SAVE_VERSION,
    seed: state.seed,
    createdAt: options.createdAt,
    playedTicks: state.playedTicks,
    mapSize: state.grid.size,
    settings: state.settings,
    grid: serialiseGrid(state.grid),
    entities: state.entities,
    rooms: state.rooms,
    nextRoomId: state.nextRoomId,
    sectors: state.sectors,
    economy: state.economy,
    directorate: state.directorate,
    grading: state.grading,
    programs: state.programs,
    grades: state.grades,
    parole: state.parole,
    release: state.release,
    intelligence: state.intelligence,
    contracts: state.contracts,
    routines: state.routines,
    standingOrders: state.standingOrders,
    posts: state.posts,
    contraband: state.contraband,
    fire: state.fire,
    riot: state.riot,
    emergency: state.emergency,
    escapes: state.escapes,
    combat: state.combat,
    punishments: state.punishments,
    utilities: state.utilities,
    dangerLevel: state.dangerLevel,
    riotActive: state.riotActive,
    lockdownActive: state.lockdownActive,
    misconductWindowTicks: state.misconductWindowTicks,
    log,
    rngState: serialiseRngState(state.rngState),
  }
}

/**
 * Serialises a `SaveFile` to the bytes of a `.blockwork` file.
 *
 * The header is plaintext so that a reader can check the magic number, refuse
 * a container it does not understand, and read the schema version out of a
 * multi-megabyte file without inflating any of it.
 */
export async function encodeSaveFile(file: SaveFile): Promise<Uint8Array> {
  const payload = utf8Encode(JSON.stringify(file))
  const compressed = await gzipBytes(payload)

  const bytes = new Uint8Array(SAVE_HEADER_BYTES + compressed.length)
  const header = new DataView(bytes.buffer, 0, SAVE_HEADER_BYTES)
  header.setUint32(SAVE_HEADER.MAGIC, SAVE_MAGIC, true)
  header.setUint32(SAVE_HEADER.CONTAINER_VERSION, SAVE_CONTAINER_VERSION, true)
  header.setUint32(SAVE_HEADER.SCHEMA_VERSION, file.version, true)
  header.setUint32(SAVE_HEADER.PAYLOAD_BYTES, payload.length, true)
  header.setUint32(SAVE_HEADER.PAYLOAD_CHECKSUM, checksumBytes(payload), true)
  bytes.set(compressed, SAVE_HEADER_BYTES)

  return bytes
}

/** `toSaveFile` then `encodeSaveFile`: the whole write path in one call. */
export async function saveToBytes(state: SaveState, options: SaveOptions): Promise<Uint8Array> {
  return encodeSaveFile(toSaveFile(state, options))
}
