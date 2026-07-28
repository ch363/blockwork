/**
 * T4.5 — combat damage maths, disarm / instant-kill rolls, incap / death,
 * corpse handling, officer intervention.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_MINUTE } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  applyDamage,
  computeHitDamage,
  hasLineOfSight,
  isIncapacitated,
  rollDisarm,
  rollInstantKill,
  rollStunResist,
} from '../../src/entities/health'
import { createInmateShell, generateInmate, type InmateEntity } from '../../src/entities/inmate'
import { hireStaff } from '../../src/entities/staff'
import {
  COMBAT_EVENTS,
  beginFight,
  beginOverdose,
  createCombatSystem,
} from '../../src/systems/combatSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { completeJob } from '../../src/systems/jobSystem'
import { refreshPassability } from '../../src/world/construction'

const DATA = loadGameData()
const COMBAT = DATA.balance.combat
const SEED = 0xc0_4ba7_45

class RecordingSink {
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

function makeWorld(size = 24): { world: InmateWorld; events: RecordingSink } {
  const events = new RecordingSink()
  const world = createInmateWorld({ size, data: DATA, research: 'all' })
  return { world, events }
}

function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putWall(world: InmateWorld, x: number, y: number): void {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
}

function spawnInmate(
  world: InmateWorld,
  tx: number,
  ty: number,
  options: {
    readonly reputations?: readonly string[]
    readonly inventory?: readonly string[]
    readonly health?: number
  } = {},
): InmateEntity {
  putFloor(world, tx, ty)
  const rng = new Rng(SEED).stream('intake')
  const component = generateInmate({ data: DATA, rng, category: 'medium' })
  if (options.reputations !== undefined) {
    const mutable = component as unknown as { reputations: { id: string; revealed: boolean }[] }
    mutable.reputations = options.reputations.map((id) => ({ id, revealed: true }))
  }
  if (options.inventory !== undefined) {
    component.inventory.push(...options.inventory)
  }
  if (options.health !== undefined) {
    component.health = options.health
  }
  const id = world.inmates.allocateId()
  const entity = createInmateShell({
    id,
    data: DATA,
    inmate: component,
    tx,
    ty,
  })
  world.inmates.add(entity)
  return entity
}

function spawnOfficer(world: InmateWorld, events: RecordingSink, tx: number, ty: number) {
  putFloor(world, tx, ty)
  const result = hireStaff({
    world,
    defId: 'officer',
    events,
    tick: 0,
    tx,
    ty,
  })
  if (result.entity === undefined) {
    throw new Error(`failed to hire officer: ${result.reason ?? 'unknown'}`)
  }
  return result.entity
}

function runCombat(world: InmateWorld, events: RecordingSink, ticks: number, seed = SEED): void {
  const sim = new Simulation({
    seed,
    world,
    systems: [createCombatSystem({ data: DATA })],
    events,
  })
  for (let i = 0; i < ticks; i += 1) sim.step()
}

/* -------------------------------------------------------------------------- */
/* Damage maths                                                                */
/* -------------------------------------------------------------------------- */

describe('damage maths', () => {
  const attackPower = 10
  const base = computeHitDamage({
    attackPower,
    attackerReputations: [],
    defenderReputations: [],
    wearingVest: false,
    balance: COMBAT,
  })

  it('applies every attack / defense / vest combination', () => {
    const attackers: readonly (readonly string[])[] = [
      [],
      ['strong'],
      ['very_strong'],
      ['strong', 'very_strong'],
    ]
    const defenders: readonly (readonly string[])[] = [
      [],
      ['hardy'],
      ['very_hardy'],
      ['hardy', 'very_hardy'],
    ]
    const vests = [false, true] as const

    for (const attacker of attackers) {
      for (const defender of defenders) {
        for (const vest of vests) {
          const damage = computeHitDamage({
            attackPower,
            attackerReputations: attacker,
            defenderReputations: defender,
            wearingVest: vest,
            balance: COMBAT,
          })
          let expected = attackPower
          if (attacker.includes('very_strong')) expected *= COMBAT.attackMultipliers.very_strong
          else if (attacker.includes('strong')) expected *= COMBAT.attackMultipliers.strong
          if (defender.includes('very_hardy')) expected *= COMBAT.defenseMultipliers.very_hardy
          else if (defender.includes('hardy')) expected *= COMBAT.defenseMultipliers.hardy
          if (vest) expected *= COMBAT.vestDamageMultiplier
          expect(damage).toBeCloseTo(expected, 10)
        }
      }
    }
  })

  it('matches the stated strong / hardy / vest modifiers', () => {
    expect(base).toBe(10)
    expect(
      computeHitDamage({
        attackPower,
        attackerReputations: ['strong'],
        defenderReputations: [],
        wearingVest: false,
        balance: COMBAT,
      }),
    ).toBeCloseTo(15)
    expect(
      computeHitDamage({
        attackPower,
        attackerReputations: ['very_strong'],
        defenderReputations: [],
        wearingVest: false,
        balance: COMBAT,
      }),
    ).toBeCloseTo(20)
    expect(
      computeHitDamage({
        attackPower,
        attackerReputations: [],
        defenderReputations: ['hardy'],
        wearingVest: false,
        balance: COMBAT,
      }),
    ).toBeCloseTo(6.7)
    expect(
      computeHitDamage({
        attackPower,
        attackerReputations: [],
        defenderReputations: ['very_hardy'],
        wearingVest: false,
        balance: COMBAT,
      }),
    ).toBeCloseTo(5)
    expect(
      computeHitDamage({
        attackPower,
        attackerReputations: [],
        defenderReputations: [],
        wearingVest: true,
        balance: COMBAT,
      }),
    ).toBeCloseTo(5)
  })
})

/* -------------------------------------------------------------------------- */
/* Disarm / instant kill / stun resist                                         */
/* -------------------------------------------------------------------------- */

describe('disarm and instant-kill rolls', () => {
  it('never disarms without a fighter reputation', () => {
    const rng = new Rng(SEED).stream('combat')
    for (let i = 0; i < 40; i += 1) {
      expect(rollDisarm([], COMBAT, rng).disarmed).toBe(false)
    }
  })

  it('disarms more often for expert_fighter than trained_fighter', () => {
    const trained = countTrue(200, (rng) => rollDisarm(['trained_fighter'], COMBAT, rng).disarmed)
    const expert = countTrue(200, (rng) => rollDisarm(['expert_fighter'], COMBAT, rng).disarmed)
    expect(expert).toBeGreaterThan(trained)
    expect(trained).toBeGreaterThan(0)
  })

  it('never instant-kills without a deadly reputation', () => {
    const rng = new Rng(SEED).stream('combat')
    for (let i = 0; i < 40; i += 1) {
      expect(rollInstantKill([], COMBAT, rng).killed).toBe(false)
    }
  })

  it('kills more often for very_deadly than deadly', () => {
    const deadly = countTrue(300, (rng) => rollInstantKill(['deadly'], COMBAT, rng).killed)
    const very = countTrue(300, (rng) => rollInstantKill(['very_deadly'], COMBAT, rng).killed)
    expect(very).toBeGreaterThan(deadly)
    expect(deadly).toBeGreaterThan(0)
  })

  it('only very_hardy may resist stun', () => {
    const plain = countTrue(40, (rng) => rollStunResist([], COMBAT, rng).resisted)
    const hardy = countTrue(40, (rng) => rollStunResist(['hardy'], COMBAT, rng).resisted)
    const very = countTrue(200, (rng) => rollStunResist(['very_hardy'], COMBAT, rng).resisted)
    expect(plain).toBe(0)
    expect(hardy).toBe(0)
    expect(very).toBeGreaterThan(0)
  })
})

function countTrue(n: number, roll: (rng: ReturnType<Rng['stream']>) => boolean): number {
  let hits = 0
  for (let i = 0; i < n; i += 1) {
    const rng = new Rng((SEED + i * 9973) >>> 0).stream('combat')
    if (roll(rng)) hits += 1
  }
  return hits
}

/* -------------------------------------------------------------------------- */
/* Incapacitation / death / corpse                                             */
/* -------------------------------------------------------------------------- */

describe('incapacitation and death flow', () => {
  it('marks incap below the threshold and death at zero', () => {
    const wound = applyDamage(100, 75, COMBAT)
    expect(wound.outcome).toBe('incapacitated')
    expect(wound.crossedIncap).toBe(true)
    expect(isIncapacitated(wound.healthAfter, COMBAT)).toBe(true)

    const fatal = applyDamage(20, 50, COMBAT)
    expect(fatal.outcome).toBe('dead')
    expect(fatal.healthAfter).toBe(0)
  })

  it('creates a corpse, mortuary job, death count, and hearse on death', () => {
    const { world, events } = makeWorld()
    const a = spawnInmate(world, 4, 4, { inventory: ['kitchen_knife'] })
    const b = spawnInmate(world, 5, 4, { health: 5 })

    beginFight({
      world,
      data: DATA,
      events,
      tick: 0,
      a: { kind: 'inmate', id: a.id },
      b: { kind: 'inmate', id: b.id },
      aWeaponId: 'kitchen_knife',
    })

    runCombat(world, events, TICKS_PER_MINUTE * 5)

    expect(events.of(COMBAT_EVENTS.died).length).toBeGreaterThanOrEqual(1)
    expect(world.contracts.progress.deathCount).toBeGreaterThanOrEqual(1)
    expect(world.combat.corpses.size).toBeGreaterThanOrEqual(1)
    expect(world.inmates.get(b.id)).toBeUndefined()

    const corpse = world.combat.corpses.all()[0]
    expect(corpse).toBeDefined()
    if (corpse === undefined) return
    expect(corpse.state).toBe('on_site')
    expect(corpse.mortuaryJobId).toBeGreaterThan(0)

    const job = world.jobs.get(corpse.mortuaryJobId)
    expect(job).toBeDefined()
    if (job === undefined) return
    // Claim + complete the mortuary pickup so the hearse can be scheduled.
    world.jobs.claim(job.id, 'staff', 1)
    completeJob(world, job.id, events, 0)

    runCombat(world, events, 1)
    expect(events.of(COMBAT_EVENTS.corpseToMortuary).length).toBeGreaterThanOrEqual(1)
    expect(corpse.state).toBe('at_mortuary')

    const wait = COMBAT.hearseDelayMinutes * TICKS_PER_MINUTE + 1
    runCombat(world, events, wait)
    expect(events.of(COMBAT_EVENTS.hearseDeparted).length).toBeGreaterThanOrEqual(1)
    expect(corpse.state).toBe('removed')
  })

  it('queues a clinic escort when an inmate is incapacitated', () => {
    const { world, events } = makeWorld()
    const tile = putFloor(world, 3, 3)
    const roomId = world.rooms.allocateId()
    world.grid.setAt('roomId', tile, roomId)
    world.rooms.set({
      id: roomId,
      defId: 'clinic',
      tiles: [tile],
      bounds: { x: 3, y: 3, width: 1, height: 1 },
      properties: { enclosed: true, indoors: true, outdoors: false, secure: false },
    })
    world.rooms.setStatus({
      roomId,
      defId: 'clinic',
      functional: true,
      requirements: [],
    })

    const a = spawnInmate(world, 8, 8, { inventory: ['fork'] })
    const b = spawnInmate(world, 9, 8, { health: 32 })
    beginFight({
      world,
      data: DATA,
      events,
      tick: 0,
      a: { kind: 'inmate', id: a.id },
      b: { kind: 'inmate', id: b.id },
      aWeaponId: 'fork',
    })
    runCombat(world, events, TICKS_PER_MINUTE * 6)

    expect(events.of(COMBAT_EVENTS.incapacitated).length).toBeGreaterThanOrEqual(1)
    expect(world.escorts.queued().some((job) => job.purpose === 'clinic')).toBe(true)
  })

  it('kills on untreated overdose timer', () => {
    const { world, events } = makeWorld()
    const inmate = spawnInmate(world, 4, 4)
    beginOverdose(world, DATA, inmate.id, 0)
    const ticks = COMBAT.overdose.untreatedDeathMinutes * TICKS_PER_MINUTE + 2
    runCombat(world, events, ticks)
    expect(events.of(COMBAT_EVENTS.overdoseFatal).length).toBe(1)
    expect(world.inmates.get(inmate.id)).toBeUndefined()
    expect(world.contracts.progress.deathCount).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Fights / intervention / LOS                                                 */
/* -------------------------------------------------------------------------- */

describe('fights and intervention', () => {
  it('average fist fight lasts plausible minutes and usually injures rather than kills', () => {
    const durations: number[] = []
    let deaths = 0
    let injuries = 0

    for (let trial = 0; trial < 8; trial += 1) {
      const { world, events } = makeWorld()
      const a = spawnInmate(world, 5, 5)
      const b = spawnInmate(world, 6, 5)
      beginFight({
        world,
        data: DATA,
        events,
        tick: 0,
        a: { kind: 'inmate', id: a.id },
        b: { kind: 'inmate', id: b.id },
      })

      const maxTicks = 180 * TICKS_PER_MINUTE
      const sim = new Simulation({
        seed: (SEED + trial * 17) >>> 0,
        world,
        systems: [createCombatSystem({ data: DATA })],
        events,
      })
      let endedAt = maxTicks
      for (let t = 0; t < maxTicks; t += 1) {
        sim.step()
        if (world.combat.activeFights().length === 0) {
          endedAt = t
          break
        }
        // Cap once someone is incapacitated — fight may still be "active" until
        // both cannot strike; treat incap as the practical end for duration.
        if (
          isIncapacitated(a.inmate.health, COMBAT) ||
          isIncapacitated(b.inmate.health, COMBAT) ||
          a.inmate.health <= 0 ||
          b.inmate.health <= 0
        ) {
          endedAt = t
          break
        }
      }

      const minutes = endedAt / TICKS_PER_MINUTE
      durations.push(minutes)
      if (events.of(COMBAT_EVENTS.died).length > 0) deaths += 1
      if (a.inmate.health < 100 || b.inmate.health < 100) injuries += 1
    }

    const mean = durations.reduce((s, n) => s + n, 0) / durations.length
    expect(mean).toBeGreaterThan(5)
    expect(mean).toBeLessThan(150)
    expect(injuries).toBeGreaterThanOrEqual(6)
    expect(deaths).toBeLessThanOrEqual(2)
  })

  it('officer intervention ends fights and scales with distance', () => {
    const near = interventionTicks(4)
    const far = interventionTicks(20)
    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
  })

  it('blocks ranged shots without line of sight', () => {
    expect(hasLineOfSight(0, 0, 4, 0, (x, y) => x === 2 && y === 0)).toBe(false)
    expect(hasLineOfSight(0, 0, 4, 0, () => false)).toBe(true)

    const { world, events } = makeWorld()
    const a = spawnInmate(world, 2, 2, { inventory: ['pistol'], reputations: [] })
    const b = spawnInmate(world, 8, 2)
    putWall(world, 5, 2)
    beginFight({
      world,
      data: DATA,
      events,
      tick: 0,
      a: { kind: 'inmate', id: a.id },
      b: { kind: 'inmate', id: b.id },
      aWeaponId: 'pistol',
    })
    runCombat(world, events, TICKS_PER_MINUTE * 3)
    // No LOS → no damage events from the pistol.
    expect(events.of(COMBAT_EVENTS.damaged).length).toBe(0)
    expect(b.inmate.health).toBe(100)
  })
})

function interventionTicks(officerDistance: number): number {
  const { world, events } = makeWorld(40)
  const a = spawnInmate(world, 10, 10)
  const b = spawnInmate(world, 11, 10)
  spawnOfficer(world, events, 10 + officerDistance, 10)
  beginFight({
    world,
    data: DATA,
    events,
    tick: 0,
    a: { kind: 'inmate', id: a.id },
    b: { kind: 'inmate', id: b.id },
  })

  const sim = new Simulation({
    seed: SEED,
    world,
    systems: [createCombatSystem({ data: DATA })],
    events,
  })
  const max = 60 * TICKS_PER_MINUTE
  for (let t = 0; t < max; t += 1) {
    sim.step()
    if (events.of(COMBAT_EVENTS.intervention).length > 0) return t
  }
  throw new Error(`officer at distance ${officerDistance} never intervened`)
}

describe('medic heal', () => {
  it('heals nearby injured inmates over time', () => {
    const { world, events } = makeWorld()
    const inmate = spawnInmate(world, 5, 5, { health: 40 })
    inmate.inmate.status.push('bleeding')
    const medicHire = hireStaff({
      world,
      defId: 'medic',
      events,
      tick: 0,
      tx: 5,
      ty: 6,
    })
    expect(medicHire.entity).toBeDefined()
    putFloor(world, 5, 6)

    runCombat(world, events, TICKS_PER_MINUTE * 5)
    expect(inmate.inmate.health).toBeGreaterThan(40)
    expect(events.of(COMBAT_EVENTS.healed).length).toBeGreaterThanOrEqual(1)
  })
})
