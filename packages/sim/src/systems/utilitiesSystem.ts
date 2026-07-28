/**
 * `UtilitiesSystem`: power, water and temperature (T5.5, PRD 5.12).
 *
 * Slot 10 in the PRD 4.4 order — before Contraband, immediately ahead of
 * `ObjectSystem`, which re-reads `hasPower` / `hasWater` from the grids this
 * pass writes.
 *
 * Power: cables (+ conductive object footprints) form connected components.
 * Capacity is the sum of `outputWatts` sources; demand is connected
 * `needsPower`. When demand exceeds capacity, lowest-priority loads are shed
 * per `balance.utilities.sheddingPriority` — never a total trip of the live
 * remainder. Shed branches emit `utilities.brownout` and are marked on
 * `FireGrid` for electrical ignition.
 *
 * Water: pipes form components; pumps contribute `flowRate`. Insufficient flow
 * lowers a per-branch use multiplier rather than cutting supply.
 *
 * Temperature: heat sources warm their tiles; a diffusion pass every
 * `temperatureDiffusionTicks` spreads heat; outdoor tiles follow a day cycle
 * from `outdoorTemperatureC`.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { ObjectDef, PowerPriority } from '../data/schemas'
import { NO_UTILITY_GRID } from '../entities/objects'
import type { ObjectEntity } from '../entities/objects'
import { TRACE_KINDS } from '../trace/causalEvent'
import type { Tile } from '../world/construction'
import { PowerGrid } from '../world/powerGrid'
import type { TileGrid } from '../world/tileGrid'
import { WaterGrid } from '../world/waterGrid'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const UTILITIES_SYSTEM_NAME = 'utilities'

/** PRD 4.4: Utilities runs once an in-game minute. */
export const UTILITIES_SYSTEM_PERIOD = TICKS_PER_MINUTE

export const UTILITIES_EVENTS = {
  brownout: TRACE_KINDS.utilitiesBrownout,
  rejected: 'utilities.rejected',
} as const

const CARDINAL = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
] as const

const DEFAULT_POWER_PRIORITY: PowerPriority = 'comfort'

/* -------------------------------------------------------------------------- */
/* Options / factory                                                           */
/* -------------------------------------------------------------------------- */

export interface UtilitiesSystemOptions {
  readonly data: GameData
}

export function createUtilitiesSystem(options: UtilitiesSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: UTILITIES_SYSTEM_NAME,
    period: UTILITIES_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: UTILITIES_EVENTS.rejected,
          causeIds: [],
          data: { command: UTILITIES_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      if (!data.balance.utilities.utilitiesEnabled) return

      rebuildPower(world, data, context.events, tick)
      rebuildWater(world, data)
      updateTemperature(world, data, tick)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Power                                                                       */
/* -------------------------------------------------------------------------- */

interface PowerLoad {
  readonly entity: ObjectEntity
  readonly def: ObjectDef
  readonly watts: number
  readonly priority: PowerPriority
  readonly tiles: readonly number[]
}

interface PowerSource {
  readonly entity: ObjectEntity
  readonly watts: number
  readonly tiles: readonly number[]
}

function rebuildPower(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const grid = world.grid
  const power = world.power
  const fire = world.fire

  // Clear previous shed marks on the fire grid for branches we owned.
  for (const branchId of power.shedBranches) {
    fire.clearBranchOverload(branchId)
  }
  power.clearShedBranches()

  const conductive = markPowerConductive(world, data)
  const components = connectedComponents(grid.size, conductive)
  const powerIds = grid.powerGridId
  powerIds.fill(0)

  let nextBranchId = 1
  const sheddingOrder = data.balance.utilities.sheddingPriority

  for (const tiles of components) {
    if (tiles.length === 0) continue

    const tileSet = new Set(tiles)
    const sources: PowerSource[] = []
    const loads: PowerLoad[] = []

    for (const entity of world.objects.all()) {
      const def = data.objects.find(entity.object.defId)
      if (def === undefined) continue
      if (!entityTouches(entity, tileSet)) continue

      if (def.outputWatts > 0) {
        sources.push({ entity, watts: def.outputWatts, tiles: entity.object.tiles })
      }
      if (def.needsPower > 0) {
        loads.push({
          entity,
          def,
          watts: def.needsPower,
          priority: def.powerPriority ?? DEFAULT_POWER_PRIORITY,
          tiles: entity.object.tiles,
        })
      }
    }

    const capacity = sources.reduce((sum, source) => sum + source.watts, 0)
    const demand = loads.reduce((sum, load) => sum + load.watts, 0)

    // No source and no load: still label the cable so auto-route can find it,
    // but nothing is "live" for supply checks (loads need a source).
    if (sources.length === 0 && loads.length === 0) {
      const branchId = nextBranchId
      nextBranchId += 1
      if (branchId > 0xffff) break
      for (const tile of tiles) powerIds[tile] = branchId
      continue
    }

    if (capacity <= 0) {
      // Cables with loads but no generator: every load is dark. One shed branch
      // so electrical faults can still ignite overloaded dead legs.
      const branchId = nextBranchId
      nextBranchId += 1
      if (branchId > 0xffff) break
      for (const tile of tiles) powerIds[tile] = branchId
      power.markBranchShed(branchId)
      fire.markBranchOverloaded(branchId)
      if (demand > 0) {
        emitBrownout(events, tick, {
          branchId,
          demandWatts: demand,
          capacityWatts: 0,
          shortfallWatts: demand,
          priority: loads[0]?.priority ?? DEFAULT_POWER_PRIORITY,
        })
      }
      continue
    }

    const shedPriorities = new Set<PowerPriority>()
    let remaining = demand
    if (remaining > capacity) {
      for (const priority of sheddingOrder) {
        if (remaining <= capacity) break
        let group = 0
        for (const load of loads) {
          if (load.priority === priority) group += load.watts
        }
        if (group <= 0) continue
        shedPriorities.add(priority)
        remaining -= group
      }
    }

    const liveBranchId = nextBranchId
    nextBranchId += 1
    if (liveBranchId > 0xffff) break

    // Label the whole cable network with the live id first.
    for (const tile of tiles) powerIds[tile] = liveBranchId

    if (shedPriorities.size === 0) continue

    const shortfall = demand - capacity
    // One shed branch id per browned-out priority class so fire can target them.
    for (const priority of sheddingOrder) {
      if (!shedPriorities.has(priority)) continue
      const shedId = nextBranchId
      nextBranchId += 1
      if (shedId > 0xffff) break

      for (const load of loads) {
        if (load.priority !== priority) continue
        for (const tile of load.tiles) {
          if (tileSet.has(tile)) powerIds[tile] = shedId
        }
      }
      power.markBranchShed(shedId)
      fire.markBranchOverloaded(shedId)
      emitBrownout(events, tick, {
        branchId: shedId,
        demandWatts: demand,
        capacityWatts: capacity,
        shortfallWatts: shortfall,
        priority,
      })
    }
  }
}

function markPowerConductive(world: InmateWorld, data: GameData): Uint8Array {
  const size = world.grid.size
  const conductive = new Uint8Array(tileCountOf(size))
  for (let i = 0; i < conductive.length; i += 1) {
    if (world.power.hasCableAt(i)) conductive[i] = 1
  }
  for (const entity of world.objects.all()) {
    const def = data.objects.find(entity.object.defId)
    if (def === undefined) continue
    if (def.outputWatts <= 0 && def.needsPower <= 0) continue
    for (const tile of entity.object.tiles) {
      if (tile >= 0 && tile < conductive.length) conductive[tile] = 1
      // Ensure cable overlay matches so auto-route sees the node as live later.
      if (def.outputWatts > 0) world.power.setCable(tile, true)
    }
  }
  return conductive
}

function emitBrownout(
  events: EventSink,
  tick: number,
  data: {
    readonly branchId: number
    readonly demandWatts: number
    readonly capacityWatts: number
    readonly shortfallWatts: number
    readonly priority: PowerPriority
  },
): void {
  events.emit({
    tick,
    kind: UTILITIES_EVENTS.brownout,
    causeIds: [],
    data: {
      branchId: data.branchId,
      demandWatts: data.demandWatts,
      capacityWatts: data.capacityWatts,
      shortfallWatts: data.shortfallWatts,
      priority: data.priority,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Water                                                                       */
/* -------------------------------------------------------------------------- */

function rebuildWater(world: InmateWorld, data: GameData): void {
  const grid = world.grid
  const water = world.water
  water.clearMultipliers()

  const conductive = markWaterConductive(world, data)
  const components = connectedComponents(grid.size, conductive)
  const waterIds = grid.waterGridId
  waterIds.fill(0)

  let nextBranchId = 1
  const unitsPerFixture = data.balance.utilities.waterUnitsPerFixture

  for (const tiles of components) {
    if (tiles.length === 0) continue
    const tileSet = new Set(tiles)

    let flow = 0
    let fixtures = 0
    let hasPump = false

    for (const entity of world.objects.all()) {
      const def = data.objects.find(entity.object.defId)
      if (def === undefined) continue
      if (!entityTouches(entity, tileSet)) continue
      if (def.flowRate > 0) {
        flow += def.flowRate
        hasPump = true
      }
      if (def.needsWater) fixtures += 1
    }

    const branchId = nextBranchId
    nextBranchId += 1
    if (branchId > 0xffff) break

    for (const tile of tiles) waterIds[tile] = branchId

    if (!hasPump) {
      // Pipes without a pump: connected for routing, but use multiplier 0 so
      // fixtures on them still fail `hasWater` via suppliesWater (grid id set
      // but we treat no-pump as unsupplied — see suppliesWater).
      water.setUseMultiplier(branchId, 0)
      // Clear ids on fixture-only / pipe networks with no pump so hasWater is false.
      for (const tile of tiles) waterIds[tile] = NO_UTILITY_GRID
      continue
    }

    const demand = fixtures * unitsPerFixture
    const multiplier = demand <= 0 ? 1 : Math.min(1, flow / demand)
    water.setUseMultiplier(branchId, multiplier)
  }
}

function markWaterConductive(world: InmateWorld, data: GameData): Uint8Array {
  const size = world.grid.size
  const conductive = new Uint8Array(tileCountOf(size))
  for (let i = 0; i < conductive.length; i += 1) {
    if (world.water.hasPipeAt(i)) conductive[i] = 1
  }
  for (const entity of world.objects.all()) {
    const def = data.objects.find(entity.object.defId)
    if (def === undefined) continue
    if (def.flowRate <= 0 && !def.needsWater) continue
    for (const tile of entity.object.tiles) {
      if (tile >= 0 && tile < conductive.length) conductive[tile] = 1
      if (def.flowRate > 0) world.water.setPipe(tile, true)
    }
  }
  return conductive
}

/* -------------------------------------------------------------------------- */
/* Temperature                                                                 */
/* -------------------------------------------------------------------------- */

function updateTemperature(world: InmateWorld, data: GameData, tick: number): void {
  const utils = data.balance.utilities
  const grid = world.grid
  const period = utils.temperatureDiffusionTicks
  if (period <= 0 || tick % period !== 0) return

  const outdoor = outdoorTemperatureC(
    tick,
    utils.outdoorTemperatureC.min,
    utils.outdoorTemperatureC.max,
    utils.season,
  )
  const baseline = utils.indoorBaselineC
  const rate = utils.temperatureDiffusionRate
  const size = grid.size
  const temps = grid.temperature
  const next = new Int8Array(temps.length)

  // Seed from current, apply outdoor + heat sources.
  for (let i = 0; i < temps.length; i += 1) {
    if ((grid.outdoors[i] ?? 0) !== 0) {
      next[i] = clampTemp(outdoor)
      continue
    }
    let t = temps[i] ?? baseline
    // Fresh indoor tiles (still at typed-array zero) start at baseline.
    if (t === 0 && baseline !== 0) t = baseline
    t = t + (baseline - t) * rate
    next[i] = clampTemp(t)
  }

  for (const entity of world.objects.all()) {
    const def = data.objects.find(entity.object.defId)
    if (def === undefined || def.producesHeat === undefined || def.producesHeat <= 0) continue
    for (const tile of entity.object.tiles) {
      if (tile < 0 || tile >= next.length) continue
      if ((grid.outdoors[tile] ?? 0) !== 0) continue
      next[tile] = clampTemp((next[tile] ?? baseline) + def.producesHeat)
    }
  }

  // One diffusion pass: indoor tiles only exchange heat with indoor neighbours.
  const diffused = new Int8Array(next.length)
  for (let i = 0; i < next.length; i += 1) {
    if ((grid.outdoors[i] ?? 0) !== 0) {
      diffused[i] = next[i] ?? outdoor
      continue
    }
    const x = i % size
    const y = (i / size) | 0
    let sum = next[i] ?? baseline
    let count = 1
    for (const { dx, dy } of CARDINAL) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const ni = ny * size + nx
      if ((grid.outdoors[ni] ?? 0) !== 0) continue
      sum += next[ni] ?? baseline
      count += 1
    }
    const avg = sum / count
    const cur = next[i] ?? baseline
    diffused[i] = clampTemp(cur + (avg - cur) * rate)
  }

  for (let i = 0; i < temps.length; i += 1) {
    grid.setAt('temperature', i, diffused[i] ?? baseline)
  }
}

/**
 * Outdoor °C for the current tick: a daily cycle riding a seasonal one.
 *
 * The day cycle peaks at noon and troughs at midnight. The season adds a
 * slower triangle on top, so a winter noon can be colder than a summer
 * midnight — which is what makes the `warmth` need a building problem rather
 * than a nightly one. Deterministic and RNG-free, because temperature has to
 * replay identically.
 */
export function outdoorTemperatureC(
  tick: number,
  minC: number,
  maxC: number,
  season?: { readonly lengthDays: number; readonly swingC: number },
): number {
  const dayTick = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY
  // 0 at midnight, 1 at noon, 0 at next midnight.
  const hour = dayTick / TICKS_PER_HOUR
  const phase = hour <= 12 ? hour / 12 : (24 - hour) / 12
  const daily = minC + (maxC - minC) * phase
  if (season === undefined || season.lengthDays <= 0 || season.swingC === 0) return daily

  // A full year is two seasons out and back: coldest at phase 0, warmest at
  // the halfway point.
  const day = Math.floor(tick / TICKS_PER_DAY)
  const cycle = season.lengthDays * 2
  const position = ((day % cycle) + cycle) % cycle
  const seasonPhase = position <= season.lengthDays
    ? position / season.lengthDays
    : (cycle - position) / season.lengthDays
  return daily + season.swingC * (seasonPhase * 2 - 1)
}

function clampTemp(value: number): number {
  const rounded = Math.round(value)
  if (rounded > 127) return 127
  if (rounded < -128) return -128
  return rounded
}

/* -------------------------------------------------------------------------- */
/* Auto-routing (PRD 3.4)                                                      */
/* -------------------------------------------------------------------------- */

export type UtilityRouteKind = 'power' | 'water'

export interface UtilityRouteResult {
  readonly kind: UtilityRouteKind
  /** Inclusive path from the object anchor to the live grid node (tile indices). */
  readonly path: readonly number[]
  readonly costTiles: number
}

/**
 * Collapses a BFS tile path into axis-aligned line segments for
 * `paintCable` / `paintPipe` blueprint strokes.
 *
 * Consecutive steps that keep the same cardinal direction merge into one
 * stroke; a turn starts a new segment. Paths of length < 2 yield nothing.
 */
export function utilityPathToLines(
  path: readonly number[],
  mapSize: number,
): readonly { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[] {
  if (path.length < 2 || mapSize <= 0) return []

  const tileXY = (index: number): { x: number; y: number } => ({
    x: index % mapSize,
    y: (index / mapSize) | 0,
  })

  const lines: { x1: number; y1: number; x2: number; y2: number }[] = []
  const first = path[0]
  if (first === undefined) return []
  let start = first
  let prev = start
  let runDx = 0
  let runDy = 0

  for (let i = 1; i < path.length; i += 1) {
    const cur = path[i]
    if (cur === undefined) break
    const a = tileXY(prev)
    const b = tileXY(cur)
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (i === 1) {
      runDx = dx
      runDy = dy
      prev = cur
      continue
    }
    if (dx !== runDx || dy !== runDy) {
      const from = tileXY(start)
      const to = tileXY(prev)
      lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
      start = prev
      runDx = dx
      runDy = dy
    }
    prev = cur
  }

  const from = tileXY(start)
  const to = tileXY(prev)
  lines.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  return lines
}

/**
 * Shortest Manhattan path from `fromTile` to the nearest live cable/pipe node
 * over owned tiles. Pure preview helper — does not mutate the world.
 *
 * The session stages the returned path as dashed cable/pipe strokes when a
 * powered or plumbed object is placed (PRD 3.4).
 */
export function autoRouteUtility(
  world: InmateWorld,
  fromTile: number,
  kind: UtilityRouteKind,
): UtilityRouteResult | undefined {
  const grid = world.grid
  const size = grid.size
  if (fromTile < 0 || fromTile >= grid.tileCount) return undefined

  const isLive = (tile: number): boolean => {
    if (kind === 'power') {
      const id = grid.powerGridId[tile] ?? 0
      return id !== 0 && !world.power.isBranchShed(id) && world.power.hasCableAt(tile)
    }
    const id = grid.waterGridId[tile] ?? 0
    return id !== 0 && world.water.hasPipeAt(tile) && world.water.useMultiplierAt(id) > 0
  }

  if (isLive(fromTile)) {
    return { kind, path: [fromTile], costTiles: 0 }
  }

  const canTraverse = (tile: number): boolean => {
    // Auto-route may cross any owned tile (cables/pipes lay under floors).
    return (grid.owned[tile] ?? 0) !== 0 || (grid.outdoors[tile] ?? 0) === 0
  }

  const visited = new Uint8Array(grid.tileCount)
  const parent = new Int32Array(grid.tileCount)
  parent.fill(-1)
  const queue: number[] = []
  let head = 0

  visited[fromTile] = 1
  queue.push(fromTile)

  let found: number | undefined
  while (head < queue.length) {
    const current = queue[head]
    head += 1
    if (current === undefined) break
    if (current !== fromTile && isLive(current)) {
      found = current
      break
    }
    const x = current % size
    const y = (current / size) | 0
    for (const { dx, dy } of CARDINAL) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const ni = ny * size + nx
      if (visited[ni] !== 0) continue
      if (!canTraverse(ni) && !isLive(ni)) continue
      visited[ni] = 1
      parent[ni] = current
      queue.push(ni)
    }
  }

  if (found === undefined) return undefined

  const path: number[] = []
  let cursor: number | undefined = found
  while (cursor !== undefined && cursor >= 0) {
    path.push(cursor)
    if (cursor === fromTile) break
    const prev: number = parent[cursor] ?? -1
    cursor = prev < 0 ? undefined : prev
  }
  path.reverse()
  return { kind, path, costTiles: Math.max(0, path.length - 1) }
}

/* -------------------------------------------------------------------------- */
/* Cable / pipe painting                                                       */
/* -------------------------------------------------------------------------- */

/** Lays cable along an inclusive axis-aligned line. */
export function paintCable(world: InmateWorld, line: {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}): number {
  return paintOverlay(world.grid, world.power.hasCable, line, true)
}

/** Clears cable along an inclusive axis-aligned line. */
export function clearCable(world: InmateWorld, line: {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}): number {
  return paintOverlay(world.grid, world.power.hasCable, line, false)
}

/** Lays pipe along an inclusive axis-aligned line. */
export function paintPipe(world: InmateWorld, line: {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}): number {
  return paintOverlay(world.grid, world.water.hasPipe, line, true)
}

/** Clears pipe along an inclusive axis-aligned line. */
export function clearPipe(world: InmateWorld, line: {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}): number {
  return paintOverlay(world.grid, world.water.hasPipe, line, false)
}

function paintOverlay(
  grid: TileGrid,
  layer: Uint8Array,
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  present: boolean,
): number {
  const tiles = lineTiles(grid, line)
  let painted = 0
  const value = present ? 1 : 0
  for (const tile of tiles) {
    if ((layer[tile] ?? 0) === value) continue
    layer[tile] = value
    painted += 1
    grid.markDirtyAt(tile)
  }
  return painted
}

function lineTiles(
  grid: TileGrid,
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
): number[] {
  const tiles: number[] = []
  const x1 = line.x1
  const y1 = line.y1
  const x2 = line.x2
  const y2 = line.y2
  if (x1 === x2) {
    const yStart = Math.min(y1, y2)
    const yEnd = Math.max(y1, y2)
    for (let y = yStart; y <= yEnd; y += 1) {
      if (!grid.inBounds(x1, y)) continue
      tiles.push(grid.idx(x1, y))
    }
    return tiles
  }
  if (y1 === y2) {
    const xStart = Math.min(x1, x2)
    const xEnd = Math.max(x1, x2)
    for (let x = xStart; x <= xEnd; x += 1) {
      if (!grid.inBounds(x, y1)) continue
      tiles.push(grid.idx(x, y1))
    }
    return tiles
  }
  // Non-axis line: snap to the dominant axis (same as wall strokes).
  if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
    return lineTiles(grid, { x1, y1, x2, y2: y1 })
  }
  return lineTiles(grid, { x1, y1: y1, x2: x1, y2 })
}

/** Sets a single cable tile (tests / commands). */
export function setCableTile(world: InmateWorld, tile: Tile, present: boolean): void {
  if (!world.grid.inBounds(tile.x, tile.y)) return
  const index = world.grid.idx(tile.x, tile.y)
  world.power.setCable(index, present)
  world.grid.markDirtyAt(index)
}

/** Sets a single pipe tile (tests / commands). */
export function setPipeTile(world: InmateWorld, tile: Tile, present: boolean): void {
  if (!world.grid.inBounds(tile.x, tile.y)) return
  const index = world.grid.idx(tile.x, tile.y)
  world.water.setPipe(index, present)
  world.grid.markDirtyAt(index)
}

/* -------------------------------------------------------------------------- */
/* Graph helpers                                                               */
/* -------------------------------------------------------------------------- */

function connectedComponents(size: number, conductive: Uint8Array): number[][] {
  const total = conductive.length
  const seen = new Uint8Array(total)
  const components: number[][] = []

  for (let start = 0; start < total; start += 1) {
    if (conductive[start] === 0 || seen[start] !== 0) continue
    const component: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      component.push(current)
      const x = current % size
      const y = (current / size) | 0
      for (const { dx, dy } of CARDINAL) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const ni = ny * size + nx
        if (conductive[ni] === 0 || seen[ni] !== 0) continue
        seen[ni] = 1
        stack.push(ni)
      }
    }
    components.push(component)
  }
  return components
}

function entityTouches(entity: ObjectEntity, tileSet: Set<number>): boolean {
  for (const tile of entity.object.tiles) {
    if (tileSet.has(tile)) return true
  }
  return false
}

function tileCountOf(size: number): number {
  return size * size
}

/** Water fixture-use multiplier for a tile (0..1). */
export function waterUseMultiplier(world: InmateWorld, tileIndex: number): number {
  const branchId = world.grid.waterGridId[tileIndex] ?? 0
  return world.water.useMultiplierAt(branchId)
}

export { PowerGrid, WaterGrid }
