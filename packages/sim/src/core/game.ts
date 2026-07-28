/**
 * The simulation's composition root: the one place that knows the whole game
 * is assembled from parts.
 *
 * Every piece below already existed and was tested in isolation — the world,
 * the registries, the command handlers, the systems. What did not exist was
 * anything that put them together, so the worker booted a `Simulation` with an
 * empty system list and no command handlers, and a `PlaceFoundation` command
 * that crossed the worker boundary was answered with `command.unhandled`.
 * This module is that missing assembly, and it is deliberately the only place
 * in `packages/sim` that names more than one subsystem at once.
 *
 * Two things here are load-bearing and should be changed only on purpose.
 *
 * **The system order is the determinism contract.** PRD 4.4 fixes it, and the
 * order below is that list restricted to the systems that exist: routine
 * (slot 2), job assignment then staff escorts (slot 3), navigation + pathing +
 * movement (slots 4–5), needs (slot 6), activity (slot 7), logistics — meals,
 * supply, deliveries (slot 8) — construction (slot 9), then rooms, objects,
 * and intake. Economy is PRD slot 16 (hourly); Contracts settle immediately
 * after so insolvency reveals land on the same hour tick. Contraband is PRD
 * slot 11 (Utilities slot 10 is not yet present). Rooms sit immediately
 * after construction because construction is what invalidates them — a wall
 * finished in slot 9 has to be reflected before anything grades the room it
 * just closed. Adding a system in the wrong place changes what the game does
 * from the same seed, so new entries go in their PRD slot, not at the end.
 *
 * **The grid may live in shared memory.** `TileGrid` is structure-of-arrays
 * over raw buffers, and `fromBuffers` takes an `ArrayBufferLike`, so when the
 * host is cross-origin isolated the whole world can be allocated over
 * `SharedArrayBuffer` and the renderer reads the very same bytes the
 * simulation writes. That is what makes tile rendering cost nothing per frame:
 * there is no tile data in the snapshot and never was, only the ids of the
 * chunks that changed. Where `SharedArrayBuffer` is unavailable the caller
 * allocates ordinary buffers instead and ships changed chunks itself; nothing
 * in this module changes between the two.
 */

import { MaterialTable } from '../world/materials'
import { TILE_FIELD_BYTES, TILE_FIELDS, TileGrid } from '../world/tileGrid'
import type { TileGridBuffers } from '../world/tileGrid'
import { assertGridSize, tileCount } from '../world/coords'
import { constructionCommandHandlers, refreshPassabilityRect } from '../world/construction'
import { RoomRegistry } from '../world/rooms'
import { detectAllRooms, roomCommandHandlers } from '../world/roomDetection'
import { ObjectRegistry, objectCommandHandlers } from '../entities/objects'
import { InmateRegistry } from '../entities/inmate'
import { createConstructionSystem } from '../systems/constructionSystem'
import type { Workforce } from '../systems/constructionSystem'
import { createNeedsSystem } from '../systems/needsSystem'
import { createActivitySystem } from '../systems/activitySystem'
import { createRoutineSystem, routineCommandHandlers } from '../systems/routineSystem'
import { createObjectSystem } from '../systems/objectSystem'
import { createRoomSystem } from '../systems/roomSystem'
import {
  createIntakePolicy,
  createIntakeSystem,
  InmateWorld,
  intakeCommandHandlers,
} from '../systems/intakeSystem'
import { createStaffSystem, staffCommandHandlers } from '../systems/staffSystem'
import { createPostSystem, postCommandHandlers } from '../systems/postSystem'
import { sectorCommandHandlers } from '../world/sectorCommands'
import {
  createStaffNeedsSystem,
  staffNeedsCommandHandlers,
} from '../systems/staffNeedsSystem'
import { createJobSystem } from '../systems/jobSystem'
import { createMealChainSystem } from '../systems/logistics/mealChain'
import { createSupplySystem } from '../systems/logistics/supply'
import { createDeliveriesSystem } from '../systems/logistics/deliveries'
import { createCleaningSystem } from '../systems/logistics/cleaning'
import { createLaundrySystem } from '../systems/logistics/laundry'
import { createNavigationSystem } from '../systems/navigationSystem'
import { createPathingSystem } from '../systems/pathingSystem'
import { createMovementSystem } from '../systems/movementSystem'
import { createCombatSystem } from '../systems/combatSystem'
import { createEconomySystem } from '../systems/economySystem'
import { createContractSystem, contractCommandHandlers } from '../systems/contractSystem'
import { createContrabandSystem } from '../systems/contrabandSystem'
import { createSearchSystem, searchCommandHandlers } from '../systems/searchSystem'
import { createMisconductSystem } from '../systems/misconductSystem'
import { createPunishmentSystem } from '../systems/punishmentSystem'
import type { GameData } from '../data/loader'

import { blueprintCommandHandlers } from './undo'
import type { CommitLedger } from './undo'
import { Simulation } from './simulation'
import type { EventSink, System } from './simulation'

/**
 * Allocates one buffer per tile field.
 *
 * `shared` asks for `SharedArrayBuffer`. It is a request, not a promise: a
 * host without cross-origin isolation does not expose the constructor at all,
 * and the caller finds out which it got by checking `buffers.floorMaterial`,
 * or more usefully by having decided the transport already.
 */
export function allocateTileGridBuffers(size: number, shared = false): TileGridBuffers {
  assertGridSize(size)
  const tiles = tileCount(size)

  const make = (bytes: number): ArrayBufferLike =>
    shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)

  return Object.fromEntries(
    TILE_FIELDS.map((field) => [field, make(tiles * TILE_FIELD_BYTES[field])]),
  ) as unknown as TileGridBuffers
}

export interface GameWorldOptions {
  readonly size: number
  readonly data: GameData
  /**
   * Buffers to build the grid over. Omit for a private grid; pass shared ones
   * to let the renderer read the world without a copy.
   */
  readonly buffers?: TileGridBuffers
}

/**
 * A fully derived, empty world of `size` tiles a side.
 *
 * The same job `createObjectWorld` does, minus its private allocation: the
 * grid is bare ground, outdoors everywhere, with passability derived rather
 * than assumed. Derived state is computed, never trusted — which is also what
 * makes this the correct entry point after a load (PRD 7.4).
 */
export function createGameWorld(options: GameWorldOptions): InmateWorld {
  const { size, data } = options

  const grid =
    options.buffers === undefined
      ? TileGrid.allocate(size)
      : TileGrid.fromBuffers(size, options.buffers)

  const world = new InmateWorld(
    grid,
    MaterialTable.from(data.materials.ids()),
    new RoomRegistry(size, data.rooms.ids()),
    new ObjectRegistry(),
    data,
    new InmateRegistry(),
    createIntakePolicy(data),
  )

  world.grid.fill('outdoors', 1)
  refreshPassabilityRect(world, data)
  // A fresh grid has nothing designated, so this is a no-op on a new game and
  // the rebuild path on a loaded one. Cheap either way, and it means callers
  // never have to remember which of the two they are.
  detectAllRooms({ world, data, events: nullSink, tick: 0 })
  world.sectors.reindex(data, world.grid)
  world.regions.rebuildAll(world.grid, world.doors, data, world.sectors)
  world.flowFields.refreshStandardGoals({
    grid: world.grid,
    objects: world.objects,
    rooms: world.rooms,
    materials: world.materials,
    data,
  })
  world.grid.markAllDirty()

  return world
}

/** Local to `createGameWorld`: the initial detection is not the player's news. */
const nullSink: EventSink = {
  emit(): void {
    // Intentionally empty.
  },
}

export interface GameOptions {
  readonly seed: number
  /** Tiles per axis. Map sizes are content (PRD 4.3), so the caller picks. */
  readonly mapSize: number
  readonly data: GameData
  readonly events?: EventSink
  /** Shared buffers for the grid, when the host can share memory. */
  readonly buffers?: TileGridBuffers
  /**
   * Who builds. Defaults to nobody, which is honest until Phase 2 brings
   * agents: a site with no worker stalls and says so rather than finishing by
   * magic. Hosts that want to exercise construction before then pass
   * `uniformWorkforce(n)`.
   */
  readonly workforce?: Workforce
}

export interface Game {
  readonly simulation: Simulation
  readonly world: InmateWorld
  readonly data: GameData
  /** Committed builds available to undo (PRD 3.3). Session state, not saved. */
  readonly ledger: CommitLedger
}

/**
 * Builds a playable simulation: world, systems and every command handler the
 * UI can send.
 */
export function createGame(options: GameOptions): Game {
  const { data } = options

  const world = createGameWorld({
    size: options.mapSize,
    data,
    ...(options.buffers === undefined ? {} : { buffers: options.buffers }),
  })

  const blueprint = blueprintCommandHandlers(data)

  // PRD 4.4 order, restricted to the systems that exist. New systems go in
  // their slot, not on the end. Routine is slot 2; job assignment is slot 3
  // (staff escorts share the slot until escorts migrate onto the job pool);
  // navigation feeds pathing/movement (slots 4–5); combat shares the every-tick
  // band with movement (slot 13); needs + staff needs are slot 6; activity is
  // slot 7; logistics (meals, supply, deliveries, cleaning, laundry) is slot 8;
  // construction is slot 9; Utilities (slot 10) not yet present; Contraband is
  // slot 11 after intake; search / misconduct / punishment are security (slot 12).
  // Supply runs before deliveries so new orders land in
  // the pending queue in time for the same-minute truck schedule check.
  const systems: readonly System[] = [
    createRoutineSystem({ data }),
    createJobSystem({ data }),
    createStaffSystem({ data }),
    createPostSystem({ data }),
    createNavigationSystem({ data }),
    createPathingSystem({ data }),
    createMovementSystem({ data }),
    createCombatSystem({ data }),
    createNeedsSystem({ data }),
    createStaffNeedsSystem({ data }),
    createActivitySystem({ data }),
    createMealChainSystem({ data }),
    createSupplySystem({ data }),
    createDeliveriesSystem({ data }),
    createCleaningSystem({ data }),
    createLaundrySystem({ data }),
    createConstructionSystem({
      data,
      ...(options.workforce === undefined ? {} : { workforce: options.workforce }),
    }),
    createRoomSystem({ data }),
    createObjectSystem({ data }),
    createIntakeSystem({ data }),
    createContrabandSystem({ data }),
    // Security slot (PRD 4.4 #12): search / detection, misconduct, punishment.
    createSearchSystem({ data }),
    createMisconductSystem({ data }),
    createPunishmentSystem({ data }),
    createEconomySystem({ data }),
    createContractSystem({ data }),
  ]

  const simulation = new Simulation({
    seed: options.seed,
    world,
    systems,
    commandHandlers: {
      ...constructionCommandHandlers(data),
      ...roomCommandHandlers(data),
      ...objectCommandHandlers(data),
      ...blueprint.handlers,
      ...intakeCommandHandlers(data),
      ...routineCommandHandlers(data),
      ...staffCommandHandlers(data),
      ...staffNeedsCommandHandlers(data),
      ...contractCommandHandlers(data),
      ...sectorCommandHandlers(data),
      ...postCommandHandlers(data),
      ...searchCommandHandlers(data),
    },
    ...(options.events === undefined ? {} : { events: options.events }),
  })

  return { simulation, world, data, ledger: blueprint.ledger }
}
