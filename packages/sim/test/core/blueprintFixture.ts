/**
 * Scaffolding for the T1.5 tests.
 *
 * Built on T1.4's `objectFixture` so that `putWall`, `makeRoom` and friends
 * keep working: `BlueprintScenario` extends `Scenario` structurally, and the
 * only thing it adds is a `Simulation` that also knows the two blueprint
 * commands. Everything runs against the real content files, as the earlier
 * tickets' tests do.
 *
 * The one piece of real machinery here is `structure()`, and it is worth
 * reading before the tests that lean on it.
 */

import { Fnv1aHasher } from '../../src/core/hash'
import { Simulation } from '../../src/core/simulation'
import { blueprintCommandHandlers } from '../../src/core/undo'
import type { CommitLedger } from '../../src/core/undo'
import type { BuildAction, BuildDeps } from '../../src/core/blueprint'
import { commitCommand, redoCommand, undoCommand } from '../../src/core/blueprint'
import type { GameData } from '../../src/data/loader'
import { createObjectWorld, objectCommandHandlers } from '../../src/entities/objects'
import type { ObjectDeps, ObjectWorld } from '../../src/entities/objects'
import { createConstructionSystem, uniformWorkforce } from '../../src/systems/constructionSystem'
import { createObjectSystem } from '../../src/systems/objectSystem'
import { constructionCommandHandlers } from '../../src/world/construction'
import { tileCount } from '../../src/world/coords'
import { roomCommandHandlers, updateStaleRooms } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { DATA, RecordingSink } from '../entities/objectFixture'
import type { Scenario } from '../entities/objectFixture'

export { DATA, FLOOR_MATERIAL, WALL_MATERIAL } from '../entities/objectFixture'
export {
  interiorOf,
  makeRoom,
  putDoor,
  putFloor,
  putRoomShell,
  putWall,
} from '../entities/objectFixture'

export interface BlueprintScenario extends Scenario {
  readonly world: ObjectWorld
  /** The worker-side undo history the handlers write to. */
  readonly ledger: CommitLedger
  buildDeps(): BuildDeps
  /** Sends a commit and runs the tick that applies it. */
  commit(actions: readonly BuildAction[]): void
  /** Sends an undo and runs the tick that applies it. */
  undo(): void
  /** Sends a redo and runs the tick that applies it. */
  redo(): void
}

export interface BlueprintScenarioOptions {
  readonly size?: number
  readonly seed?: number
  readonly data?: GameData
  /** Builders per tick. Zero freezes every site at nought progress. */
  readonly workers?: number
}

export function scenario(options: BlueprintScenarioOptions = {}): BlueprintScenario {
  const size = options.size ?? 32
  const data = options.data ?? DATA
  const events = new RecordingSink()

  const world = createObjectWorld(size, data)
  const blueprint = blueprintCommandHandlers(data)

  const sim = new Simulation({
    seed: options.seed ?? 0xb10c_1005,
    world,
    systems: [
      createConstructionSystem({ data, workforce: uniformWorkforce(options.workers ?? 0) }),
      createObjectSystem({ data }),
    ],
    commandHandlers: {
      ...constructionCommandHandlers(data),
      ...roomCommandHandlers(data),
      ...objectCommandHandlers(data),
      ...blueprint.handlers,
    },
    events,
  })

  const run: BlueprintScenario = {
    sim,
    world,
    data,
    events,
    ledger: blueprint.ledger,
    objectDeps(): ObjectDeps {
      return { world, data, events, tick: sim.tick }
    },
    roomDeps(): RoomDeps {
      return { world, data, events, tick: sim.tick }
    },
    buildDeps(): BuildDeps {
      return { world, data, events, tick: sim.tick }
    },
    commit(actions: readonly BuildAction[]): void {
      sim.enqueue(commitCommand(actions, sim.tick))
      sim.step()
    },
    undo(): void {
      sim.enqueue(undoCommand(sim.tick))
      sim.step()
    },
    redo(): void {
      sim.enqueue(redoCommand(sim.tick))
      sim.step()
    },
  }

  return run
}

/**
 * Runs the simulation until every queued site is finished, then re-grades the
 * rooms the new structure invalidated.
 *
 * The `updateStaleRooms` call is not ceremony. T1.3 made room re-detection a
 * function the caller drives and no ticket has yet added the system that
 * drives it, so `roomDetection`'s own tests call it by hand too. Without it a
 * wall finished by the construction system leaves its room still marked
 * unenclosed, and every test downstream would be measuring that gap instead of
 * the thing it meant to measure.
 *
 * Throws rather than returning quietly, because a test that continued with
 * half a prison built would fail later for the wrong reason.
 */
export function buildOut(run: BlueprintScenario, maxTicks = 2000): number {
  for (let ticks = 1; ticks <= maxTicks; ticks += 1) {
    run.sim.step()
    if ([...run.world.sites.all()].length > 0) continue

    updateStaleRooms(run.roomDeps())
    return ticks
  }

  throw new Error(
    `construction did not finish within ${String(maxTicks)} ticks; ` +
      `${String([...run.world.sites.all()].length)} sites remain`,
  )
}

/* -------------------------------------------------------------------------- */
/* Fingerprints                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A fingerprint of the world's **physical state**, and deliberately not of
 * `world.hashInto`.
 *
 * The determinism hash includes three things that undo is not supposed to put
 * back, and should not be asked to.
 *
 * *Id counters.* `RoomRegistry`, `ObjectRegistry` and `ConstructionQueue` each
 * hand out ids from a monotonic counter. Rewinding one so that a later
 * placement reuses a retired id is how dangling references get created, so
 * undo leaves them where they are. A prison with the same objects in the same
 * places, numbered from 21 instead of from 1, is the same prison.
 *
 * *The money tallies.* `refundsOwed` and `spendOwed` are an outbox for the
 * economy of T3.6, not state of the world. A commit followed by an undo
 * correctly leaves a spend and an offsetting refund waiting to be drained; the
 * refund tests assert on exactly those numbers, so folding them in here would
 * only make this function fail for the reason another test is checking.
 *
 * What is left is every fact the player can see: the grid, the doors, the
 * pending sites' work and cost, which tiles are designated as what, and which
 * object stands where. Two worlds agreeing on this are indistinguishable.
 */
export function structure(world: ObjectWorld): number {
  const hasher = new Fnv1aHasher()
  const grid = world.grid
  const tiles = tileCount(grid.size)

  for (let index = 0; index < tiles; index += 1) {
    hasher.writeUint32(grid.getAt('floorMaterial', index))
    hasher.writeUint32(grid.getAt('wallMaterial', index))
    hasher.writeUint32(grid.getAt('passability', index))
    hasher.writeUint32(grid.getAt('outdoors', index))
    hasher.writeString(world.rooms.designationIdAt(index) ?? '')

    const door = world.doors.get(index)
    hasher.writeString(door?.type ?? '')
    hasher.writeBoolean(door?.locked ?? false)
  }

  // Sites and objects by position rather than by id, sorted so that two runs
  // that built the same thing in a different order still agree.
  const sites = [...world.sites.all()].sort((a, b) => a.tileIndex - b.tileIndex)
  hasher.writeUint32(sites.length)
  for (const site of sites) {
    hasher.writeUint32(site.tileIndex)
    hasher.writeString(site.job.kind)
    hasher.writeUint32(site.cost)
    hasher.writeUint32(site.workTicksDone)
    hasher.writeUint32(site.workTicksRequired)
  }

  const objects = [...world.objects.all()].sort((a, b) => a.tileIndex - b.tileIndex)
  hasher.writeUint32(objects.length)
  for (const entity of objects) {
    hasher.writeUint32(entity.tileIndex)
    hasher.writeString(entity.object.defId)
    hasher.writeUint32(entity.object.rotation)
  }

  return hasher.digest()
}

/** Rooms, keyed by what they are and where, ignoring the ids they were given. */
export function roomShapes(world: ObjectWorld): string[] {
  return [...world.rooms.all()]
    .map((room) => `${room.defId}@${String(room.bounds.x)},${String(room.bounds.y)}`)
    .sort()
}
