/**
 * T4.4 — Misconduct rolls, punishment lifecycle, suppression, agitator boost.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { Rng } from '../../src/core/rng'
import { loadGameData } from '../../src/data/loader'
import {
  applyAutoReclassification,
  applyEntitlementOnMisconduct,
  cellGradeMisconductModifier,
  computeMisconductProbability,
  isMajorMisconduct,
  MISCONDUCT_EVENTS,
} from '../../src/entities/misconduct'
import type { MisconductRollInput } from '../../src/entities/misconduct'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import type { InmateEntity } from '../../src/entities/inmate'
import { NeedIndex } from '../../src/entities/needs'
import { setMisconductOrder } from '../../src/entities/standingOrders'
import { hireStaff } from '../../src/entities/staff'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import { COMBAT_EVENTS } from '../../src/systems/combatSystem'
import {
  MISCONDUCT_SYSTEM_PERIOD,
  commitMisconduct,
  createMisconductSystem,
} from '../../src/systems/misconductSystem'
import {
  PUNISHMENT_SYSTEM_PERIOD,
  beginPunishment,
  createPunishmentSystem,
} from '../../src/systems/punishmentSystem'
import { SEARCH_EVENTS } from '../../src/systems/searchSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'

const DATA = loadGameData()
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_4404

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

function baseRoll(overrides: Partial<MisconductRollInput> = {}): MisconductRollInput {
  return {
    category: 'medium',
    criticalNeedCount: 0,
    cellGradeModifier: 1,
    suppression: 0,
    instigatorNearby: 0,
    guardNearby: false,
    hasViolentTrait: false,
    agitatorBoostMultiplier: 1,
    ...overrides,
  }
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

function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putDoor(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putRoomShell(world: InmateWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) putWall(world, x, y)
      else putFloor(world, x, y)
    }
  }
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1)
}

function interiorOf(rect: Rect): Rect {
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
}

function roomDeps(world: InmateWorld, events: RecordingSink, tick = 0): RoomDeps {
  return { world, data: world.data, events, tick }
}

function objectDeps(world: InmateWorld, events: RecordingSink, tick = 0): ObjectDeps {
  return { world, data: world.data, events, tick }
}

function makeWorld(): InmateWorld {
  return createInmateWorld({ size: 40, data: DATA })
}

function spawnInmate(
  world: InmateWorld,
  events: RecordingSink,
  opts: {
    tx: number
    ty: number
    category?: string
    traits?: string[]
    reputations?: string[]
  } = { tx: 5, ty: 5 },
): InmateEntity {
  const rng = new Rng(SEED)
  const component = generateInmate({
    data: DATA,
    rng: rng.stream('intake'),
    category: opts.category ?? 'medium',
  })
  const traits = opts.traits ?? [...component.traits]
  const reputations =
    opts.reputations !== undefined
      ? opts.reputations.map((id) => ({ id, revealed: true }))
      : [...component.reputations]
  const inmate = {
    ...component,
    traits,
    reputations,
    status: [...component.status],
    needs: new Float32Array(component.needs),
    misconductLog: [] as InmateEntity['inmate']['misconductLog'],
    grades: { punishment: 0, reform: 50, security: 0, health: 100 },
  }
  const id = world.inmates.allocateId()
  const entity = createInmateShell({
    id,
    data: DATA,
    inmate,
    tx: opts.tx,
    ty: opts.ty,
  })
  world.inmates.add(entity)
  void events
  return entity
}

function makeCell(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  putRoomShell(world, shell)
  const interior = interiorOf(shell)
  placeObject(objectDeps(world, events), { x: interior.x, y: interior.y }, 'toilet', 0)
  placeObject(objectDeps(world, events), { x: interior.x + 1, y: interior.y }, 'bed', 0)
  designateRoom(roomDeps(world, events), interior, 'cell')
  const roomId = world.grid.get('roomId', interior.x, interior.y)
  if (roomId === 0) throw new Error('cell designation failed')
  return roomId
}

function makeIsolation(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  putRoomShell(world, shell)
  const interior = interiorOf(shell)
  placeObject(objectDeps(world, events), { x: interior.x, y: interior.y }, 'toilet', 0)
  designateRoom(roomDeps(world, events), interior, 'isolation')
  const roomId = world.grid.get('roomId', interior.x, interior.y)
  if (roomId === 0) throw new Error('isolation designation failed')
  return roomId
}

describe('misconduct roll modifiers (isolated)', () => {
  const misc = DATA.balance.misconduct
  const suppMax = DATA.balance.suppression.max
  const baseline = computeMisconductProbability(misc, suppMax, baseRoll())

  it('critical needs raise probability by the data step', () => {
    const withCritical = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ criticalNeedCount: 5 }),
    )
    expect(withCritical).toBeCloseTo(baseline * (1 + misc.criticalNeedStep * 5), 10)
  })

  it('suppression reduces probability by the PRD factor', () => {
    const suppressed = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ suppression: suppMax }),
    )
    expect(suppressed).toBeCloseTo(baseline * (1 - misc.suppressionFactor), 10)
  })

  it('instigator nearby applies the instigator factor', () => {
    const withInstigator = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ instigatorNearby: 1 }),
    )
    expect(withInstigator).toBeCloseTo(baseline * (1 + misc.instigatorFactor), 10)
  })

  it('guard proximity multiplies by the guard factor', () => {
    const withGuard = computeMisconductProbability(misc, suppMax, baseRoll({ guardNearby: true }))
    expect(withGuard).toBeCloseTo(baseline * misc.guardProximityMultiplier, 10)
  })

  it('violent trait multiplies by the violent factor', () => {
    const violent = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ hasViolentTrait: true }),
    )
    expect(violent).toBeCloseTo(baseline * misc.violentTraitMultiplier, 10)
  })

  it('cell grade modifier clamps to the configured band', () => {
    const high = cellGradeMisconductModifier(misc.cellGrade, 20, 0)
    const low = cellGradeMisconductModifier(misc.cellGrade, 0, 20)
    expect(high).toBe(misc.cellGrade.max)
    expect(low).toBe(misc.cellGrade.min)
    const mid = cellGradeMisconductModifier(misc.cellGrade, 5, 5)
    expect(mid).toBe(1)
    const unclamped = cellGradeMisconductModifier(misc.cellGrade, 6, 5)
    expect(unclamped).toBeCloseTo(1 + misc.cellGrade.perPoint, 10)
  })

  it('agitator boost multiplies on top of the base roll', () => {
    const boosted = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ agitatorBoostMultiplier: misc.agitator.boostFactor }),
    )
    expect(boosted).toBeCloseTo(baseline * misc.agitator.boostFactor, 10)
  })

  it('base rate is near-zero for a calm minimum-security inmate', () => {
    const calm = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ category: 'minimum', criticalNeedCount: 0 }),
    )
    expect(calm).toBeLessThan(0.001)
  })

  it('cutting food (many critical needs) escalates well above the calm baseline', () => {
    const hungry = computeMisconductProbability(
      misc,
      suppMax,
      baseRoll({ category: 'medium', criticalNeedCount: 8 }),
    )
    expect(hungry / baseline).toBeGreaterThan(1.1)
  })
})

describe('entitlement and auto-reclassification', () => {
  it('resets entitlement on major misconduct and reduces on minor', () => {
    expect(isMajorMisconduct(DATA.balance.misconduct, 'destruction')).toBe(true)
    expect(isMajorMisconduct(DATA.balance.misconduct, 'complaint')).toBe(false)
    expect(applyEntitlementOnMisconduct(6, 'destruction', DATA.balance)).toBe(0)
    expect(applyEntitlementOnMisconduct(6, 'complaint', DATA.balance)).toBe(
      6 - DATA.balance.entitlement.minorPenalty,
    )
  })

  it('serious injury bumps the category ladder; homicide forces maximum + years', () => {
    const bump = applyAutoReclassification(
      'minimum',
      'seriousInjury',
      DATA.balance.misconduct,
      DATA.balance.time.hoursPerSentenceYear,
    )
    expect(bump).toEqual({ category: 'medium', sentenceHoursDelta: 0, changed: true })

    const murder = applyAutoReclassification(
      'minimum',
      'homicide',
      DATA.balance.misconduct,
      DATA.balance.time.hoursPerSentenceYear,
    )
    expect(murder.category).toBe('maximum')
    expect(murder.sentenceHoursDelta).toBe(
      DATA.balance.misconduct.homicideSentenceYears * DATA.balance.time.hoursPerSentenceYear,
    )
    expect(murder.changed).toBe(true)
  })
})

describe('punishment lifecycle', () => {
  it('escort-less isolation hold starts, delivers meals, then releases', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const cellId = makeCell(world, events, { x: 2, y: 2, width: 5, height: 5 })
    const isoId = makeIsolation(world, events, { x: 10, y: 2, width: 4, height: 4 })
    expect(cellId).toBeGreaterThan(0)
    expect(isoId).toBeGreaterThan(0)

    const inmate = spawnInmate(world, events, { tx: 5, ty: 5 })
    world.inmates.assignHousing(inmate.id, cellId)
    const cellTile = world.rooms.get(cellId)?.tiles[0]
    if (cellTile !== undefined) {
      const { x, y } = world.grid.xy(cellTile)
      inmate.tx = x
      inmate.ty = y
    }

    setMisconductOrder(world.standingOrders, 'attackInmate', {
      punishment: 'isolation',
      durationHours: 1,
      search: false,
    })

    // Force a meal block this hour so delivery fires.
    world.routines.setCategory(
      inmate.inmate.category,
      Array.from({ length: 24 }, () => 'meal'),
    )

    const foodIndex = INDEX.require('food')
    inmate.inmate.needs[foodIndex] = 80

    beginPunishment({
      world,
      data: DATA,
      events,
      tick: 0,
      inmateId: inmate.id,
      kind: 'isolation',
      sourceMisconduct: 'attackInmate',
      durationHours: 1,
    })

    const hold = world.punishments.get(inmate.id)
    expect(hold?.phase).toBe('holding')
    expect(hold?.kind).toBe('isolation')
    expect(inmate.inmate.cellId).toBe(isoId)
    expect(events.of(MISCONDUCT_EVENTS.punishmentStarted).length).toBe(1)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createPunishmentSystem({ data: DATA, index: INDEX })],
      events,
    })

    // One minute: meal delivery during meal block.
    for (let i = 0; i < PUNISHMENT_SYSTEM_PERIOD; i += 1) sim.step()
    expect(events.of(MISCONDUCT_EVENTS.mealDelivered).length).toBe(1)
    expect(inmate.inmate.needs[foodIndex] ?? 0).toBeLessThan(80)

    // Finish the 60-minute hold.
    for (let i = 0; i < 59; i += 1) {
      for (let t = 0; t < PUNISHMENT_SYSTEM_PERIOD; t += 1) sim.step()
    }
    expect(world.punishments.get(inmate.id)).toBeUndefined()
    expect(events.of(MISCONDUCT_EVENTS.punishmentReleased).length).toBe(1)
    expect(inmate.inmate.cellId).toBe(cellId)
  })

  it('isolation overflow falls back to lockdown', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const cellId = makeCell(world, events, { x: 2, y: 2, width: 5, height: 5 })
    const inmate = spawnInmate(world, events, { tx: 4, ty: 4 })
    world.inmates.assignHousing(inmate.id, cellId)

    beginPunishment({
      world,
      data: DATA,
      events,
      tick: 0,
      inmateId: inmate.id,
      kind: 'isolation',
      sourceMisconduct: 'attackStaff',
      durationHours: 2,
    })

    expect(events.of(MISCONDUCT_EVENTS.isolationOverflow).length).toBe(1)
    expect(world.punishments.get(inmate.id)?.kind).toBe('lockdown')
  })
})

describe('suppression accrual and decay', () => {
  it('accrues in isolation, harms reform, and decays when free', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const cellId = makeCell(world, events, { x: 2, y: 2, width: 5, height: 5 })
    const isoId = makeIsolation(world, events, { x: 10, y: 2, width: 4, height: 4 })
    const inmate = spawnInmate(world, events, { tx: 4, ty: 4, reputations: [] })
    world.inmates.assignHousing(inmate.id, cellId)
    inmate.inmate.grades = { punishment: 0, reform: 50, security: 0, health: 100 }
    inmate.inmate.suppression = 0

    beginPunishment({
      world,
      data: DATA,
      events,
      tick: 0,
      inmateId: inmate.id,
      kind: 'isolation',
      sourceMisconduct: 'attackInmate',
      durationHours: 1,
    })
    expect(inmate.inmate.cellId).toBe(isoId)
    expect(world.punishments.get(inmate.id)?.kind).toBe('isolation')

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createPunishmentSystem({ data: DATA, index: INDEX })],
      events,
    })

    // 15 minutes → +1 isolation suppression point.
    for (let m = 0; m < 15; m += 1) {
      for (let t = 0; t < PUNISHMENT_SYSTEM_PERIOD; t += 1) sim.step()
    }
    expect(inmate.inmate.suppression).toBeGreaterThanOrEqual(1)
    expect(inmate.inmate.grades.reform).toBeLessThan(50)

    // Release remaining hold quickly by zeroing remaining minutes.
    const hold = world.punishments.get(inmate.id)
    expect(hold).toBeDefined()
    if (hold !== undefined) hold.remainingMinutes = 1
    for (let t = 0; t < PUNISHMENT_SYSTEM_PERIOD; t += 1) sim.step()
    expect(world.punishments.get(inmate.id)).toBeUndefined()

    const afterRelease = inmate.inmate.suppression
    // 60 free minutes → decay 1.
    for (let m = 0; m < 60; m += 1) {
      for (let t = 0; t < PUNISHMENT_SYSTEM_PERIOD; t += 1) sim.step()
    }
    expect(inmate.inmate.suppression).toBeLessThanOrEqual(afterRelease - 1 + 0.001)
  })

  it('stoic inmates do not accrue suppression from isolation', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    makeCell(world, events, { x: 2, y: 2, width: 5, height: 5 })
    makeIsolation(world, events, { x: 10, y: 2, width: 4, height: 4 })
    const inmate = spawnInmate(world, events, {
      tx: 4,
      ty: 4,
      reputations: ['stoic'],
    })
    inmate.inmate.suppression = 0

    beginPunishment({
      world,
      data: DATA,
      events,
      tick: 0,
      inmateId: inmate.id,
      kind: 'isolation',
      sourceMisconduct: 'attackInmate',
      durationHours: 1,
    })

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createPunishmentSystem({ data: DATA, index: INDEX })],
      events,
    })
    for (let m = 0; m < 30; m += 1) {
      for (let t = 0; t < PUNISHMENT_SYSTEM_PERIOD; t += 1) sim.step()
    }
    expect(inmate.inmate.suppression).toBe(0)
  })
})

describe('agitator propagation', () => {
  it('boosts neighbours within 5 tiles when an agitator commits misconduct', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const agitator = spawnInmate(world, events, {
      tx: 8,
      ty: 8,
      reputations: ['agitator'],
    })
    const neighbour = spawnInmate(world, events, { tx: 10, ty: 8 })
    const far = spawnInmate(world, events, { tx: 20, ty: 20 })

    commitMisconduct({
      world,
      data: DATA,
      events,
      tick: 0,
      inmateId: agitator.id,
      kind: 'complaint',
    })

    expect(world.punishments.isAgitatorBoosted(neighbour.id, 0)).toBe(true)
    expect(world.punishments.isAgitatorBoosted(far.id, 0)).toBe(false)

    const factor = DATA.balance.misconduct.agitator.boostFactor
    expect(world.punishments.agitatorBoostMultiplier(neighbour.id, 0, factor)).toBe(factor)
  })
})

describe('commitMisconduct integration', () => {
  it('emits CausalEvent, logs rap sheet, applies standing orders, and runs search', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const cellId = makeCell(world, events, { x: 2, y: 2, width: 5, height: 5 })
    const inmate = spawnInmate(world, events, { tx: 4, ty: 4 })
    world.inmates.assignHousing(inmate.id, cellId)
    inmate.inmate.entitlement = 6

    setMisconductOrder(world.standingOrders, 'contraband', {
      punishment: 'lockdown',
      durationHours: 2,
      search: true,
    })

    const rng = new Rng(SEED).stream('search')
    const record = commitMisconduct({
      world,
      data: DATA,
      events,
      tick: 42,
      inmateId: inmate.id,
      kind: 'contraband',
      rng,
      needIndex: INDEX,
    })

    expect(record?.kind).toBe('contraband')
    expect(inmate.inmate.misconductLog).toHaveLength(1)
    expect(inmate.inmate.entitlement).toBe(6 - DATA.balance.entitlement.minorPenalty)
    expect(events.of(MISCONDUCT_EVENTS.committed).length).toBe(1)
    expect(events.of(MISCONDUCT_EVENTS.searchQueued).length).toBe(1)
    expect(events.of(SEARCH_EVENTS.performed).length).toBe(1)
    expect(world.punishments.get(inmate.id)?.kind).toBe('lockdown')
  })

  it('starts a fight when attackInmate finds a neighbour', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const attacker = spawnInmate(world, events, { tx: 5, ty: 5 })
    const victim = spawnInmate(world, events, { tx: 6, ty: 5 })

    setMisconductOrder(world.standingOrders, 'attackInmate', {
      punishment: 'ignore',
      durationHours: 0,
      search: false,
    })

    commitMisconduct({
      world,
      data: DATA,
      events,
      tick: 10,
      inmateId: attacker.id,
      kind: 'attackInmate',
    })

    expect(events.of(COMBAT_EVENTS.fightStarted).length).toBe(1)
    expect(world.combat.fightInvolving('inmate', attacker.id)).toBeDefined()
    expect(world.combat.fightInvolving('inmate', victim.id)).toBeDefined()
  })

  it('starts a fight when attackStaff finds an officer', () => {
    const world = makeWorld()
    const events = new RecordingSink()
    const inmate = spawnInmate(world, events, { tx: 5, ty: 5 })
    const hired = hireStaff({
      world,
      defId: 'officer',
      events,
      tick: 0,
      tx: 6,
      ty: 5,
    })
    expect(hired.entity).toBeDefined()

    setMisconductOrder(world.standingOrders, 'attackStaff', {
      punishment: 'ignore',
      durationHours: 0,
      search: false,
    })

    commitMisconduct({
      world,
      data: DATA,
      events,
      tick: 10,
      inmateId: inmate.id,
      kind: 'attackStaff',
    })

    expect(events.of(COMBAT_EVENTS.fightStarted).length).toBe(1)
    expect(world.combat.fightInvolving('inmate', inmate.id)).toBeDefined()
  })
})

describe('misconduct system period', () => {
  it('registers at the evaluation window', () => {
    expect(MISCONDUCT_SYSTEM_PERIOD).toBe(
      DATA.balance.misconduct.evaluationMinutes * TICKS_PER_MINUTE,
    )
    const system = createMisconductSystem({ data: DATA, index: INDEX })
    expect(system.period).toBe(MISCONDUCT_SYSTEM_PERIOD)
  })
})
