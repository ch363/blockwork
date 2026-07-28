/**
 * Shared scaffolding for the T1.3 tests.
 *
 * As with T1.2, everything runs against the **real** content files, so a
 * `rooms.json` edit that breaks detection breaks these tests. Two things are
 * fabricated, and both are seams a later ticket fills rather than shortcuts:
 * the workforce (agents arrive in Phase 2) and the room contents (objects
 * arrive in T1.4, occupants in T2.4).
 *
 * `buildCellBlock` writes structure straight into the grid rather than queueing
 * it, the way T6.5's map generation will. Detection does not care how a wall
 * got there, and a 400-room fixture built through the construction queue would
 * spend its time on T1.2's code path rather than on this ticket's.
 */

import { Simulation } from '../../src/core/simulation'
import type { EventSink, SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { constructionCommandHandlers, refreshPassability } from '../../src/world/construction'
import type { ConstructionDeps, Rect } from '../../src/world/construction'
import { roomCommandHandlers } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { createRoomWorld } from '../../src/world/rooms'
import type { RoomContents, RoomWorld } from '../../src/world/rooms'
import { createConstructionSystem, uniformWorkforce } from '../../src/systems/constructionSystem'

/** Loaded once: content validation is not what these tests are measuring. */
const RAW_DATA = loadGameData()

/** Construction stub on: these fixtures build without a dock/store chain. */
export const DATA: GameData = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    construction: { ...RAW_DATA.balance.construction, stubMaterialDelivery: true },
  },
}

export const WALL_MATERIAL = 'brick_wall'
export const FENCE_MATERIAL = 'chain_fence'
export const FLOOR_MATERIAL = DATA.balance.construction.foundationFloorMaterial

/** The acceptance case's room type. */
export const CELL = 'cell'

export class RecordingSink implements EventSink {
  readonly events: SimulationEvent[] = []

  emit(event: SimulationEvent): void {
    this.events.push(event)
  }

  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }

  clear(): void {
    this.events.length = 0
  }
}

/**
 * What T1.4 and T2.4 will answer for real: how many of each object a room
 * holds, and how many heads are in it.
 */
export class FakeContents implements RoomContents {
  readonly #objects = new Map<string, number>()
  readonly #occupants = new Map<number, number>()

  put(roomId: number, objectId: string, count: number): this {
    this.#objects.set(`${roomId}:${objectId}`, count)
    return this
  }

  house(roomId: number, occupants: number): this {
    this.#occupants.set(roomId, occupants)
    return this
  }

  objectCount(roomId: number, objectId: string): number {
    return this.#objects.get(`${roomId}:${objectId}`) ?? 0
  }

  occupants(roomId: number): number {
    return this.#occupants.get(roomId) ?? 0
  }
}

export interface ScenarioOptions {
  readonly size?: number
  /** Builders standing on every tile. 0 leaves every construction site stalled. */
  readonly workers?: number
  readonly seed?: number
  readonly data?: GameData
  readonly contents?: RoomContents
  /** Discards events. For the perf case, where recording is the measurement. */
  readonly silent?: boolean
}

export interface Scenario {
  readonly sim: Simulation
  readonly world: RoomWorld
  readonly data: GameData
  readonly events: RecordingSink
  readonly contents: FakeContents
  roomDeps(): RoomDeps
  constructionDeps(): ConstructionDeps
  /** Steps until no construction is queued. Returns the steps taken. */
  runUntilIdle(limit?: number): number
}

/**
 * A world of open ground with rooms and construction wired into a real
 * `Simulation`, so the tests exercise the same path the worker does.
 */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const size = options.size ?? 24
  const data = options.data ?? DATA
  const events = new RecordingSink()
  const contents = options.contents instanceof FakeContents ? options.contents : new FakeContents()

  const world = createRoomWorld(size, data)
  const sim = new Simulation({
    seed: options.seed ?? 0xb10c_1003,
    world,
    systems: [
      createConstructionSystem({ data, workforce: uniformWorkforce(options.workers ?? 1) }),
    ],
    commandHandlers: { ...constructionCommandHandlers(data), ...roomCommandHandlers(data) },
    events: options.silent === true ? { emit: (): void => {} } : events,
  })

  const sink: EventSink = options.silent === true ? { emit: (): void => {} } : events

  return {
    sim,
    world,
    data,
    events,
    contents,
    roomDeps(): RoomDeps {
      return { world, data, events: sink, tick: sim.tick, contents }
    },
    constructionDeps(): ConstructionDeps {
      return { world, data, events: sink, tick: sim.tick }
    },
    runUntilIdle(limit = 4000): number {
      let steps = 0
      while (world.sites.size > 0 && steps < limit) {
        sim.step()
        steps += 1
      }
      return steps
    },
  }
}

/** Overridden content, for the tests that need a different balance value. */
export function withBalance(patch: { readonly enclosureFillLimit?: number }): GameData {
  return {
    ...DATA,
    balance: {
      ...DATA.balance,
      rooms: { ...DATA.balance.rooms, ...patch },
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Direct structure writes                                                     */
/* -------------------------------------------------------------------------- */

export function putWall(run: Scenario, x: number, y: number, materialId = WALL_MATERIAL): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('wallMaterial', index, run.world.materials.indexOf(materialId))
  run.world.grid.setAt('outdoors', index, 0)
  refreshPassability(run.world, run.data, index)
  return index
}

export function putFloor(run: Scenario, x: number, y: number, materialId = FLOOR_MATERIAL): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('floorMaterial', index, run.world.materials.indexOf(materialId))
  run.world.grid.setAt('outdoors', index, 0)
  refreshPassability(run.world, run.data, index)
  return index
}

/** A fenced or walled perimeter with nothing but open ground inside. */
export function putPerimeter(run: Scenario, rect: Rect, materialId: string): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (!onEdge) continue
      const index = run.world.grid.idx(x, y)
      run.world.grid.setAt('wallMaterial', index, run.world.materials.indexOf(materialId))
      refreshPassability(run.world, run.data, index)
    }
  }
}

/** Wall tiles sit every `CELL_PITCH` tiles, giving interiors of 3x3. */
export const CELL_PITCH = 4

export interface CellBlock {
  /** The whole slab, walls included. Designate this to get one room per interior. */
  readonly slab: Rect
  readonly columns: number
  readonly rows: number
  /** The wall tile separating room (`column`, `row`) from the one to its right. */
  sharedWall(column: number, row: number): number
  /** The top-left interior tile of a room. */
  interior(column: number, row: number): number
}

/**
 * A lattice of walls with floored interiors: `columns` x `rows` rooms sharing
 * their walls, exactly as a cell block is drawn.
 *
 * The whole slab is floored and indoors, and the caller designates the whole
 * slab in one go. The walls do the partitioning, which is the point: knocking
 * one out merges the two rooms either side of it.
 */
export function buildCellBlock(run: Scenario, columns: number, rows: number): CellBlock {
  const span = { width: columns * CELL_PITCH + 1, height: rows * CELL_PITCH + 1 }

  for (let y = 0; y < span.height; y += 1) {
    for (let x = 0; x < span.width; x += 1) {
      if (x % CELL_PITCH === 0 || y % CELL_PITCH === 0) {
        putFloor(run, x, y)
        putWall(run, x, y)
      } else {
        putFloor(run, x, y)
      }
    }
  }

  return {
    slab: { x: 0, y: 0, ...span },
    columns,
    rows,
    sharedWall(column: number, row: number): number {
      return run.world.grid.idx((column + 1) * CELL_PITCH, row * CELL_PITCH + 1)
    },
    interior(column: number, row: number): number {
      return run.world.grid.idx(column * CELL_PITCH + 1, row * CELL_PITCH + 1)
    },
  }
}
