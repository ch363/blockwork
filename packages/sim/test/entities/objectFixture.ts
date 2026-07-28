/**
 * Shared scaffolding for the T1.4 tests.
 *
 * As with T1.2 and T1.3, everything runs against the **real** content files,
 * so an `objects.json` edit that breaks placement breaks these tests. The one
 * fabricated thing is `withObjectDef`, which patches a single definition for
 * the cases real content has no example of — `requiresRoom` is opt-in and
 * nothing sets it today, which is exactly why it needs a fixture rather than a
 * data edit.
 *
 * Structure is written straight into the grid rather than queued through
 * construction, for the same reason T1.3 does it: placement does not care how
 * a wall got there, and routing a fixture through the build queue would spend
 * the test on T1.2's code path.
 */

import { isJsonArray } from '../../src/core/commands'
import { Simulation } from '../../src/core/simulation'
import type { EventSink, SimulationEvent } from '../../src/core/simulation'
import { Registry, loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import type { ObjectDef } from '../../src/data/schemas'
import { createObjectWorld, objectCommandHandlers } from '../../src/entities/objects'
import type { ObjectDeps, ObjectWorld } from '../../src/entities/objects'
import { createConstructionSystem, uniformWorkforce } from '../../src/systems/constructionSystem'
import { createObjectSystem } from '../../src/systems/objectSystem'
import { constructionCommandHandlers, refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom, roomCommandHandlers } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'

/** Loaded once: content validation is not what these tests are measuring. */
const RAW_DATA = loadGameData()

/** Construction stub on: object fixtures write structure without logistics. */
export const DATA: GameData = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    construction: { ...RAW_DATA.balance.construction, stubMaterialDelivery: true },
    // Object / room tests assume free supply unless they opt into utilities.
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}

export const WALL_MATERIAL = 'brick_wall'
export const FLOOR_MATERIAL = DATA.balance.construction.foundationFloorMaterial

export class RecordingSink implements EventSink {
  readonly events: SimulationEvent[] = []

  emit(event: SimulationEvent): void {
    this.events.push(event)
  }

  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }

  /** The `reason` field of every rejection recorded so far. */
  reasons(): string[] {
    return this.of('objects.rejected').map((event) => {
      const data = event.data
      if (data === null || typeof data !== 'object' || isJsonArray(data)) return '<malformed>'
      return String(data['reason'])
    })
  }

  clear(): void {
    this.events.length = 0
  }
}

export interface ScenarioOptions {
  readonly size?: number
  readonly seed?: number
  readonly data?: GameData
}

export interface Scenario {
  readonly sim: Simulation
  readonly world: ObjectWorld
  readonly data: GameData
  readonly events: RecordingSink
  objectDeps(): ObjectDeps
  roomDeps(): RoomDeps
}

/**
 * A world of open ground with objects, rooms and construction wired into a
 * real `Simulation`, so the tests exercise the same path the worker does.
 */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const size = options.size ?? 24
  const data = options.data ?? DATA
  const events = new RecordingSink()

  const world = createObjectWorld(size, data)
  const sim = new Simulation({
    seed: options.seed ?? 0xb10c_1004,
    world,
    systems: [
      createConstructionSystem({ data, workforce: uniformWorkforce(1) }),
      createObjectSystem({ data }),
    ],
    commandHandlers: {
      ...constructionCommandHandlers(data),
      ...roomCommandHandlers(data),
      ...objectCommandHandlers(data),
    },
    events,
  })

  return {
    sim,
    world,
    data,
    events,
    objectDeps(): ObjectDeps {
      return { world, data, events, tick: sim.tick }
    },
    roomDeps(): RoomDeps {
      return { world, data, events, tick: sim.tick }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Content patching                                                            */
/* -------------------------------------------------------------------------- */

/** The same content with one object definition overridden. */
export function withObjectDef(objectId: string, patch: Partial<ObjectDef>): GameData {
  const patched = DATA.objects.all.map((def) => (def.id === objectId ? { ...def, ...patch } : def))
  return { ...DATA, objects: new Registry(patched) }
}

/** The same content with the utility grids switched on. */
export function withUtilities(enabled: boolean): GameData {
  return {
    ...DATA,
    balance: {
      ...DATA.balance,
      utilities: { ...DATA.balance.utilities, utilitiesEnabled: enabled },
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Direct structure writes                                                     */
/* -------------------------------------------------------------------------- */

export function putFloor(run: Scenario, x: number, y: number): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('floorMaterial', index, run.world.materials.indexOf(FLOOR_MATERIAL))
  run.world.grid.setAt('outdoors', index, 0)
  refreshPassability(run.world, run.data, index)
  run.world.structureChanged(index)
  return index
}

export function putWall(run: Scenario, x: number, y: number): number {
  const index = putFloor(run, x, y)
  run.world.grid.setAt('wallMaterial', index, run.world.materials.indexOf(WALL_MATERIAL))
  refreshPassability(run.world, run.data, index)
  run.world.structureChanged(index)
  return index
}

export function putDoor(run: Scenario, x: number, y: number): number {
  const index = putFloor(run, x, y)
  run.world.grid.setAt('wallMaterial', index, 0)
  run.world.doors.place(index, 'standard', initialLockState(run.data.doors.get('standard')))
  refreshPassability(run.world, run.data, index)
  run.world.structureChanged(index)
  return index
}

/**
 * A walled, floored, indoor box: perimeter walls on the rectangle's edge and
 * floor throughout, which is what `enclosed` and `indoors` need.
 */
export function putRoomShell(run: Scenario, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) putWall(run, x, y)
      else putFloor(run, x, y)
    }
  }
}

/** The interior of a shell built by `putRoomShell`. */
export function interiorOf(rect: Rect): Rect {
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
}

/**
 * Builds a shell, designates its interior and returns the detected room id.
 * Throws rather than returning zero: a fixture that failed to make a room
 * would fail every assertion downstream with a less useful message.
 */
export function makeRoom(run: Scenario, shell: Rect, roomDefId: string): number {
  putRoomShell(run, shell)
  const interior = interiorOf(shell)
  designateRoom(run.roomDeps(), interior, roomDefId)

  const roomId = run.world.grid.get('roomId', interior.x, interior.y)
  if (roomId === 0)
    throw new Error(`no ${roomDefId} was detected at (${interior.x}, ${interior.y})`)
  return roomId
}
