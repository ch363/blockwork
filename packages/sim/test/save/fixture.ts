/**
 * A populated `SaveState` for the save tests.
 *
 * Built from seeded RNG streams rather than literals so the grid and the
 * entities have real variety in them — a save format that round-trips a field
 * of zeroes proves very little — while staying identical between runs, which
 * is the whole point of the determinism assertions it feeds.
 */

import { Rng } from '../../src/core/rng'
import type { RngState } from '../../src/core/rng'
import type { SaveState } from '../../src/save/state'
import { TILE_FIELDS, TileGrid } from '../../src/world/tileGrid'

/** PRD 4.3's Large preset, and the size the acceptance criterion names. */
export const LARGE_MAP = 220

/** PRD 7.5's baseline population. */
export const POPULATION = 400

/** Fills every tile of every field with values in range for that field. */
export function populateGrid(size: number, seed: number): TileGrid {
  const grid = TileGrid.allocate(size)
  const rng = new Rng(seed)

  for (const field of TILE_FIELDS) {
    const view = grid.array(field)
    const stream = rng.stream(`fixture.${field}`)
    const signed = field === 'temperature'

    for (let i = 0; i < view.length; i += 1) {
      // Written through the array rather than `setAt` so the fixture does not
      // spend its time on dirty-chunk bookkeeping it never reads.
      view[i] = signed ? stream.nextInt(-40, 60) : stream.nextInt(0, 200)
    }
  }

  grid.markAllDirty()
  return grid
}

function entities(count: number, seed: number): SaveState['entities'] {
  const rng = new Rng(seed)
  const stream = rng.stream('fixture.entities')

  return Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    kind: stream.nextInt(0, 4),
    x: stream.nextInt(0, LARGE_MAP),
    y: stream.nextInt(0, LARGE_MAP),
    needs: {
      hunger: stream.nextInt(0, 101),
      sleep: stream.nextInt(0, 101),
    },
    traits: [`trait-${stream.nextInt(0, 12)}`],
  }))
}

function rngState(seed: number): RngState {
  const rng = new Rng(seed)
  for (const name of ['intake', 'misconduct', 'search', 'contraband']) {
    const stream = rng.stream(name)
    for (let draw = 0; draw < 32; draw += 1) stream.nextUint32()
  }
  return rng.serialise()
}

export interface FixtureOptions {
  readonly size?: number
  readonly population?: number
  readonly seed?: number
  readonly playedTicks?: number
}

/** A save state with a fully populated grid and a full population. */
export function makeSaveState(options: FixtureOptions = {}): SaveState {
  const size = options.size ?? LARGE_MAP
  const population = options.population ?? POPULATION
  const seed = options.seed ?? 0x5eed_1234
  const playedTicks = options.playedTicks ?? 123_456

  return {
    seed,
    playedTicks,
    settings: { sizePreset: 'large', startingParcels: 4 },
    grid: populateGrid(size, seed),
    entities: entities(population, seed),
    rooms: [
      { id: 1, kind: 'cell-block', tiles: 240 },
      { id: 2, kind: 'canteen', tiles: 180 },
    ],
    sectors: [{ id: 1, name: 'Secure', permissions: ['staff', 'inmate'] }],
    economy: { balance: 42_000, dailyExpenditure: 3_100 },
    directorate: { unlocked: ['administration', 'security'], researching: null },
    contracts: [{ id: 1, kind: 'grant', progress: 3, target: 10 }],
    routines: {
      medium: Array.from({ length: 24 }, (_unused, hour) =>
        hour < 6 || hour >= 22 ? 'sleep' : hour === 8 || hour === 12 || hour === 17 ? 'meal' : 'free',
      ),
    },
    standingOrders: { searchOnEntry: true, lockdownAtNight: false },
    posts: [{ id: 1, kind: 'patrol', tiles: [10, 11, 12] }],
    log: Array.from({ length: 50 }, (_unused, index) => ({
      tick: index * 600,
      kind: 'log.entry',
      subject: index,
    })),
    rngState: rngState(seed),
  }
}
