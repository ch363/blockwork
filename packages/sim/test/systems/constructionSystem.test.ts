import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { GameData } from '../../src/data/loader'
import { hireStaff } from '../../src/entities/staff'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import {
  CONSTRUCTION_SYSTEM_PERIOD,
  NO_WORKFORCE,
  countBuildWorkersAt,
  createConstructionSystem,
  createJobWorkforce,
  uniformWorkforce,
} from '../../src/systems/constructionSystem'
import { deliver, isDelivered, placeWall, constructionCommandHandlers } from '../../src/world/construction'
import type { ConstructionSite } from '../../src/world/construction'
import { NO_MATERIAL } from '../../src/world/materials'
import { DATA, RecordingSink, WALL_MATERIAL, scenario } from '../world/constructionFixture'

type Scenario = ReturnType<typeof scenario>

const WALL_TILE = { x1: 5, y1: 5, x2: 5, y2: 5 }
const WALL_WORK_TICKS = DATA.materials.get(WALL_MATERIAL).buildMinutes * CONSTRUCTION_SYSTEM_PERIOD

/** The same content with the delivery stub off, so sites wait for materials. */
const REAL_DELIVERY: GameData = {
  ...DATA,
  balance: {
    ...DATA.balance,
    construction: { ...DATA.balance.construction, stubMaterialDelivery: false },
  },
}

/** The site under test. Its absence is a test failure, not a branch. */
function siteAt(run: Scenario, x = 5, y = 5): ConstructionSite {
  const site = run.world.sites.get(run.world.grid.idx(x, y))
  if (site === undefined) throw new Error(`no construction site at (${x}, ${y})`)
  return site
}

function step(run: Scenario, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) run.sim.step()
}

describe('constructionSystem (PRD 4.4 slot 9)', () => {
  it('runs once an in-game minute, as the PRD period table says', () => {
    const system = createConstructionSystem({ data: DATA })

    expect(system.name).toBe('construction')
    expect(system.period).toBe(10)
    expect(CONSTRUCTION_SYSTEM_PERIOD).toBe(10)
  })

  it('advances a site by one worker-tick per worker per tick', () => {
    const run = scenario({ workers: 1 })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    step(run, CONSTRUCTION_SYSTEM_PERIOD)
    expect(siteAt(run).workTicksDone).toBe(CONSTRUCTION_SYSTEM_PERIOD)

    step(run, CONSTRUCTION_SYSTEM_PERIOD)
    expect(siteAt(run).workTicksDone).toBe(2 * CONSTRUCTION_SYSTEM_PERIOD)
  })

  it('finishes exactly when the work the material asks for is done', () => {
    const run = scenario({ workers: 1 })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    step(run, WALL_WORK_TICKS - CONSTRUCTION_SYSTEM_PERIOD)
    expect(run.world.sites.size).toBe(1)
    expect(run.world.grid.get('wallMaterial', 5, 5)).toBe(NO_MATERIAL)

    step(run, CONSTRUCTION_SYSTEM_PERIOD)

    expect(run.sim.tick).toBe(WALL_WORK_TICKS)
    expect(run.world.sites.size).toBe(0)
    expect(run.world.grid.get('wallMaterial', 5, 5)).toBe(
      run.world.materials.indexOf(WALL_MATERIAL),
    )
    expect(run.events.of('construction.completed')).toHaveLength(1)
  })

  it('builds proportionally faster with more builders on the tile', () => {
    const solo = scenario({ workers: 1 })
    const crew = scenario({ workers: 3 })

    placeWall(solo.deps(), WALL_TILE, WALL_MATERIAL)
    placeWall(crew.deps(), WALL_TILE, WALL_MATERIAL)
    step(solo, CONSTRUCTION_SYSTEM_PERIOD)
    step(crew, CONSTRUCTION_SYSTEM_PERIOD)

    expect(crew.world.sites.get(crew.world.grid.idx(5, 5))?.workTicksDone).toBe(
      3 * siteAt(solo).workTicksDone,
    )
  })

  it('builds nothing with nobody there, and says so once rather than every minute', () => {
    const run = scenario({ workers: 0 })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    step(run, 100)

    expect(siteAt(run).workTicksDone).toBe(0)
    expect(siteAt(run).blockedBy).toBe('worker')

    const blocked = run.events.of('construction.blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.data).toMatchObject({ reason: 'worker' })
  })

  it('reports again when a site goes from one kind of stall to another', () => {
    const run = scenario({ workers: 0, data: REAL_DELIVERY })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    step(run, 20)
    expect(siteAt(run).blockedBy).toBe('materials')

    deliver(siteAt(run), WALL_MATERIAL, 1)
    step(run, 20)

    expect(siteAt(run).blockedBy).toBe('worker')
    expect(run.events.of('construction.blocked').map((event) => event.data)).toMatchObject([
      { reason: 'materials' },
      { reason: 'worker' },
    ])
  })

  it('waits for the bill of materials before any work counts', () => {
    const run = scenario({ workers: 2, data: REAL_DELIVERY })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    step(run, 30)
    expect(siteAt(run).workTicksDone).toBe(0)

    deliver(siteAt(run), WALL_MATERIAL, 1)
    step(run, CONSTRUCTION_SYSTEM_PERIOD)

    expect(siteAt(run).workTicksDone).toBe(2 * CONSTRUCTION_SYSTEM_PERIOD)
  })

  it('delivers on the spot while logistics are stubbed', () => {
    const run = scenario({ workers: 0 })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)

    expect(isDelivered(siteAt(run))).toBe(false)
    step(run, CONSTRUCTION_SYSTEM_PERIOD)
    expect(isDelivered(siteAt(run))).toBe(true)
  })

  it('says so once when it is wired to a world it cannot build in', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createConstructionSystem({ data: DATA, workforce: uniformWorkforce(1) })],
      events,
    })

    for (let i = 0; i < 50; i += 1) sim.step()

    expect(events.of('construction.rejected')).toHaveLength(1)
    expect(events.of('construction.rejected')[0]?.data).toMatchObject({ reason: 'wrong-world' })
  })

  it('defaults to a workforce of nobody', () => {
    expect(NO_WORKFORCE.workersAt(0)).toBe(0)
  })
})

describe('job workforce (T8.3)', () => {
  const BUILD_TILE = { x: 5, y: 5 }
  const STUB_DATA: GameData = {
    ...DATA,
    balance: {
      ...DATA.balance,
      construction: { ...DATA.balance.construction, stubMaterialDelivery: true },
    },
  }

  function jobScenario(): {
    readonly world: InmateWorld
    readonly sim: Simulation
    readonly events: RecordingSink
    site(): ConstructionSite
  } {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: STUB_DATA,
      continuousIntake: false,
      research: 'all',
    })
    const sim = new Simulation({
      seed: 0xb10c_0803,
      world,
      systems: [createConstructionSystem({ data: STUB_DATA })],
      commandHandlers: constructionCommandHandlers(STUB_DATA),
      events,
    })

    placeWall({ world, data: STUB_DATA, events, tick: 0 }, { x1: 5, y1: 5, x2: 5, y2: 5 }, WALL_MATERIAL)

    return {
      world,
      sim,
      events,
      site() {
        const site = world.sites.get(world.grid.idx(BUILD_TILE.x, BUILD_TILE.y))
        if (site === undefined) throw new Error('expected construction site')
        return site
      },
    }
  }

  function hireBuilderOnTile(world: InmateWorld, events: RecordingSink, tx: number, ty: number) {
    const hired = hireStaff({ world, defId: 'maintenance', events, tick: 0, tx, ty })
    if (hired.entity === undefined) throw new Error('expected maintenance worker')
    return hired.entity
  }

  it('builds nothing with no assigned workforce on site', () => {
    const run = jobScenario()

    for (let i = 0; i < 100; i += 1) run.sim.step()

    expect(run.site().workTicksDone).toBe(0)
    expect(run.site().blockedBy).toBe('worker')
  })

  it('advances proportionally when one builder is on site with a claimed build job', () => {
    const run = jobScenario()
    const builder = hireBuilderOnTile(run.world, run.events, BUILD_TILE.x, BUILD_TILE.y)

    for (let i = 0; i < CONSTRUCTION_SYSTEM_PERIOD; i += 1) run.sim.step()
    const job = run.world.jobs.open().find((entry) => entry.kind === 'build')
    expect(job).toBeDefined()
    if (job === undefined) throw new Error('expected build job')

    expect(run.world.jobs.claim(job.id, 'staff', builder.id)).toBe(true)
    builder.staff.duty = { kind: 'job', jobId: job.id }

    expect(createJobWorkforce(run.world).workersAt(run.world.grid.idx(BUILD_TILE.x, BUILD_TILE.y))).toBe(1)
    expect(countBuildWorkersAt(run.world, run.world.grid.idx(BUILD_TILE.x, BUILD_TILE.y))).toBe(1)

    for (let i = 0; i < CONSTRUCTION_SYSTEM_PERIOD; i += 1) run.sim.step()

    expect(run.site().workTicksDone).toBe(CONSTRUCTION_SYSTEM_PERIOD)
  })
})

describe('material delivery (seam for T3.4 logistics)', () => {
  it('accepts up to the outstanding units and refuses the surplus', () => {
    const run = scenario({ workers: 0, data: REAL_DELIVERY })
    placeWall(run.deps(), WALL_TILE, WALL_MATERIAL)
    const site = siteAt(run)

    expect(deliver(site, 'timber', 5)).toBe(0)
    expect(isDelivered(site)).toBe(false)

    expect(deliver(site, WALL_MATERIAL, 4)).toBe(1)
    expect(isDelivered(site)).toBe(true)
    expect(deliver(site, WALL_MATERIAL, 1)).toBe(0)
  })
})
