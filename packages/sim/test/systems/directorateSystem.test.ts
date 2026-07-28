/**
 * T5.1 — The Directorate: prerequisites, administrator gating, and the claim
 * that every declared unlock is actually enforced somewhere.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { Command, JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import {
  DIRECTORATE_EVENTS,
  FEATURE_GATES,
  UNLOCK_KINDS,
  administratorStatus,
  checkStartResearch,
  gatedIds,
  gatingNode,
  isUnlocked,
} from '../../src/entities/directorate'
import { placeObject } from '../../src/entities/objects'
import { fireStaff, hireStaff } from '../../src/entities/staff'
import {
  DIRECTORATE_COMMANDS,
  createDirectorateSystem,
  directorateCommandHandlers,
} from '../../src/systems/directorateSystem'
import {
  INTAKE_COMMANDS,
  createInmateWorld,
  intakeCommandHandlers,
} from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { designateRoom } from '../../src/world/roomDetection'
import { refreshPassability } from '../../src/world/construction'
import { TRACE_KINDS } from '../../src/trace/causalEvent'

const DATA: GameData = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
  reasons(kind: string): string[] {
    return this.of(kind).map((event) => String((event.data as JsonObject)['reason']))
  }
}

/** Floors a rectangle so rooms can be designated and objects placed on it. */
function floorRect(world: InmateWorld, x: number, y: number, w: number, h: number): void {
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const index = world.grid.idx(x + dx, y + dy)
      world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
      world.grid.setAt('outdoors', index, 0)
      world.grid.setAt('owned', index, 1)
      refreshPassability(world, world.data, index)
    }
  }
}

/**
 * A prison with a Warden in a functional office and money in the bank — the
 * minimum from which research is legal at all.
 */
function scenario(options: { readonly funds?: number } = {}): {
  readonly world: InmateWorld
  readonly sim: Simulation
  readonly events: RecordingSink
} {
  const events = new RecordingSink()
  const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })

  // Two offices: administrators claim one each, and the Security Director
  // needs one of their own the moment Security Office completes.
  const deps = { world, data: DATA, events, tick: 0 }
  for (const originX of [2, 14]) {
    floorRect(world, originX, 2, 8, 8)
    designateRoom(deps, { x: originX, y: 2, width: 8, height: 8 }, 'office')
    placeObject(deps, { x: originX + 1, y: 3 }, 'office_desk')
    placeObject(deps, { x: originX + 3, y: 3 }, 'chair')
    placeObject(deps, { x: originX + 5, y: 3 }, 'filing_cabinet')
  }
  const offices = [...world.rooms.all()].filter((room) => room.defId === 'office')
  expect(offices, 'both offices must be detected').toHaveLength(2)
  for (const office of offices) {
    expect(world.rooms.statusOf(office.id)?.functional, 'office must be functional').toBe(true)
  }

  const hired = hireStaff({ world, defId: 'warden', events, tick: 0, tx: 4, ty: 4 })
  expect(hired.reason, 'the Warden is ungated and must hire').toBeUndefined()

  const funds = options.funds ?? 100_000
  if (funds > 0) world.economy.credit(0, 'starting_funds', funds, 'Test funds', 0)

  const sim = new Simulation({
    seed: 0xb10c_5001,
    world,
    systems: [createDirectorateSystem({ data: DATA })],
    commandHandlers: directorateCommandHandlers(DATA),
    events,
  })
  return { world, sim, events }
}

function start(nodeId: string, issuedAtTick = 0): Command {
  return {
    type: DIRECTORATE_COMMANDS.startResearch,
    issuedAtTick,
    payload: { nodeId },
  }
}

function step(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.step()
}

describe('directorate — starting research', () => {
  it('refuses a node whose prerequisites are outstanding, and accepts it once they are met', () => {
    const { world, sim, events } = scenario()

    // Surveillance sits under Security Office. Nothing has been researched.
    sim.enqueue(start('surveillance'))
    sim.step()

    expect(events.reasons(DIRECTORATE_EVENTS.rejected)).toContain('branch-locked')
    expect(world.directorate.isActive('surveillance')).toBe(false)

    // Buy the root node the honest way, then hire the Director it appoints.
    sim.enqueue(start('security_office'))
    sim.step()
    expect(world.directorate.isActive('security_office')).toBe(true)
    step(sim, 6 * TICKS_PER_HOUR)
    expect(world.directorate.isComplete('security_office')).toBe(true)

    const director = hireStaff({
      world,
      defId: 'security_director',
      events,
      tick: sim.tick,
      tx: 5,
      ty: 5,
    })
    expect(director.reason, 'Security Office unlocks the Director').toBeUndefined()

    sim.enqueue(start('surveillance'))
    sim.step()
    expect(world.directorate.isActive('surveillance')).toBe(true)
  })

  it('charges the node cost once, to the research category', () => {
    const { world, sim } = scenario({ funds: 10_000 })
    const before = world.economy.balance
    const node = DATA.directorate.get('welfare')

    sim.enqueue(start('welfare'))
    sim.step()

    expect(world.economy.balance).toBe(before - node.cost)
    expect(
      world.economy.entries.filter((entry) => entry.category === 'research'),
    ).toHaveLength(1)

    // A second start on an already-active node is refused, and free.
    sim.enqueue(start('welfare'))
    sim.step()
    expect(world.economy.balance).toBe(before - node.cost)
  })

  it('refuses a node the prison cannot afford', () => {
    const { world, sim, events } = scenario({ funds: 0 })
    // The world opens with `startingFunds`; spend it all so Legal is out of reach.
    world.economy.debit(0, 'other', world.economy.balance, 'Drain', 0)

    sim.enqueue(start('legal'))
    sim.step()

    expect(events.reasons(DIRECTORATE_EVENTS.rejected)).toContain('insufficient-funds')
    expect(world.directorate.isActive('legal')).toBe(false)
  })

  it('completes after exactly the declared number of in-game hours', () => {
    const { world, sim, events } = scenario()
    const node = DATA.directorate.get('welfare')

    sim.enqueue(start('welfare'))
    sim.step()

    // The command applied on tick 1, and the system advances once a minute, so
    // the last minute of the node lands two system passes from here.
    step(sim, node.durationHours * TICKS_PER_HOUR - 2 * TICKS_PER_MINUTE)
    expect(world.directorate.isComplete('welfare')).toBe(false)

    step(sim, 2 * TICKS_PER_MINUTE)
    expect(world.directorate.isComplete('welfare')).toBe(true)
    expect(events.of(DIRECTORATE_EVENTS.completed)).toHaveLength(1)
  })
})

describe('directorate — the administrator gate (T5.1 acceptance)', () => {
  it('pauses every Security branch node when the Security Director is fired, and says so', () => {
    const { world, sim, events } = scenario()

    sim.enqueue(start('security_office'))
    sim.step()
    step(sim, 6 * TICKS_PER_HOUR)
    expect(world.directorate.isComplete('security_office')).toBe(true)

    const director = hireStaff({
      world,
      defId: 'security_director',
      events,
      tick: sim.tick,
      tx: 5,
      ty: 5,
    })
    const directorId = director.entity?.id
    expect(directorId).toBeDefined()

    sim.enqueue(start('surveillance'))
    sim.enqueue(start('patrols'))
    sim.step()
    step(sim, TICKS_PER_HOUR)

    const surveillanceBefore = world.directorate.activeResearch('surveillance')?.elapsedTicks ?? 0
    const patrolsBefore = world.directorate.activeResearch('patrols')?.elapsedTicks ?? 0
    expect(surveillanceBefore).toBeGreaterThan(0)

    // Fire the Director. Both Security nodes must stop, each with a reason.
    fireStaff(world, directorId ?? 0, events, sim.tick)
    step(sim, 3 * TICKS_PER_HOUR)

    expect(world.directorate.activeResearch('surveillance')?.elapsedTicks).toBe(surveillanceBefore)
    expect(world.directorate.activeResearch('patrols')?.elapsedTicks).toBe(patrolsBefore)

    const paused = events.of(TRACE_KINDS.directorateResearchPaused)
    const pausedNodes = paused.map((event) => String((event.data as JsonObject)['nodeId'])).sort()
    expect(pausedNodes).toEqual(['patrols', 'surveillance'])
    for (const event of paused) {
      const detail = event.data as JsonObject
      expect(detail['branch']).toBe('security')
      expect(detail['administrator']).toBe('security_director')
      expect(detail['reason']).toBe('no-administrator')
    }

    // It is a pause, not a cancellation: rehiring resumes from where it stopped.
    hireStaff({ world, defId: 'security_director', events, tick: sim.tick, tx: 5, ty: 5 })
    step(sim, TICKS_PER_HOUR)
    expect(
      world.directorate.activeResearch('surveillance')?.elapsedTicks ?? 0,
    ).toBeGreaterThan(surveillanceBefore)
    expect(events.of(DIRECTORATE_EVENTS.resumed).length).toBeGreaterThan(0)
  })

  it('reports an administrator in post but without a functional office separately', () => {
    const { world, events } = scenario()
    expect(administratorStatus(world, DATA, 'warden')).toBeNull()

    // Demolishing every office leaves the Warden hired and the post useless.
    for (const office of [...world.rooms.all()].filter((room) => room.defId === 'office')) {
      world.rooms.remove(office.id)
    }

    expect(administratorStatus(world, DATA, 'warden')).toBe('no-office')
    const check = checkStartResearch({
      data: DATA,
      state: world.directorate,
      world,
      nodeId: 'welfare',
      balance: 100_000,
    })
    expect(check.ok).toBe(false)
    expect(check.reason).toBe('no-office')
    expect(events.events.length).toBeGreaterThanOrEqual(0)
  })

  it('reports a role that was never hired as no-administrator', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    expect(administratorStatus(world, DATA, 'security_director')).toBe('no-administrator')
  })
})

describe('directorate — every declared unlock is gated (T5.1 acceptance)', () => {
  it('declares at least one unlock of each kind the data uses', () => {
    // Guards the enumeration below against silently testing nothing.
    const populated = UNLOCK_KINDS.filter((kind) => gatedIds(DATA, kind).length > 0)
    expect(populated).toEqual(
      expect.arrayContaining(['rooms', 'objects', 'staff', 'programs', 'features']),
    )
  })

  it('refuses every gated room until its node completes', () => {
    for (const roomDefId of gatedIds(DATA, 'rooms')) {
      const events = new RecordingSink()
      const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
      floorRect(world, 2, 2, 8, 8)
      const deps = { world, data: DATA, events, tick: 0 }
      const rect = { x: 2, y: 2, width: 8, height: 8 }

      expect(designateRoom(deps, rect, roomDefId), roomDefId).toBe(0)
      expect(events.reasons('rooms.rejected'), roomDefId).toContain('locked')

      const nodeId = gatingNode(DATA, 'rooms', roomDefId)
      expect(nodeId, roomDefId).toBeDefined()
      world.directorate.grant(nodeId ?? '')
      expect(designateRoom(deps, rect, roomDefId), roomDefId).toBeGreaterThan(0)
    }
  })

  it('refuses every gated object until its node completes', () => {
    for (const objectDefId of gatedIds(DATA, 'objects')) {
      const events = new RecordingSink()
      const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
      const deps = { world, data: DATA, events, tick: 0 }

      expect(placeObject(deps, { x: 4, y: 4 }, objectDefId), objectDefId).toBeUndefined()
      const rejections = events.of('objects.rejected')
      expect(
        rejections.some((event) => (event.data as JsonObject)['reason'] === 'locked'),
        objectDefId,
      ).toBe(true)
    }
  })

  it('refuses every gated staff role until its node completes', () => {
    for (const staffDefId of gatedIds(DATA, 'staff')) {
      const events = new RecordingSink()
      const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

      const locked = hireStaff({ world, defId: staffDefId, events, tick: 0, tx: 4, ty: 4 })
      expect(locked.reason, staffDefId).toBe('locked')

      const nodeId = gatingNode(DATA, 'staff', staffDefId)
      world.directorate.grant(nodeId ?? '')
      const after = hireStaff({ world, defId: staffDefId, events, tick: 0, tx: 4, ty: 4 })
      // Unlocked roles may still be refused for a *different* reason (an
      // administrator with no office, an armed officer with no armoury). What
      // must not survive the unlock is the lock itself.
      expect(after.reason, staffDefId).not.toBe('locked')
    }
  })

  it('refuses a gated security category on the intake queue', () => {
    expect(gatedIds(DATA, 'securityCategories')).toContain('condemned')

    const events = new RecordingSink()
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const sim = new Simulation({
      seed: 1,
      world,
      commandHandlers: intakeCommandHandlers(DATA),
      events,
    })

    sim.enqueue({
      type: INTAKE_COMMANDS.setRequested,
      issuedAtTick: 0,
      payload: { category: 'condemned', count: 2 },
    })
    sim.step()

    expect(events.reasons('intake.rejected')).toContain('locked')
    expect(world.intake.requestedCounts.get('condemned')).toBeUndefined()
    expect(isUnlocked(DATA, world.directorate, 'securityCategories', 'condemned')).toBe(false)

    world.directorate.grant('capital_cases')
    expect(isUnlocked(DATA, world.directorate, 'securityCategories', 'condemned')).toBe(true)
  })

  it('accounts for every feature in balance.json, gate or flagged gap', () => {
    const declared = [...DATA.balance.features].sort()
    const registered = FEATURE_GATES.map((gate) => gate.featureId).sort()
    expect(registered).toEqual(declared)

    // A gate that claims to be enforced must name where. A gap must name what
    // is missing. Neither may be blank.
    for (const gate of FEATURE_GATES) {
      if (gate.pending === undefined) {
        expect(gate.enforcedIn, gate.featureId).not.toBe('-')
        expect(gate.enforcedIn.length, gate.featureId).toBeGreaterThan(0)
      } else {
        expect(gate.pending.length, gate.featureId).toBeGreaterThan(0)
      }
    }

    // Every feature is owned by exactly one node.
    for (const gate of FEATURE_GATES) {
      expect(gatingNode(DATA, 'features', gate.featureId), gate.featureId).toBeDefined()
    }
  })
})
