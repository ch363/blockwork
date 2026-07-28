/**
 * T5.6 — intelligence: recruitment eligibility, reveal radius, blow
 * probability and its consequences, and phone-tap reveals.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import {
  INTELLIGENCE_COMMANDS,
  INTELLIGENCE_EVENTS,
  blowChance,
  checkRecruit,
  contrabandByRoom,
  contrabandMarket,
  createIntelligenceSystem,
  informantFear,
  informantLoyalty,
  intelligenceCommandHandlers,
  monitoredBoothRooms,
  revealNearInformants,
  rollBlowAndRetribution,
  runPhoneMonitoring,
} from '../../src/systems/intelligenceSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { Room } from '../../src/world/rooms'

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

const SINK = new RecordingSink()

function world(): InmateWorld {
  return createInmateWorld({ size: 40, data: DATA, continuousIntake: false, research: 'all' })
}

function addInmate(
  target: InmateWorld,
  patch: Partial<{
    traits: string[]
    suppression: number
    health: number
    tx: number
    ty: number
    reputations: { id: string; revealed: boolean }[]
  }> = {},
): number {
  const rng = new Rng(0xb10c_5006).stream('test')
  const component = generateInmate({ data: DATA, rng, category: 'medium' })
  if (patch.traits !== undefined) {
    ;(component as { traits: readonly string[] }).traits = patch.traits
  }
  if (patch.reputations !== undefined) {
    ;(component as unknown as { reputations: { id: string; revealed: boolean }[] }).reputations =
      patch.reputations
  }
  if (patch.suppression !== undefined) component.suppression = patch.suppression
  if (patch.health !== undefined) component.health = patch.health

  const id = target.inmates.allocateId()
  target.inmates.add(
    createInmateShell({
      id,
      data: DATA,
      inmate: component,
      tx: patch.tx ?? 5,
      ty: patch.ty ?? 5,
    }),
  )
  return id
}

/** An inmate who is recruitable: not loyal, and frightened. */
function addTurnableInmate(target: InmateWorld, tx = 5, ty = 5): number {
  target.dangerLevel = 100
  return addInmate(target, {
    traits: ['deceitful'],
    suppression: 100,
    health: 40,
    tx,
    ty,
    reputations: [],
  })
}

function put(target: InmateWorld, x: number, y: number, kind: 'floor' | 'wall' | 'door'): void {
  const index = target.grid.idx(x, y)
  target.grid.setAt('floorMaterial', index, target.materials.indexOf('concrete_floor'))
  target.grid.setAt('outdoors', index, 0)
  target.grid.setAt('owned', index, 1)
  if (kind === 'wall') {
    target.grid.setAt('wallMaterial', index, target.materials.indexOf('brick_wall'))
  }
  if (kind === 'door') {
    target.doors.place(index, 'standard', initialLockState(DATA.doors.get('standard')))
  }
  refreshPassability(target, DATA, index)
  target.structureChanged(index)
}

function makeRoom(
  target: InmateWorld,
  defId: string,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  const left = rect.x - 1
  const top = rect.y - 1
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const onEdge = x === left || y === top || x === right || y === bottom
      if (!onEdge) put(target, x, y, 'floor')
      else if (x === rect.x && y === top) put(target, x, y, 'door')
      else put(target, x, y, 'wall')
    }
  }
  designateRoom({ world: target, data: DATA, events: SINK, tick: 0 }, rect, defId)
  const room = [...target.rooms.all()].find(
    (entry) => entry.defId === defId && entry.bounds.x === rect.x && entry.bounds.y === rect.y,
  )
  if (room === undefined) throw new Error(`room ${defId} was not detected`)
  return room
}

/* -------------------------------------------------------------------------- */
/* Recruitment                                                                 */
/* -------------------------------------------------------------------------- */

describe('intelligence — recruitment eligibility', () => {
  const cfg = DATA.balance.intelligence.recruitment

  it('reads loyalty from the traits that speak to it', () => {
    const target = world()
    const plain = target.inmates.get(addInmate(target, { traits: [] }))
    const loyal = target.inmates.get(addInmate(target, { traits: ['loyal'] }))
    const deceitful = target.inmates.get(addInmate(target, { traits: ['deceitful'] }))

    expect(plain && informantLoyalty(cfg, plain)).toBeCloseTo(cfg.baseLoyalty, 6)
    expect(loyal && informantLoyalty(cfg, loyal)).toBeCloseTo(
      Math.min(100, cfg.baseLoyalty + cfg.loyalTraitBonus),
      6,
    )
    expect(deceitful && informantLoyalty(cfg, deceitful)).toBeCloseTo(
      cfg.baseLoyalty - cfg.deceitfulTraitPenalty,
      6,
    )
  })

  it('reads fear from suppression, danger and injury', () => {
    const target = world()
    const calm = target.inmates.get(addInmate(target, { suppression: 0, health: 100 }))
    const crushed = target.inmates.get(addInmate(target, { suppression: 100, health: 100 }))
    const hurt = target.inmates.get(addInmate(target, { suppression: 0, health: 0 }))

    expect(calm && informantFear(cfg, calm, 0)).toBe(0)
    expect(crushed && informantFear(cfg, crushed, 0)).toBeCloseTo(100 * cfg.fearFromSuppression, 6)
    expect(hurt && informantFear(cfg, hurt, 0)).toBeCloseTo(100 * cfg.fearFromInjury, 6)
    expect(calm && informantFear(cfg, calm, 100)).toBeCloseTo(100 * cfg.fearFromDanger, 6)
  })

  it('refuses a loyal inmate and an unafraid one, and accepts the pair in between', () => {
    const target = world()
    target.dangerLevel = 100

    const loyal = target.inmates.get(
      addInmate(target, { traits: ['loyal'], suppression: 100, health: 20 }),
    )
    expect(loyal && checkRecruit(target, DATA, loyal).reason).toBe('too-loyal')

    const unafraid = target.inmates.get(addInmate(target, { traits: ['deceitful'] }))
    if (unafraid !== undefined) {
      // Fear needs the prison to be frightening; take the danger away.
      target.dangerLevel = 0
      unafraid.inmate.suppression = 0
      unafraid.inmate.health = 100
      expect(checkRecruit(target, DATA, unafraid).reason).toBe('not-afraid-enough')
      target.dangerLevel = 100
    }

    const turnable = target.inmates.get(addTurnableInmate(target))
    expect(turnable && checkRecruit(target, DATA, turnable).ok).toBe(true)
  })

  it('refuses a second recruitment of the same inmate, and a full roster', () => {
    const target = world()
    const id = addTurnableInmate(target)
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    target.intelligence.informants.set(id, {
      inmateId: id,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })
    expect(checkRecruit(target, DATA, entity).reason).toBe('already-informant')

    target.intelligence.informants.delete(id)
    for (let i = 0; i < DATA.balance.intelligence.maxInformants; i += 1) {
      target.intelligence.informants.set(1000 + i, {
        inmateId: 1000 + i,
        recruitedTick: 0,
        blown: false,
        blownTick: 0,
        carelesslyHandled: false,
        revealCount: 0,
      })
    }
    expect(checkRecruit(target, DATA, entity).reason).toBe('roster-full')
  })

  it('needs the Intelligence node before anyone can be turned', () => {
    const target = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    target.dangerLevel = 100
    const id = addTurnableInmate(target)
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: target,
      commandHandlers: intelligenceCommandHandlers(DATA),
      events,
    })

    const recruit = {
      type: INTELLIGENCE_COMMANDS.recruit,
      issuedAtTick: 0,
      payload: { inmateId: id },
    }
    sim.enqueue(recruit)
    sim.step()
    expect(events.reasons(INTELLIGENCE_EVENTS.rejected)).toContain('feature-locked')
    expect(target.intelligence.informants.size).toBe(0)

    target.directorate.grant('intelligence')
    sim.enqueue(recruit)
    sim.step()
    expect(target.intelligence.informants.has(id)).toBe(true)
    expect(events.of(INTELLIGENCE_EVENTS.recruited)).toHaveLength(1)
  })

  it('charges the recruitment fee', () => {
    const target = world()
    const id = addTurnableInmate(target)
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: target,
      commandHandlers: intelligenceCommandHandlers(DATA),
      events,
    })

    const before = target.economy.balance
    sim.enqueue({
      type: INTELLIGENCE_COMMANDS.recruit,
      issuedAtTick: 0,
      payload: { inmateId: id },
    })
    sim.step()
    expect(target.economy.balance).toBe(before - DATA.balance.intelligence.recruitCost)
  })
})

/* -------------------------------------------------------------------------- */
/* Reveal radius                                                               */
/* -------------------------------------------------------------------------- */

describe('intelligence — the reveal radius', () => {
  it('surfaces stashes inside the radius and nothing outside it', () => {
    const target = world()
    const events = new RecordingSink()
    const radius = DATA.balance.intelligence.revealRadiusTiles

    const informantId = addTurnableInmate(target, 10, 10)
    target.intelligence.informants.set(informantId, {
      inmateId: informantId,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })

    const near = target.contraband.addStash(target.grid.idx(10 + radius, 10), 'shiv', 0)
    const far = target.contraband.addStash(target.grid.idx(10 + radius + 1, 10), 'shiv', 0)

    revealNearInformants(target, DATA, events, 0)

    expect(target.intelligence.revealedStashIds.has(near.id)).toBe(true)
    expect(target.intelligence.revealedStashIds.has(far.id)).toBe(false)
  })

  it('surfaces arranged throw-ins and hidden reputations nearby', () => {
    const target = world()
    const events = new RecordingSink()
    const informantId = addTurnableInmate(target, 10, 10)
    target.intelligence.informants.set(informantId, {
      inmateId: informantId,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })

    const neighbourId = addInmate(target, {
      tx: 11,
      ty: 10,
      reputations: [{ id: 'notorious', revealed: false }],
    })
    const throwIn = target.contraband.addThrowIn({
      inmateId: neighbourId,
      itemId: 'shiv',
      tileIndex: target.grid.idx(12, 10),
      collectTick: 100,
    })

    revealNearInformants(target, DATA, events, 0)

    expect(target.intelligence.revealedThrowInIds.has(throwIn.id)).toBe(true)
    expect(target.inmates.get(neighbourId)?.inmate.reputations[0]?.revealed).toBe(true)
  })

  it('reveals nothing once the informant is blown', () => {
    const target = world()
    const events = new RecordingSink()
    const informantId = addTurnableInmate(target, 10, 10)
    target.intelligence.informants.set(informantId, {
      inmateId: informantId,
      recruitedTick: 0,
      blown: true,
      blownTick: 10,
      carelesslyHandled: false,
      revealCount: 0,
    })
    target.contraband.addStash(target.grid.idx(11, 10), 'shiv', 0)

    expect(revealNearInformants(target, DATA, events, 0)).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Being blown                                                                 */
/* -------------------------------------------------------------------------- */

describe('intelligence — blow probability and consequences', () => {
  it('raises the blow chance when the informant was summoned in the open', () => {
    const balance = DATA.balance.intelligence
    const careful = {
      inmateId: 1,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    }
    const careless = { ...careful, carelesslyHandled: true }

    expect(blowChance(balance, careful)).toBeCloseTo(balance.blowChancePerDay, 6)
    expect(blowChance(balance, careless)).toBeCloseTo(
      balance.blowChancePerDay + balance.carelessSummonBlowBonus,
      6,
    )
  })

  it('marks a careless summon through the command, and clears it after the roll', () => {
    const target = world()
    const id = addTurnableInmate(target)
    target.intelligence.informants.set(id, {
      inmateId: id,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })

    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: target,
      commandHandlers: intelligenceCommandHandlers(DATA),
      events,
    })
    sim.enqueue({
      type: INTELLIGENCE_COMMANDS.summon,
      issuedAtTick: 0,
      payload: { inmateId: id, inTheOpen: true },
    })
    sim.step()
    expect(target.intelligence.informants.get(id)?.carelesslyHandled).toBe(true)

    const neverBlows = { chance: () => false, next: () => 1 } as never
    rollBlowAndRetribution(target, DATA, events, neverBlows, TICKS_PER_DAY)
    expect(target.intelligence.informants.get(id)?.carelesslyHandled).toBe(false)
  })

  it('turns a blown informant into a murder target', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addTurnableInmate(target)
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')
    entity.inmate.health = 100

    target.intelligence.informants.set(id, {
      inmateId: id,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })

    const alwaysBlows = { chance: () => true, next: () => 0 } as never

    // Day one: blown. Nothing else happens yet.
    const first = rollBlowAndRetribution(target, DATA, events, alwaysBlows, TICKS_PER_DAY)
    expect(first.blown).toBe(1)
    expect(events.of(INTELLIGENCE_EVENTS.blown)).toHaveLength(1)
    expect(entity.inmate.health).toBe(100)

    // Day two: the wing comes for them.
    const second = rollBlowAndRetribution(target, DATA, events, alwaysBlows, 2 * TICKS_PER_DAY)
    expect(second.attempts).toBe(1)
    expect(entity.inmate.health).toBeLessThan(100)
    expect(events.of(INTELLIGENCE_EVENTS.assassinationAttempt)).toHaveLength(1)
  })

  it('rolls at most once a day', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addTurnableInmate(target)
    target.intelligence.informants.set(id, {
      inmateId: id,
      recruitedTick: 0,
      blown: false,
      blownTick: 0,
      carelesslyHandled: false,
      revealCount: 0,
    })
    const alwaysBlows = { chance: () => true, next: () => 0 } as never

    expect(rollBlowAndRetribution(target, DATA, events, alwaysBlows, TICKS_PER_DAY).blown).toBe(1)
    expect(
      rollBlowAndRetribution(target, DATA, events, alwaysBlows, TICKS_PER_DAY + 10).blown,
    ).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Phone monitoring                                                            */
/* -------------------------------------------------------------------------- */

describe('intelligence — phone monitoring', () => {
  it('counts a booth as monitored only when a tap shares its room', () => {
    const target = world()
    const events = new RecordingSink()
    const room = makeRoom(target, 'dayroom', { x: 2, y: 2, width: 6, height: 6 })
    const deps = { world: target, data: DATA, events, tick: 0 }

    placeObject(deps, { x: 3, y: 3 }, 'phone_booth')
    expect(monitoredBoothRooms(target).has(room.id)).toBe(false)

    placeObject(deps, { x: 5, y: 3 }, 'phone_tap')
    expect(monitoredBoothRooms(target).has(room.id)).toBe(true)
  })

  it("reveals a caller's throw-in and reputations from a tapped booth", () => {
    const target = world()
    const events = new RecordingSink()
    makeRoom(target, 'dayroom', { x: 2, y: 2, width: 6, height: 6 })
    const deps = { world: target, data: DATA, events, tick: 0 }
    placeObject(deps, { x: 3, y: 3 }, 'phone_booth')
    placeObject(deps, { x: 5, y: 3 }, 'phone_tap')

    const callerId = addInmate(target, {
      tx: 4,
      ty: 4,
      reputations: [{ id: 'supplier', revealed: false }],
    })
    const throwIn = target.contraband.addThrowIn({
      inmateId: callerId,
      itemId: 'shiv',
      tileIndex: target.grid.idx(20, 20),
      collectTick: 100,
    })

    const alwaysHears = { chance: () => true, next: () => 0 } as never
    expect(runPhoneMonitoring(target, DATA, events, alwaysHears, 0)).toBeGreaterThan(0)

    expect(target.intelligence.revealedThrowInIds.has(throwIn.id)).toBe(true)
    expect(target.inmates.get(callerId)?.inmate.reputations[0]?.revealed).toBe(true)
    expect(events.of(INTELLIGENCE_EVENTS.phoneTapReveal).length).toBeGreaterThan(0)
  })

  it('reveals nothing from an untapped booth', () => {
    const target = world()
    const events = new RecordingSink()
    makeRoom(target, 'dayroom', { x: 2, y: 2, width: 6, height: 6 })
    placeObject({ world: target, data: DATA, events, tick: 0 }, { x: 3, y: 3 }, 'phone_booth')
    addInmate(target, { tx: 4, ty: 4, reputations: [{ id: 'supplier', revealed: false }] })

    const alwaysHears = { chance: () => true, next: () => 0 } as never
    expect(runPhoneMonitoring(target, DATA, events, alwaysHears, 0)).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* The panel's model                                                           */
/* -------------------------------------------------------------------------- */

describe('intelligence — the panel model', () => {
  it('reports contraband by room, seen against actual', () => {
    const target = world()
    const events = new RecordingSink()
    const room = makeRoom(target, 'dayroom', { x: 2, y: 2, width: 6, height: 6 })
    expect(events.events.length).toBeGreaterThanOrEqual(0)

    const seen = target.contraband.addStash(target.grid.idx(3, 3), 'shiv', 0)
    target.contraband.addStash(target.grid.idx(4, 3), 'shiv', 0)
    target.intelligence.revealedStashIds.add(seen.id)

    const rows = contrabandByRoom(target)
    const row = rows.find((entry) => entry.roomId === room.id)
    expect(row?.actualStashes).toBe(2)
    expect(row?.revealedStashes).toBe(1)
  })

  it('reports a live price, supply and demand row per contraband item', () => {
    const target = world()
    const id = addInmate(target)
    const entity = target.inmates.get(id)
    entity?.inmate.inventory.push('shiv')
    target.contraband.addStash(target.grid.idx(3, 3), 'shiv', 0)
    target.contraband.prices.set('shiv', 99)

    const rows = contrabandMarket(target, DATA)
    expect(rows).toHaveLength(DATA.contraband.size)
    const shank = rows.find((row) => row.itemId === 'shiv')
    expect(shank?.price).toBe(99)
    expect(shank?.supply).toBe(2)
    expect(shank?.demand).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Acceptance                                                                  */
/* -------------------------------------------------------------------------- */

describe('T5.6 acceptance', () => {
  it('three informants cut contraband circulation, and losing one draws blood', () => {
    const target = world()
    const events = new RecordingSink()
    const radius = DATA.balance.intelligence.revealRadiusTiles

    // Three informants spread across the map, each with stashes in reach.
    const positions: readonly (readonly [number, number])[] = [
      [6, 6],
      [20, 6],
      [6, 20],
    ]
    for (const [x, y] of positions) {
      const id = addTurnableInmate(target, x, y)
      target.intelligence.informants.set(id, {
        inmateId: id,
        recruitedTick: 0,
        blown: false,
        blownTick: 0,
        carelesslyHandled: false,
        revealCount: 0,
      })
      for (let i = 0; i < 3; i += 1) {
        target.contraband.addStash(target.grid.idx(x + i, y + 1), 'shiv', 0)
      }
    }
    // And some the informants cannot see.
    for (let i = 0; i < 3; i += 1) {
      target.contraband.addStash(target.grid.idx(35, 35 - i), 'shiv', 0)
    }

    revealNearInformants(target, DATA, events, 0)

    const total = target.contraband.stashes.length
    const seen = target.intelligence.revealedStashIds.size
    expect(seen).toBe(9)
    expect(seen / total).toBeGreaterThan(0.5)
    expect(seen).toBeLessThan(total)
    expect(radius).toBeGreaterThan(0)

    // Losing one produces a murder attempt.
    const victimId = target.intelligence.roster()[0]?.inmateId ?? 0
    const victim = target.inmates.get(victimId)
    if (victim === undefined) throw new Error('informant missing')
    victim.inmate.health = 100
    const informant = target.intelligence.informants.get(victimId)
    if (informant !== undefined) informant.blown = true

    const alwaysStrikes = { chance: () => true, next: () => 0 } as never
    const result = rollBlowAndRetribution(target, DATA, events, alwaysStrikes, TICKS_PER_DAY)
    expect(result.attempts).toBeGreaterThan(0)
    expect(victim.inmate.health).toBeLessThan(100)
  })

  it('runs inside a simulation and reports a world it cannot read', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      systems: [createIntelligenceSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_MINUTE * DATA.balance.intelligence.passMinutes; i += 1) {
      sim.step()
    }
    expect(events.reasons(INTELLIGENCE_EVENTS.rejected)).toContain('wrong-world')
  })
})
