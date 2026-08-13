/**
 * T5.2 — room grading, the entitlement ladder, and the hourly reassignment.
 *
 * Covers every grading rule type against fixtures, entitlement accrual and
 * reset, reassignment ordering, and the misconduct modifier formula the grades
 * feed.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { Registry, loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import type { RoomDef } from '../../src/data/schemas'
import {
  applyEntitlementOnMisconduct,
  cellGradeMisconductModifier,
} from '../../src/entities/misconduct'
import { generateInmate, createInmateShell } from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import {
  GRADING_EVENTS,
  accrueEntitlement,
  createGradingSystem,
  entitlementMatches,
  gradeRoom,
  reassignHousing,
  regradeRooms,
} from '../../src/systems/gradingSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { designateRoom } from '../../src/world/roomDetection'
import { initialLockState } from '../../src/world/doors'
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
}

/** Replaces one room definition, so a rule type can be tested in isolation. */
function withRoom(base: GameData, patch: RoomDef): GameData {
  const all = base.rooms.all.map((def) => (def.id === patch.id ? patch : def))
  return { ...base, rooms: new Registry(all) }
}

function floorRect(
  world: InmateWorld,
  x: number,
  y: number,
  w: number,
  h: number,
  materialId = 'concrete_floor',
): void {
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const index = world.grid.idx(x + dx, y + dy)
      world.grid.setAt('floorMaterial', index, world.materials.indexOf(materialId))
      world.grid.setAt('outdoors', index, 0)
      world.grid.setAt('owned', index, 1)
      refreshPassability(world, world.data, index)
    }
  }
}

function putWall(world: InmateWorld, x: number, y: number): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
}

function putDoor(world: InmateWorld, x: number, y: number): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  world.grid.setAt('wallMaterial', index, 0)
  world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
}

/**
 * Designates `rect` as `defId` and rings it with a walled shell and one door.
 *
 * `rect` is the room itself — the walls go *outside* it — so a test can state
 * the interior it wants to grade and leave the shell to the helper.
 * `enclosed` and `indoors` are room requirements, so without the shell nothing
 * is `functional` and the reassignment pass has nowhere to send anyone.
 */
function makeRoom(
  world: InmateWorld,
  data: GameData,
  defId: string,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  const events = new RecordingSink()
  const left = rect.x - 1
  const top = rect.y - 1
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const onEdge = x === left || y === top || x === right || y === bottom
      if (!onEdge) {
        floorRect(world, x, y, 1, 1)
        continue
      }
      if (x === rect.x && y === top) putDoor(world, x, y)
      else putWall(world, x, y)
    }
  }

  designateRoom({ world, data, events, tick: 0 }, rect, defId)
  const room = [...world.rooms.all()].find((entry) => entry.defId === defId && covers(entry, rect))
  if (room === undefined) throw new Error(`room ${defId} was not detected`)
  return room
}

function covers(room: Room, rect: { x: number; y: number }): boolean {
  return room.bounds.x === rect.x && room.bounds.y === rect.y
}

function addInmate(
  world: InmateWorld,
  data: GameData,
  options: {
    readonly entitlement?: number
    readonly category?: string
    readonly tile?: number
  } = {},
): number {
  const rng = {
    next: () => 0.5,
    nextInt: (lo: number) => lo,
    nextUint32: () => 7,
    chance: () => false,
  }
  const component = generateInmate({
    data,
    // Deterministic stub stream: generation only needs a source of draws here.
    rng: rng as unknown as Parameters<typeof generateInmate>[0]['rng'],
    category: options.category ?? 'medium',
  })
  component.entitlement = options.entitlement ?? data.balance.entitlement.start
  const id = world.inmates.allocateId()
  const shell = createInmateShell({ id, data, inmate: component, tx: 1, ty: 1 })
  world.inmates.add(shell)
  return id
}

/* -------------------------------------------------------------------------- */
/* Rule types                                                                  */
/* -------------------------------------------------------------------------- */

describe('grading — every rule type', () => {
  it('scores a plain object rule once, however many are present', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }

    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')
    placeObject(deps, { x: 5, y: 3 }, 'comfort_bed')

    const def = DATA.rooms.get('cell')
    const grade = gradeRoom(world, DATA, room, def)
    const bedLine = grade?.lines.find((line) => line.subject === 'comfort_bed')
    expect(bedLine?.points).toBe(1)
    expect(bedLine?.found).toBe(2)
  })

  it('scores a perCount rule once per full group', () => {
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'dayroom', { x: 2, y: 2, width: 7, height: 6 })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }

    // computer_station scores 2 per 4. Three is not a group; four is.
    for (let i = 0; i < 3; i += 1) placeObject(deps, { x: 3 + i, y: 3 }, 'computer_station')
    expect(
      gradeRoom(world, DATA, room, DATA.rooms.get('dayroom'))?.lines.find(
        (line) => line.subject === 'computer_station',
      ),
    ).toBeUndefined()

    placeObject(deps, { x: 6, y: 3 }, 'computer_station')
    const line = gradeRoom(world, DATA, room, DATA.rooms.get('dayroom'))?.lines.find(
      (entry) => entry.subject === 'computer_station',
    )
    expect(line?.points).toBe(2)
    expect(line?.found).toBe(4)
    expect(line?.needed).toBe(4)
  })

  it('scales a perOccupants rule with the heads in the room', () => {
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'dormitory', { x: 2, y: 2, width: 8, height: 6 })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')

    // Empty: one bed satisfies the "one per four" rule.
    expect(
      gradeRoom(world, DATA, room, DATA.rooms.get('dormitory'))?.lines.find(
        (line) => line.subject === 'comfort_bed',
      )?.points,
    ).toBe(1)

    // Five heads need two.
    for (let i = 0; i < 5; i += 1) {
      const id = addInmate(world, DATA)
      world.inmates.assignHousing(id, room.id)
    }
    const line = gradeRoom(world, DATA, room, DATA.rooms.get('dormitory'))?.lines.find(
      (entry) => entry.subject === 'comfort_bed',
    )
    expect(line).toBeUndefined()

    placeObject(deps, { x: 5, y: 3 }, 'comfort_bed')
    const after = gradeRoom(world, DATA, room, DATA.rooms.get('dormitory'))?.lines.find(
      (entry) => entry.subject === 'comfort_bed',
    )
    expect(after?.points).toBe(1)
    expect(after?.needed).toBe(2)
  })

  it('takes the highest size threshold the room clears, not their sum', () => {
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    // 4×4 = 16 tiles clears all three cell thresholds (6, 9, 16).
    const room = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const size = gradeRoom(world, DATA, room, DATA.rooms.get('cell'))?.lines.find(
      (line) => line.rule === 'size',
    )
    expect(size?.points).toBe(3)
    expect(size?.needed).toBe(16)
  })

  it('penalises a room with no window and rewards an outdoor-facing one', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })

    const none = gradeRoom(world, DATA, room, DATA.rooms.get('cell'))?.lines.find(
      (line) => line.rule === 'window',
    )
    expect(none?.points).toBe(-1)

    // A wall tile on the room's edge, with open sky the other side.
    const wallTile = { x: 2, y: 1 }
    const index = world.grid.idx(wallTile.x, wallTile.y)
    world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
    refreshPassability(world, DATA, index)
    placeObject({ world, data: DATA, events: new RecordingSink(), tick: 0 }, wallTile, 'window')

    const bonus = gradeRoom(world, DATA, room, DATA.rooms.get('cell'))?.lines.find(
      (line) => line.rule === 'window',
    )
    expect(bonus?.points).toBe(2)
  })

  it('penalises depressing materials by the tiles they cover', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    floorRect(world, 2, 2, 2, 2, 'churned_mud')

    const line = gradeRoom(world, DATA, room, DATA.rooms.get('cell'))?.lines.find(
      (entry) => entry.rule === 'material',
    )
    expect(line?.points).toBe(-1)
    expect(line?.found).toBe(4)
  })

  it('scores the named custom rules from Standing Orders and room shape', () => {
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const mess = makeRoom(world, DATA, 'mess_hall', { x: 2, y: 2, width: 8, height: 6 })

    world.standingOrders.mealQuantity = 'high'
    world.standingOrders.mealVariety = 5
    const lines = gradeRoom(world, DATA, mess, DATA.rooms.get('mess_hall'))?.lines ?? []
    expect(lines.find((line) => line.subject === 'meal_quality')?.points).toBe(1)
    expect(lines.find((line) => line.subject === 'meal_variety')?.points).toBe(2)

    world.standingOrders.mealQuantity = 'low'
    world.standingOrders.mealVariety = 1
    const lean = gradeRoom(world, DATA, mess, DATA.rooms.get('mess_hall'))?.lines ?? []
    expect(lean.find((line) => line.subject === 'meal_quality')?.points).toBe(-1)
    expect(lean.find((line) => line.subject === 'meal_variety')).toBeUndefined()

    const yard = makeRoom(world, DATA, 'exercise_yard', { x: 14, y: 2, width: 14, height: 12 })
    const track = gradeRoom(world, DATA, yard, DATA.rooms.get('exercise_yard'))?.lines.find(
      (line) => line.subject === 'running_track_length',
    )
    // 2 * (14 + 12) - 4 = 48 tiles of perimeter, over the 24 threshold.
    expect(track?.points).toBe(1)
    expect(track?.found).toBe(48)
  })

  it('clamps the published score to the rule set range and keeps the raw sum', () => {
    const cell = DATA.rooms.get('cell')
    const capped = withRoom(DATA, {
      ...cell,
      gradingRules: {
        ...(cell.gradingRules ?? { min: 0, max: 10, objectPoints: [], sizeThresholds: [] }),
        max: 2,
      },
    })
    const world = createInmateWorld({
      size: 24,
      data: capped,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, capped, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const deps = { world, data: capped, events: new RecordingSink(), tick: 0 }
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')
    placeObject(deps, { x: 4, y: 3 }, 'bedside_cabinet')

    const grade = gradeRoom(world, capped, room, capped.rooms.get('cell'))
    expect(grade?.score).toBe(2)
    expect(grade?.rawScore).toBeGreaterThan(2)
  })

  it('sums the lines to the raw score, so the breakdown can never disagree', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')
    placeObject(deps, { x: 4, y: 3 }, 'bookshelf')

    const grade = gradeRoom(world, DATA, room, DATA.rooms.get('cell'))
    const sum = (grade?.lines ?? []).reduce((total, line) => total + line.points, 0)
    expect(sum).toBe(grade?.rawScore)
  })
})

/* -------------------------------------------------------------------------- */
/* Entitlement                                                                 */
/* -------------------------------------------------------------------------- */

describe('grading — the entitlement ladder', () => {
  it('grants one point per clean day, capped at the ladder top', () => {
    const world = createInmateWorld({
      size: 16,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const id = addInmate(world, DATA, { entitlement: 2 })
    const inmate = world.inmates.get(id)

    // Nothing before a full day has passed.
    accrueEntitlement(world, DATA, events, TICKS_PER_HOUR * 12)
    expect(inmate?.inmate.entitlement).toBe(2)

    accrueEntitlement(world, DATA, events, TICKS_PER_DAY)
    expect(inmate?.inmate.entitlement).toBe(3)
    expect(events.of(GRADING_EVENTS.entitlementGained)).toHaveLength(1)

    // A second grant needs another whole day, not another hour.
    accrueEntitlement(world, DATA, events, TICKS_PER_DAY + TICKS_PER_HOUR)
    expect(inmate?.inmate.entitlement).toBe(3)

    accrueEntitlement(world, DATA, events, 2 * TICKS_PER_DAY)
    expect(inmate?.inmate.entitlement).toBe(4)

    // Run it out to the cap and confirm it stops there.
    for (let day = 3; day < 20; day += 1) {
      accrueEntitlement(world, DATA, events, day * TICKS_PER_DAY)
    }
    expect(inmate?.inmate.entitlement).toBe(DATA.balance.entitlement.max)
  })

  it('withholds the point while the last misconduct is less than a day old', () => {
    const world = createInmateWorld({
      size: 16,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const id = addInmate(world, DATA, { entitlement: 2 })
    const inmate = world.inmates.get(id)
    inmate?.inmate.misconductLog.push({
      tick: TICKS_PER_DAY,
      kind: 'complaint',
      punishment: 'ignore',
      durationHours: 0,
    })

    accrueEntitlement(world, DATA, events, TICKS_PER_DAY + TICKS_PER_HOUR)
    expect(inmate?.inmate.entitlement).toBe(2)

    accrueEntitlement(world, DATA, events, 2 * TICKS_PER_DAY + 1)
    expect(inmate?.inmate.entitlement).toBe(3)
  })
})

/* -------------------------------------------------------------------------- */
/* Reassignment                                                                */
/* -------------------------------------------------------------------------- */

describe('grading — reassignment', () => {
  it('matches strictly, leniently, or not at all, per Standing Orders', () => {
    const balance = DATA.balance.grading
    expect(entitlementMatches('strict', 5, 5, balance)).toBe(true)
    expect(entitlementMatches('strict', 5, 6, balance)).toBe(false)
    expect(entitlementMatches('lenient', 5, 7, balance)).toBe(true)
    expect(entitlementMatches('lenient', 5, 8, balance)).toBe(false)
    expect(entitlementMatches('off', 0, 10, balance)).toBe(true)
  })

  it('serves the best-behaved inmate first and queues an escort for each move', () => {
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const deps = { world, data: DATA, events, tick: 0 }

    // A good cell and a bare one, both functional.
    const good = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const bare = makeRoom(world, DATA, 'cell', { x: 12, y: 2, width: 3, height: 3 })
    for (const [room, x] of [
      [good, 3],
      [bare, 13],
    ] as const) {
      expect(room.id).toBeGreaterThan(0)
      placeObject(deps, { x, y: 3 }, 'bed')
      placeObject(deps, { x: x + 1, y: 3 }, 'toilet')
    }
    placeObject(deps, { x: 4, y: 4 }, 'bedside_cabinet')
    placeObject(deps, { x: 5, y: 4 }, 'bookshelf')

    world.standingOrders.reassignmentStrictness = 'lenient'
    regradeRooms(world, DATA)

    const goodGrade = world.grading.breakdowns.get(good.id)?.score ?? 0
    const bareGrade = world.grading.breakdowns.get(bare.id)?.score ?? 0
    expect(goodGrade).toBeGreaterThan(bareGrade)

    const meek = addInmate(world, DATA, { entitlement: goodGrade })
    const rowdy = addInmate(world, DATA, { entitlement: 0 })

    const moves = reassignHousing(world, DATA, events, 0)
    expect(moves).toBeGreaterThan(0)

    // The high-entitlement inmate took the good cell.
    expect(world.inmates.get(meek)?.inmate.cellId).toBe(good.id)
    expect(world.inmates.get(rowdy)?.inmate.cellId).not.toBe(good.id)

    // Every move is an escort, not a teleport.
    expect(world.escorts.queued().length).toBe(moves)
    expect(events.of(GRADING_EVENTS.reassigned)).toHaveLength(moves)
  })

  it('does nothing at all when strictness is off', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    addInmate(world, DATA, { entitlement: 5 })

    world.standingOrders.reassignmentStrictness = 'off'
    regradeRooms(world, DATA)
    expect(reassignHousing(world, DATA, events, 0)).toBe(0)
  })

  it('caps the escorts one pass may queue', () => {
    const world = createInmateWorld({
      size: 60,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const deps = { world, data: DATA, events, tick: 0 }

    const budget = DATA.balance.grading.reassignment.maxEscortsPerPass
    for (let i = 0; i < budget + 6; i += 1) {
      const x = 2 + (i % 10) * 5
      const y = 2 + Math.floor(i / 10) * 5
      makeRoom(world, DATA, 'cell', { x, y, width: 4, height: 4 })
      placeObject(deps, { x: x + 1, y: y + 1 }, 'bed')
      placeObject(deps, { x: x + 2, y: y + 1 }, 'toilet')
      addInmate(world, DATA, { entitlement: 2 })
    }

    world.standingOrders.reassignmentStrictness = 'lenient'
    regradeRooms(world, DATA)
    expect(reassignHousing(world, DATA, events, 0)).toBeLessThanOrEqual(budget)
  })

  it('refuses a cell in a sector that bars the inmate category', () => {
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const deps = { world, data: DATA, events, tick: 0 }

    const cell = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    placeObject(deps, { x: 3, y: 3 }, 'bed')
    placeObject(deps, { x: 4, y: 3 }, 'toilet')

    // Paint the cell into a sector that only admits maximum-security inmates.
    const sector = world.sectors.create(DATA, {
      name: 'Max block',
      access: 'secure',
      categories: ['maximum'],
    })
    expect(sector).toBeDefined()
    world.sectors.paintTiles(world.grid, cell.tiles, sector?.id ?? 0)
    world.sectors.reindex(DATA, world.grid)

    const id = addInmate(world, DATA, { entitlement: 2, category: 'minimum' })
    world.standingOrders.reassignmentStrictness = 'off'
    regradeRooms(world, DATA)
    world.standingOrders.reassignmentStrictness = 'lenient'

    reassignHousing(world, DATA, events, 0)
    expect(world.inmates.get(id)?.inmate.cellId).not.toBe(cell.id)
  })
})

/* -------------------------------------------------------------------------- */
/* Publication + the misconduct modifier                                       */
/* -------------------------------------------------------------------------- */

describe('grading — what the rest of the prison reads', () => {
  it('publishes cell grades and the prison average for the misconduct roll', () => {
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }

    const good = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const bare = makeRoom(world, DATA, 'cell', { x: 12, y: 2, width: 3, height: 3 })
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')
    placeObject(deps, { x: 4, y: 3 }, 'bookshelf')
    placeObject(deps, { x: 5, y: 3 }, 'television')

    regradeRooms(world, DATA)

    const goodGrade = world.cellGrades.get(good.id) ?? 0
    const bareGrade = world.cellGrades.get(bare.id) ?? 0
    expect(goodGrade).toBeGreaterThan(bareGrade)
    expect(world.averageCellGrade).toBeCloseTo((goodGrade + bareGrade) / 2, 6)
  })

  it('turns a cell below the prison average into a higher misconduct chance', () => {
    const cfg = DATA.balance.misconduct.cellGrade

    // PRD 5.2: 1 + perPoint * (avgGrade - cellGrade), clamped.
    expect(cellGradeMisconductModifier(cfg, 5, 5)).toBe(1)
    expect(cellGradeMisconductModifier(cfg, 5, 2)).toBeCloseTo(1 + cfg.perPoint * 3, 6)
    expect(cellGradeMisconductModifier(cfg, 5, 8)).toBeCloseTo(1 - cfg.perPoint * 3, 6)
    expect(cellGradeMisconductModifier(cfg, 100, 0)).toBe(cfg.max)
    expect(cellGradeMisconductModifier(cfg, 0, 100)).toBe(cfg.min)
  })

  it('grades sectors as the mean of the graded rooms inside them', () => {
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }

    const good = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    const bare = makeRoom(world, DATA, 'cell', { x: 12, y: 2, width: 3, height: 3 })
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')

    const sector = world.sectors.create(DATA, { name: 'A wing', access: 'shared' })
    const sectorId = sector?.id ?? 0
    world.sectors.paintTiles(world.grid, [...good.tiles, ...bare.tiles], sectorId)
    world.sectors.reindex(DATA, world.grid)

    regradeRooms(world, DATA)

    const goodGrade = world.grading.breakdowns.get(good.id)?.score ?? 0
    const bareGrade = world.grading.breakdowns.get(bare.id)?.score ?? 0
    expect(world.grading.sectorGrades.get(sectorId)).toBeCloseTo((goodGrade + bareGrade) / 2, 6)
  })

  it('runs hourly inside a simulation and reports what it did', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const deps = { world, data: DATA, events, tick: 0 }
    const cell = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')

    const sim = new Simulation({
      seed: 0xb10c_5002,
      world,
      systems: [createGradingSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_HOUR; i += 1) sim.step()

    expect(world.grading.breakdowns.get(cell.id)?.score).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Acceptance                                                                  */
/* -------------------------------------------------------------------------- */

describe('grading — T5.2 acceptance', () => {
  it('migrates well-behaved inmates into the luxurious block over several days', () => {
    const world = createInmateWorld({
      size: 64,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const events = new RecordingSink()
    const deps = { world, data: DATA, events, tick: 0 }

    // Four luxurious cells and four bare ones. The luxurious ones are stocked
    // to the top of the ladder so a fully-earned entitlement has somewhere to
    // go; the bare ones score the floor.
    const luxury: number[] = []
    const bare: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const lx = 2 + i * 6
      luxury.push(makeRoom(world, DATA, 'cell', { x: lx, y: 2, width: 4, height: 4 }).id)
      const stock = [
        'bed',
        'toilet',
        'comfort_bed',
        'bedside_cabinet',
        'sink',
        'bookshelf',
        'prayer_mat',
        'potted_plant',
      ]
      stock.forEach((objectId, slot) => {
        placeObject(deps, { x: lx + (slot % 4), y: 2 + Math.floor(slot / 4) }, objectId)
      })

      const bx = 2 + i * 6
      bare.push(makeRoom(world, DATA, 'cell', { x: bx, y: 20, width: 3, height: 3 }).id)
      placeObject(deps, { x: bx, y: 20 }, 'bed')
      placeObject(deps, { x: bx + 1, y: 20 }, 'toilet')
      placeObject(deps, { x: bx + 2, y: 20 }, 'foam_mattress')
    }

    world.standingOrders.reassignmentStrictness = 'lenient'
    regradeRooms(world, DATA)

    const luxuryGrades = luxury.map((id) => world.grading.breakdowns.get(id)?.score ?? 0)
    const bareGrades = bare.map((id) => world.grading.breakdowns.get(id)?.score ?? 0)
    expect(Math.min(...luxuryGrades)).toBeGreaterThan(Math.max(...bareGrades))

    // Four inmates who behave, four who do not.
    const wellBehaved: number[] = []
    const offenders: number[] = []
    for (let i = 0; i < 4; i += 1) {
      wellBehaved.push(addInmate(world, DATA, { entitlement: 2 }))
      offenders.push(addInmate(world, DATA, { entitlement: 2 }))
    }

    // Six days. The clean four climb the ladder; the others offend daily and
    // lose the points the same way `misconductSystem` takes them.
    for (let day = 1; day <= 6; day += 1) {
      const tick = day * TICKS_PER_DAY
      for (const id of offenders) {
        const entity = world.inmates.get(id)
        if (entity === undefined) continue
        entity.inmate.misconductLog.push({
          tick,
          kind: 'complaint',
          punishment: 'ignore',
          durationHours: 0,
        })
        entity.inmate.entitlement = applyEntitlementOnMisconduct(
          entity.inmate.entitlement,
          'complaint',
          DATA.balance,
        )
      }
      accrueEntitlement(world, DATA, events, tick)
      regradeRooms(world, DATA)
      reassignHousing(world, DATA, events, tick)
    }

    const luxuryIds = new Set(luxury)
    const goodInLuxury = wellBehaved.filter((id) =>
      luxuryIds.has(world.inmates.get(id)?.inmate.cellId ?? 0),
    ).length
    const badInLuxury = offenders.filter((id) =>
      luxuryIds.has(world.inmates.get(id)?.inmate.cellId ?? 0),
    ).length

    expect(goodInLuxury).toBe(4)
    expect(badInLuxury).toBe(0)
  })

  it('shows exactly which objects contributed which points', () => {
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const deps = { world, data: DATA, events: new RecordingSink(), tick: 0 }
    const cell = makeRoom(world, DATA, 'cell', { x: 2, y: 2, width: 4, height: 4 })
    placeObject(deps, { x: 3, y: 3 }, 'comfort_bed')
    placeObject(deps, { x: 4, y: 3 }, 'bookshelf')
    placeObject(deps, { x: 5, y: 3 }, 'prayer_mat')

    const grade = gradeRoom(world, DATA, cell, DATA.rooms.get('cell'))
    const subjects = (grade?.lines ?? []).map((line) => line.subject)
    expect(subjects).toContain('comfort_bed')
    expect(subjects).toContain('bookshelf')
    expect(subjects).toContain('prayer_mat')

    // Each object line carries its own points, not a lump sum.
    for (const objectId of ['comfort_bed', 'bookshelf', 'prayer_mat']) {
      const line = grade?.lines.find((entry) => entry.subject === objectId)
      expect(line?.points, objectId).toBe(1)
      expect(line?.found, objectId).toBe(1)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Save round trip                                                             */
/* -------------------------------------------------------------------------- */

describe('grading — persistence', () => {
  it('round-trips the entitlement clocks and drops the derived breakdowns', () => {
    const world = createInmateWorld({
      size: 16,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const id = addInmate(world, DATA)
    world.grading.lastEntitlementTick.set(id, 4321)
    const snapshot = world.grading.serialise()
    expect(snapshot.lastEntitlementTick).toEqual([{ inmateId: id, tick: 4321 }])

    const fresh = createInmateWorld({
      size: 16,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    fresh.grading.restore(snapshot as unknown as Parameters<typeof fresh.grading.restore>[0])
    expect(fresh.grading.lastEntitlementTick.get(id)).toBe(4321)
    expect(fresh.grading.breakdowns.size).toBe(0)
  })

  it('emits a rejection rather than throwing on a world it cannot grade', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      systems: [createGradingSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_HOUR; i += 1) sim.step()
    const rejected = events.of(GRADING_EVENTS.rejected)
    expect(rejected).toHaveLength(1)
    expect((rejected[0]?.data as JsonObject)['reason']).toBe('wrong-world')
  })
})
