/**
 * Shared scaffolding for the T1.2 tests.
 *
 * Everything runs against the **real** content files, so a balance edit that
 * breaks construction breaks these tests rather than passing against a fixture
 * that has drifted. The one thing the tests fabricate is the workforce:
 * `uniformWorkforce(n)` stands in for staff on site until a test wires the job
 * pool explicitly.
 */

import { Simulation } from '../../src/core/simulation'
import type { EventSink, SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { constructionCommandHandlers, createConstructionWorld } from '../../src/world/construction'
import type { ConstructionDeps, ConstructionWorld, Rect, Tile } from '../../src/world/construction'
import { createConstructionSystem, uniformWorkforce } from '../../src/systems/constructionSystem'
import { PASSABILITY } from '../../src/world/tileGrid'

/** Loaded once: validation is not what these tests are measuring. */
const RAW_DATA = loadGameData()

/** Isolated construction tests keep the T1.2 material stub; T3.4 owns real delivery. */
export const DATA: GameData = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    construction: { ...RAW_DATA.balance.construction, stubMaterialDelivery: true },
  },
}

export const WALL_MATERIAL = 'brick_wall'
export const FLOOR_MATERIAL = 'ceramic_tile'
/** What a foundation lays inside its walls. */
export const FOUNDATION_FLOOR = DATA.balance.construction.foundationFloorMaterial

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

export interface ScenarioOptions {
  readonly size?: number
  /** Builders standing on every tile. 0 leaves every site stalled. */
  readonly workers?: number
  readonly seed?: number
  /** Overridden content, for tests that need a different balance value. */
  readonly data?: GameData
}

export interface Scenario {
  readonly sim: Simulation
  readonly world: ConstructionWorld
  readonly data: GameData
  readonly events: RecordingSink
  /** Dependencies for calling the construction functions directly. */
  deps(): ConstructionDeps
  /** Steps until nothing is queued. Returns the steps taken. */
  runUntilIdle(limit?: number): number
}

/**
 * A world of open ground with the construction system wired into a real
 * `Simulation`, so the tests exercise the same path the worker does.
 */
export function scenario(options: ScenarioOptions = {}): Scenario {
  const size = options.size ?? 24
  const workers = options.workers ?? 1
  const data = options.data ?? DATA

  const world = createConstructionWorld(size, data)
  const events = new RecordingSink()
  const sim = new Simulation({
    seed: options.seed ?? 0xb10c_1002,
    world,
    systems: [createConstructionSystem({ data, workforce: uniformWorkforce(workers) })],
    commandHandlers: constructionCommandHandlers(data),
    events,
  })

  return {
    sim,
    world,
    data,
    events,
    deps(): ConstructionDeps {
      return { world, data, events, tick: sim.tick }
    },
    runUntilIdle(limit = 2000): number {
      let steps = 0
      while (world.sites.size > 0 && steps < limit) {
        sim.step()
        steps += 1
      }
      return steps
    },
  }
}

/** Tile indices reachable on foot from a tile, four-connected. */
export function walkableFrom(world: ConstructionWorld, start: Tile): Set<number> {
  const grid = world.grid
  const seen = new Set<number>()
  const startIndex = grid.idx(start.x, start.y)
  if ((grid.getAt('passability', startIndex) & PASSABILITY.WALKABLE) === 0) return seen

  const frontier = [startIndex]
  seen.add(startIndex)

  while (frontier.length > 0) {
    const index = frontier.pop()
    if (index === undefined) break
    const { x, y } = grid.xy(index)
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (!grid.inBounds(nx, ny)) continue
      const next = grid.idx(nx, ny)
      if (seen.has(next)) continue
      if ((grid.getAt('passability', next) & PASSABILITY.WALKABLE) === 0) continue
      seen.add(next)
      frontier.push(next)
    }
  }

  return seen
}

/** Every tile index inside a rectangle's perimeter. */
export function interiorTiles(world: ConstructionWorld, rect: Rect): number[] {
  const tiles: number[] = []
  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y += 1) {
    for (let x = rect.x + 1; x < rect.x + rect.width - 1; x += 1) {
      tiles.push(world.grid.idx(x, y))
    }
  }
  return tiles
}

/** Every tile index on a rectangle's perimeter. */
export function perimeterTiles(world: ConstructionWorld, rect: Rect): number[] {
  const tiles: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) tiles.push(world.grid.idx(x, y))
    }
  }
  return tiles
}
