/**
 * `SaveState`: the live counterpart of a `SaveFile`.
 *
 * A `SaveFile` is JSON — base64 grids, plain objects, no classes. A
 * `SaveState` is the same information in the form the simulation actually runs
 * on, which today means a real `TileGrid` and, for the systems that do not
 * exist yet, the same opaque JSON records the file carries. `serialise.ts`
 * turns one into the other and `deserialise.ts` turns it back.
 *
 * The hashing here is what makes "the save round-tripped" a testable claim
 * rather than a hopeful one. `saveStateWorld` wraps a state as the
 * simulation's `World`, so a loaded prison can be handed straight to
 * `new Simulation({ world })` and compared against the one it was saved from
 * with `Simulation.hash()`. `hashSaveState` covers the whole state including
 * the parts the `Simulation` owns rather than the world — the seed, the tick
 * count and the RNG streams — for asserting on a save in isolation.
 *
 * Both walk the state in a fixed order and hash the opaque records
 * canonically (`Fnv1aHasher.writeJson` sorts object keys), so two states that
 * differ only in key insertion order, which JSON round-tripping can easily
 * produce, still agree.
 */

import { Fnv1aHasher } from '../core/hash'
import type { RngState } from '../core/rng'
import type { World } from '../core/simulation'
import type { TileGrid } from '../world/tileGrid'

import type {
  ContractState,
  DirectorateState,
  EconomyState,
  LogEntry,
  MapSettings,
  PostState,
  RoutineState,
  SerialisedEntity,
  SerialisedRoom,
  SerialisedSector,
  StandingOrdersState,
} from './format'

/** Everything one saved prison consists of, in memory. */
export interface SaveState {
  readonly seed: number
  /** Ticks elapsed. Restored into the clock by whoever boots the simulation. */
  readonly playedTicks: number
  readonly settings: MapSettings
  readonly grid: TileGrid
  readonly entities: readonly SerialisedEntity[]
  readonly rooms: readonly SerialisedRoom[]
  readonly sectors: readonly SerialisedSector[]
  readonly economy: EconomyState
  readonly directorate: DirectorateState
  readonly contracts: readonly ContractState[]
  readonly routines: RoutineState
  readonly standingOrders: StandingOrdersState
  readonly posts: readonly PostState[]
  readonly log: readonly LogEntry[]
  readonly rngState: RngState
}

/**
 * The world content of a state: the grid and everything that lives on it.
 *
 * Excludes the seed, the tick count and the RNG state because `Simulation`
 * hashes those itself; including them here would fold them into the
 * fingerprint twice.
 */
function hashWorldInto(state: SaveState, hasher: Fnv1aHasher): void {
  state.grid.hashInto(hasher)

  hasher.writeJson(state.settings)

  hasher.writeUint32(state.entities.length)
  for (const entity of state.entities) hasher.writeJson(entity)

  hasher.writeUint32(state.rooms.length)
  for (const room of state.rooms) hasher.writeJson(room)

  hasher.writeUint32(state.sectors.length)
  for (const sector of state.sectors) hasher.writeJson(sector)

  hasher.writeJson(state.economy)
  hasher.writeJson(state.directorate)

  hasher.writeUint32(state.contracts.length)
  for (const contract of state.contracts) hasher.writeJson(contract)

  hasher.writeJson(state.routines)
  hasher.writeJson(state.standingOrders)

  hasher.writeUint32(state.posts.length)
  for (const post of state.posts) hasher.writeJson(post)

  hasher.writeUint32(state.log.length)
  for (const entry of state.log) hasher.writeJson(entry)
}

function hashRngInto(rngState: RngState, hasher: Fnv1aHasher): void {
  hasher.writeUint32(rngState.seed)
  hasher.writeUint32(rngState.streams.length)
  for (const stream of rngState.streams) {
    hasher.writeString(stream.name)
    hasher.writeUint32(stream.state)
  }
}

/**
 * Views a state as the simulation's `World`, so a loaded save can be booted
 * and fingerprinted against the run it came from.
 *
 * A view, not a copy: the returned world reads through to `state`.
 */
export function saveStateWorld(state: SaveState): World {
  return {
    hashInto(hasher: Fnv1aHasher): void {
      hashWorldInto(state, hasher)
    },
  }
}

/** A fingerprint of the entire state, including seed, tick count and RNG. */
export function hashSaveState(state: SaveState): number {
  const hasher = new Fnv1aHasher()
  hasher.writeUint32(state.seed)
  hasher.writeUint32(state.playedTicks)
  hashRngInto(state.rngState, hasher)
  hashWorldInto(state, hasher)
  return hasher.digest()
}
