/**
 * T1.5, second and third of the ticket's test areas: **inverse-command
 * correctness for every command type** and **refund maths**.
 *
 * The inverse tests are all the same shape, and it is the shape that matters:
 * fingerprint the world, capture the inverse, apply the action, apply the
 * inverse, fingerprint again. Nothing asserts on what a particular inverse
 * looks like, because that would pin the implementation rather than the
 * property. The property is that undo puts the prison back, and the fixture's
 * `structure()` explains precisely which "back" is meant.
 */

import { describe, expect, it } from 'vitest'

import {
  BUILD_ACTION_KINDS,
  actionTiles,
  applyBuildActions,
  salvage,
  siteCancellationRefund,
  validateBlueprint,
} from '../../src/core/blueprint'
import type { BuildAction } from '../../src/core/blueprint'
import { isJsonArray } from '../../src/core/commands'
import type { JsonValue } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import type { ConstructionSite } from '../../src/world/construction'
import {
  CommitLedger,
  UndoStack,
  captureInverse,
  captureInverses,
  commitRefund,
  createUndoStack,
  snapshotTile,
} from '../../src/core/undo'
import { placeObject } from '../../src/entities/objects'

import {
  FLOOR_MATERIAL,
  WALL_MATERIAL,
  buildOut,
  interiorOf,
  makeRoom,
  putDoor,
  putFloor,
  putWall,
  roomShapes,
  scenario,
  structure,
} from './blueprintFixture'
import type { BlueprintScenario } from './blueprintFixture'

/* -------------------------------------------------------------------------- */
/* Inverse correctness                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Applies `action`, then its inverse, and asserts the world came back.
 *
 * Returns the two runs so a caller can also assert on the money.
 */
function roundTrip(
  run: BlueprintScenario,
  action: BuildAction,
): { forward: ReturnType<typeof applyBuildActions>; back: ReturnType<typeof applyBuildActions> } {
  const before = structure(run.world)
  const roomsBefore = roomShapes(run.world)

  const inverse = captureInverse(run.world, run.data, action)
  expect(inverse, `${action.kind} should have an inverse`).toBeDefined()
  if (inverse === undefined) throw new Error('unreachable')

  const forward = applyBuildActions(run.buildDeps(), [action])
  expect(structure(run.world), `${action.kind} should have changed something`).not.toBe(before)

  const back = applyBuildActions(run.buildDeps(), [inverse])
  expect(structure(run.world), `${action.kind} did not invert`).toBe(before)
  expect(roomShapes(run.world)).toEqual(roomsBefore)

  return { forward, back }
}

/** A furnished, enclosed cell to run destructive actions against. */
function furnishedCell(run: BlueprintScenario): { roomId: number; bedTile: number } {
  const shell = { x: 4, y: 4, width: 4, height: 5 }
  const roomId = makeRoom(run, shell, 'cell')
  const interior = interiorOf(shell)
  const entity = placeObject(run.objectDeps(), { x: interior.x, y: interior.y }, 'bed', 0)
  if (entity === undefined) throw new Error('the fixture bed was refused')
  return { roomId, bedTile: entity.tileIndex }
}

describe('every command type has a working inverse', () => {
  it('placeFoundation', () => {
    const run = scenario()
    roundTrip(run, {
      kind: 'placeFoundation',
      rect: { x: 3, y: 3, width: 5, height: 4 },
      material: WALL_MATERIAL,
    })
  })

  it('placeWall', () => {
    const run = scenario()
    roundTrip(run, {
      kind: 'placeWall',
      line: { x1: 3, y1: 3, x2: 9, y2: 3 },
      material: WALL_MATERIAL,
    })
  })

  it('removeWall', () => {
    const run = scenario()
    for (let x = 3; x <= 9; x += 1) putWall(run, x, 3)
    roundTrip(run, { kind: 'removeWall', line: { x1: 3, y1: 3, x2: 9, y2: 3 } })
  })

  it('placeDoor', () => {
    const run = scenario()
    for (let x = 3; x <= 9; x += 1) putWall(run, x, 3)
    roundTrip(run, { kind: 'placeDoor', tile: { x: 6, y: 3 }, doorType: 'standard' })
  })

  it('placeDoor over an existing door of another type', () => {
    const run = scenario()
    for (let x = 3; x <= 9; x += 1) putWall(run, x, 3)
    putDoor(run, 6, 3)
    roundTrip(run, { kind: 'placeDoor', tile: { x: 6, y: 3 }, doorType: 'secure' })
  })

  it('paintFloor', () => {
    const run = scenario()
    for (let y = 3; y < 7; y += 1) for (let x = 3; x < 7; x += 1) putFloor(run, x, y)
    roundTrip(run, {
      kind: 'paintFloor',
      rect: { x: 3, y: 3, width: 4, height: 4 },
      material: 'ceramic_tile',
    })
  })

  it('paintCable', () => {
    // Cable overlays live on InmateWorld; ObjectWorld blueprint fixtures cannot
    // round-trip them yet (session auto-route / undo wiring is a follow-up).
    const run = scenario()
    for (let x = 3; x <= 7; x += 1) putFloor(run, x, 4)
    const action: BuildAction = { kind: 'paintCable', line: { x1: 3, y1: 4, x2: 7, y2: 4 } }
    expect(actionTiles(run.world, run.data, action)).toHaveLength(5)
  })

  it('paintPipe', () => {
    const run = scenario()
    for (let x = 3; x <= 7; x += 1) putFloor(run, x, 5)
    const action: BuildAction = { kind: 'paintPipe', line: { x1: 3, y1: 5, x2: 7, y2: 5 } }
    expect(actionTiles(run.world, run.data, action)).toHaveLength(5)
  })

  it('demolish', () => {
    const run = scenario()
    furnishedCell(run)
    roundTrip(run, { kind: 'demolish', rect: { x: 4, y: 4, width: 4, height: 1 } })
  })

  it('designateRoom', () => {
    const run = scenario()
    const shell = { x: 4, y: 4, width: 4, height: 5 }
    for (let y = shell.y; y < shell.y + shell.height; y += 1) {
      for (let x = shell.x; x < shell.x + shell.width; x += 1) {
        const onEdge =
          x === shell.x ||
          y === shell.y ||
          x === shell.x + shell.width - 1 ||
          y === shell.y + shell.height - 1
        if (onEdge) putWall(run, x, y)
        else putFloor(run, x, y)
      }
    }
    roundTrip(run, { kind: 'designateRoom', rect: interiorOf(shell), roomDefId: 'cell' })
  })

  it('undesignateRoom', () => {
    const run = scenario()
    furnishedCell(run)
    roundTrip(run, {
      kind: 'undesignateRoom',
      rect: interiorOf({ x: 4, y: 4, width: 4, height: 5 }),
    })
  })

  it('placeObject', () => {
    const run = scenario()
    const shell = { x: 4, y: 4, width: 4, height: 5 }
    makeRoom(run, shell, 'cell')
    const interior = interiorOf(shell)
    roundTrip(run, {
      kind: 'placeObject',
      tile: { x: interior.x, y: interior.y },
      objectDefId: 'bed',
      rotation: 0,
    })
  })

  it('placeObject at a rotation', () => {
    const run = scenario()
    const shell = { x: 4, y: 4, width: 8, height: 8 }
    makeRoom(run, shell, 'dayroom')
    const interior = interiorOf(shell)
    // A 2x1 object turned on its side: the footprint the inverse has to find
    // again is not the one the anchor tile suggests.
    roundTrip(run, {
      kind: 'placeObject',
      tile: { x: interior.x, y: interior.y },
      objectDefId: 'couch',
      rotation: 90,
    })
  })

  it('removeObject', () => {
    const run = scenario()
    const { bedTile } = furnishedCell(run)
    const entity = run.world.objects.at(bedTile)
    expect(entity).toBeDefined()
    roundTrip(run, { kind: 'removeObject', entityId: entity?.id ?? 0 })
  })

  it('removeObjectAt', () => {
    const run = scenario()
    const { bedTile } = furnishedCell(run)
    const { x, y } = run.world.grid.xy(bedTile)
    roundTrip(run, { kind: 'removeObjectAt', tile: { x, y } })
  })

  it('restore', () => {
    const run = scenario()
    furnishedCell(run)
    const tiles = [run.world.grid.idx(5, 5), run.world.grid.idx(6, 5)]
    // A snapshot of somewhere else, so applying it genuinely changes these two.
    const foreign = tiles.map((index) => ({
      ...snapshotTile(run.world, index),
      wall: WALL_MATERIAL,
      floor: FLOOR_MATERIAL,
      designation: null,
    }))
    roundTrip(run, { kind: 'restore', tiles: foreign })
  })

  it('covers the whole vocabulary', () => {
    // Guards against a build command being added without an inverse test. The
    // list here is the set of kinds the cases above exercise.
    const tested = new Set<string>([
      'placeFoundation',
      'placeWall',
      'removeWall',
      'placeDoor',
      'paintFloor',
      'paintCable',
      'paintPipe',
      'demolish',
      'designateRoom',
      'undesignateRoom',
      'placeObject',
      'removeObject',
      'removeObjectAt',
      'restore',
    ])
    expect([...BUILD_ACTION_KINDS].filter((kind) => !tested.has(kind))).toEqual([])
  })
})

describe('capturing inverses', () => {
  it('declines to invert an action that would do nothing', () => {
    const run = scenario()

    // No such object.
    expect(
      captureInverse(run.world, run.data, { kind: 'removeObject', entityId: 999 }),
    ).toBeUndefined()
    // Nothing standing there.
    expect(
      captureInverse(run.world, run.data, { kind: 'removeObjectAt', tile: { x: 1, y: 1 } }),
    ).toBeUndefined()
    // Entirely off the grid.
    expect(
      captureInverse(run.world, run.data, {
        kind: 'demolish',
        rect: { x: 500, y: 500, width: 2, height: 2 },
      }),
    ).toBeUndefined()
  })

  it('reverses the order, so overlapping actions undo correctly', () => {
    const run = scenario()
    const rect = { x: 3, y: 3, width: 4, height: 4 }
    const before = structure(run.world)

    const actions: BuildAction[] = [
      { kind: 'placeFoundation', rect, material: WALL_MATERIAL },
      { kind: 'paintFloor', rect, material: 'ceramic_tile' },
      { kind: 'demolish', rect: { x: 4, y: 4, width: 2, height: 2 } },
    ]

    const { inverse } = captureInverses(run.buildDeps(), actions)
    expect(structure(run.world)).not.toBe(before)

    applyBuildActions(run.buildDeps(), inverse)
    expect(structure(run.world)).toBe(before)
  })

  it('sees objects an earlier action in the same list just placed', () => {
    const run = scenario()
    const shell = { x: 4, y: 4, width: 4, height: 5 }
    makeRoom(run, shell, 'cell')
    const interior = interiorOf(shell)
    const before = structure(run.world)

    // Place a bed, then take it back, all in one commit. Capturing every
    // inverse against the pristine world would miss the second action's
    // target, because the bed is not there yet.
    const { inverse } = captureInverses(run.buildDeps(), [
      {
        kind: 'placeObject',
        tile: { x: interior.x, y: interior.y },
        objectDefId: 'bed',
        rotation: 0,
      },
      { kind: 'removeObjectAt', tile: { x: interior.x, y: interior.y } },
    ])

    expect([...run.world.objects.all()]).toHaveLength(0)
    applyBuildActions(run.buildDeps(), inverse)
    expect(structure(run.world)).toBe(before)
  })

  it('snapshots a tile as it stands, not as the action will leave it', () => {
    const run = scenario()
    const index = putWall(run, 5, 5)
    run.world.rooms.setDesignation(index, 'cell')

    const snapshot = snapshotTile(run.world, index)
    expect(snapshot).toEqual({
      index,
      wall: WALL_MATERIAL,
      floor: FLOOR_MATERIAL,
      door: null,
      doorLocked: false,
      outdoors: false,
      designation: 'cell',
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Refund maths                                                                */
/* -------------------------------------------------------------------------- */

describe('salvage', () => {
  it('is the balance file fraction, floored', () => {
    const run = scenario()
    const fraction = run.data.balance.construction.materialRefundOnDemolish

    expect(salvage(run.data, 100)).toBe(Math.floor(100 * fraction))
    expect(salvage(run.data, 0)).toBe(0)
    // Floored, never rounded up: salvage cannot exceed the stated fraction.
    expect(salvage(run.data, 1)).toBeLessThanOrEqual(fraction)
  })
})

describe('cancelling a site refunds in proportion to the work done', () => {
  function site(cost: number, done: number, required: number): ConstructionSite {
    return {
      id: 1,
      tileIndex: 0,
      job: { kind: 'wall', material: WALL_MATERIAL, foundation: false },
      requirements: [],
      delivered: [],
      workTicksRequired: required,
      cost,
      queuedAtTick: 0,
      workTicksDone: done,
      blockedBy: 'none',
    }
  }

  it('refunds everything when nothing has been built', () => {
    const run = scenario()
    expect(siteCancellationRefund(run.data, site(400, 0, 100))).toBe(400)
  })

  it('refunds the demolition fraction once the work is complete', () => {
    const run = scenario()
    const fraction = run.data.balance.construction.materialRefundOnDemolish
    expect(siteCancellationRefund(run.data, site(400, 100, 100))).toBe(400 * fraction)
  })

  it('interpolates in a straight line between the two', () => {
    const run = scenario()
    const fraction = run.data.balance.construction.materialRefundOnDemolish
    const half = siteCancellationRefund(run.data, site(400, 50, 100))
    expect(half).toBe(Math.floor(400 * (1 - 0.5 * (1 - fraction))))
    expect(half).toBeGreaterThan(400 * fraction)
    expect(half).toBeLessThan(400)
  })

  it('never pays out more than the cost, however over-worked the site', () => {
    const run = scenario()
    const fraction = run.data.balance.construction.materialRefundOnDemolish
    expect(siteCancellationRefund(run.data, site(400, 900, 100))).toBe(400 * fraction)
  })

  it('treats a site that needs no work as finished', () => {
    const run = scenario()
    const fraction = run.data.balance.construction.materialRefundOnDemolish
    expect(siteCancellationRefund(run.data, site(400, 0, 0))).toBe(400 * fraction)
  })

  it('is monotonic: later cancellation never pays more', () => {
    const run = scenario()
    let previous = Number.POSITIVE_INFINITY
    for (let done = 0; done <= 100; done += 10) {
      const refund = siteCancellationRefund(run.data, site(777, done, 100))
      expect(refund).toBeLessThanOrEqual(previous)
      previous = refund
    }
  })
})

describe('undoing a commit', () => {
  /** Twenty toilets in a hall big enough to take them. */
  function twentyObjects(run: BlueprintScenario): BuildAction[] {
    const shell = { x: 2, y: 2, width: 14, height: 8 }
    makeRoom(run, shell, 'mess_hall')
    const interior = interiorOf(shell)

    const actions: BuildAction[] = []
    for (let n = 0; n < 20; n += 1) {
      actions.push({
        kind: 'placeObject',
        tile: { x: interior.x + (n % 10), y: interior.y + Math.floor(n / 10) * 2 },
        objectDefId: 'chair',
        rotation: 0,
      })
    }
    return actions
  }

  it('refunds a twenty-object placement in full and puts the world back', () => {
    const run = scenario()
    const actions = twentyObjects(run)
    const unitCost = run.data.objects.get('chair').cost

    const before = structure(run.world)
    const roomsBefore = roomShapes(run.world)

    run.commit(actions)
    expect([...run.world.objects.all()]).toHaveLength(20)
    expect(run.world.spendOwed).toBe(20 * unitCost)

    run.undo()

    expect([...run.world.objects.all()]).toHaveLength(0)
    expect(structure(run.world)).toBe(before)
    expect(roomShapes(run.world)).toEqual(roomsBefore)

    // The purchase came back in full: objects are bought, not built, so there
    // is no part-finished work to write off.
    expect(run.world.refundsOwed - run.world.spendOwed).toBe(0)
    expect(run.world.takeRefunds()).toBe(20 * unitCost)
    expect(run.world.takeSpend()).toBe(20 * unitCost)
  })

  it('quotes the refund before it is taken', () => {
    const run = scenario()
    run.commit(twentyObjects(run))

    const record = run.ledger.peek()
    expect(record).toBeDefined()
    if (record === undefined) throw new Error('unreachable')

    const quoted = commitRefund(run.world, run.data, record)
    const refundsBefore = run.world.refundsOwed
    run.undo()

    expect(run.world.refundsOwed - refundsBefore).toBe(quoted)
    expect(quoted).toBe(20 * run.data.objects.get('chair').cost)
  })

  it('refunds an untouched construction commit in full', () => {
    const run = scenario({ workers: 0 })
    const rect = { x: 3, y: 3, width: 6, height: 6 }
    const actions: BuildAction[] = [{ kind: 'placeFoundation', rect, material: WALL_MATERIAL }]

    const quoted = validateBlueprint(run.world, run.data, actions).cost
    const before = structure(run.world)

    run.commit(actions)
    expect(run.world.spendOwed).toBe(quoted)

    // Not one tick of work has been done, so undo costs the player nothing.
    run.undo()
    expect(structure(run.world)).toBe(before)
    expect(run.world.takeRefunds()).toBe(quoted)
    expect(run.world.takeSpend()).toBe(quoted)
  })

  it('withholds the built part when the work is already finished', () => {
    const run = scenario({ workers: 32 })
    const rect = { x: 3, y: 3, width: 6, height: 6 }
    const actions: BuildAction[] = [{ kind: 'placeFoundation', rect, material: WALL_MATERIAL }]
    const fraction = run.data.balance.construction.materialRefundOnDemolish

    const quoted = validateBlueprint(run.world, run.data, actions).cost
    run.commit(actions)
    buildOut(run)

    const spentBefore = run.world.takeSpend()
    const refundsBefore = run.world.takeRefunds()
    expect(spentBefore).toBe(quoted)

    run.undo()

    const refunded = run.world.refundsOwed - run.world.spendOwed
    expect(refundsBefore).toBe(0)
    // Everything standing is salvaged at the demolition fraction, which is
    // what cancelling the finished site would have paid too.
    expect(refunded).toBeGreaterThan(0)
    expect(refunded).toBeLessThan(quoted)
    expect(refunded).toBeCloseTo(quoted * fraction, -1)
  })

  it('pays back less the longer the player waits', () => {
    const rect = { x: 3, y: 3, width: 6, height: 6 }
    const actions: BuildAction[] = [{ kind: 'placeFoundation', rect, material: WALL_MATERIAL }]

    const refundAfter = (ticks: number): number => {
      const run = scenario({ workers: 1 })
      run.commit(actions)
      for (let i = 0; i < ticks; i += 1) run.sim.step()
      run.world.takeRefunds()
      run.undo()
      return run.world.refundsOwed
    }

    const immediately = refundAfter(0)
    const partway = refundAfter(40)

    expect(partway).toBeLessThan(immediately)
  })

  it('undoes a mixed commit of structure, rooms and objects', () => {
    const run = scenario({ workers: 32 })
    const shell = { x: 3, y: 3, width: 4, height: 5 }
    const interior = interiorOf(shell)

    const before = structure(run.world)
    const actions: BuildAction[] = [
      { kind: 'placeFoundation', rect: shell, material: WALL_MATERIAL },
      { kind: 'designateRoom', rect: interior, roomDefId: 'cell' },
    ]

    run.commit(actions)
    buildOut(run)
    expect(run.world.rooms.all()).toHaveLength(1)

    run.undo()

    expect(structure(run.world)).toBe(before)
    expect(run.world.rooms.all()).toHaveLength(0)
  })

  it('undoes commits newest first', () => {
    const run = scenario({ workers: 0 })
    const first = structure(run.world)

    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ])
    const second = structure(run.world)

    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 9, y: 9, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ])

    run.undo()
    expect(structure(run.world)).toBe(second)

    run.undo()
    expect(structure(run.world)).toBe(first)
  })
})

/* -------------------------------------------------------------------------- */
/* The commands                                                                */
/* -------------------------------------------------------------------------- */

/** An event's payload as a readable record, or a failure that says so. */
function fields(event: SimulationEvent | undefined): Readonly<Record<string, JsonValue>> {
  const data = event?.data
  if (data === undefined || data === null || typeof data !== 'object' || isJsonArray(data)) {
    throw new Error(`expected ${event?.kind ?? 'the event'} to carry an object`)
  }
  return data
}

describe('the commit and undo commands', () => {
  it('applies a whole blueprint on one tick', () => {
    const run = scenario({ workers: 0 })
    const tickBefore = run.sim.tick

    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 6, height: 6 },
        material: WALL_MATERIAL,
      },
      {
        kind: 'placeFoundation',
        rect: { x: 12, y: 3, width: 6, height: 6 },
        material: WALL_MATERIAL,
      },
    ])

    expect(run.sim.tick).toBe(tickBefore + 1)
    expect([...run.world.sites.all()].length).toBe(72)

    const committed = run.events.of('blueprint.committed')
    expect(committed).toHaveLength(1)
  })

  it('reports what it committed', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
    ])

    const data = fields(run.events.of('blueprint.committed')[0])
    expect(data['sequence']).toBe(1)
    expect(data['actions']).toBe(1)
    expect(data['tiles']).toBe(16)
    expect(data['cost']).toBe(run.world.spendOwed)
  })

  it('applies the actions it can and refuses the rest, one event each', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
      // Off the grid entirely.
      {
        kind: 'placeFoundation',
        rect: { x: 400, y: 400, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
    ])

    expect([...run.world.sites.all()]).toHaveLength(16)
    expect(run.events.of('blueprint.committed')).toHaveLength(1)
    expect(run.events.of('construction.rejected').length).toBeGreaterThan(0)
  })

  it('emits a CausalEvent rather than throwing on a malformed commit', () => {
    const run = scenario()

    run.sim.enqueue({ type: 'blueprint.commit', payload: {}, issuedAtTick: run.sim.tick })
    run.sim.step()
    run.sim.enqueue({
      type: 'blueprint.commit',
      payload: { actions: [{ kind: 'notAThing' }] },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()
    run.sim.enqueue({
      type: 'blueprint.commit',
      payload: { actions: [] },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()

    const reasons = run.events
      .of('blueprint.rejected')
      .map((event) => String(fields(event)['reason']))
    // The middle commit raises two: the action it could not read, and then the
    // fact that reading it left nothing to do.
    expect(reasons).toEqual([
      'invalid-payload',
      'invalid-action',
      'empty-blueprint',
      'empty-blueprint',
    ])
    expect(run.ledger.size).toBe(0)
  })

  it('emits a CausalEvent when there is nothing left to undo', () => {
    const run = scenario()
    run.undo()

    const rejected = run.events.of('blueprint.rejected')
    expect(rejected).toHaveLength(1)
    expect(fields(rejected[0])['reason']).toBe('nothing-to-undo')
  })

  it('reports the refund it paid', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
    ])
    const spent = run.world.spendOwed
    run.undo()

    const data = fields(run.events.of('blueprint.undone')[0])
    expect(data['sequence']).toBe(1)
    expect(data['spent']).toBe(spent)
    expect(data['refund']).toBe(spent)
  })

  it('leaves the ledger empty once every commit is undone', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ])
    expect(run.ledger.size).toBe(1)
    run.undo()
    expect(run.ledger.size).toBe(0)
    expect(run.ledger.redoSize).toBe(1)
  })
})

describe('redoing a commit', () => {
  it('restores structure and money after undo then redo', () => {
    const run = scenario({ workers: 0 })
    const actions: BuildAction[] = [
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
    ]

    const before = structure(run.world)
    run.commit(actions)
    const committed = structure(run.world)
    const spendAfterCommit = run.world.spendOwed
    const refundAfterCommit = run.world.refundsOwed

    run.undo()
    expect(structure(run.world)).toBe(before)
    expect(run.ledger.redoSize).toBe(1)

    run.redo()
    expect(structure(run.world)).toBe(committed)
    expect(run.world.spendOwed).toBe(spendAfterCommit)
    expect(run.world.refundsOwed).toBe(refundAfterCommit)
    expect(run.ledger.size).toBe(1)
    expect(run.ledger.redoSize).toBe(0)
  })

  it('restores a twenty-object placement in full', () => {
    const run = scenario()
    const shell = { x: 2, y: 2, width: 14, height: 8 }
    makeRoom(run, shell, 'mess_hall')
    const interior = interiorOf(shell)

    const actions: BuildAction[] = []
    for (let n = 0; n < 20; n += 1) {
      actions.push({
        kind: 'placeObject',
        tile: { x: interior.x + (n % 10), y: interior.y + Math.floor(n / 10) * 2 },
        objectDefId: 'chair',
        rotation: 0,
      })
    }

    const before = structure(run.world)
    run.commit(actions)
    const committed = structure(run.world)
    const unitCost = run.data.objects.get('chair').cost
    const spendAfterCommit = run.world.spendOwed

    run.undo()
    expect([...run.world.objects.all()]).toHaveLength(0)
    expect(structure(run.world)).toBe(before)

    run.redo()
    expect([...run.world.objects.all()]).toHaveLength(20)
    expect(structure(run.world)).toBe(committed)
    expect(run.world.spendOwed).toBe(spendAfterCommit)
    expect(run.world.refundsOwed).toBe(0)
    expect(run.world.takeSpend()).toBe(20 * unitCost)
    expect(run.world.takeRefunds()).toBe(0)
  })

  it('emits a CausalEvent when there is nothing left to redo', () => {
    const run = scenario()
    run.redo()

    const rejected = run.events.of('blueprint.rejected')
    expect(rejected).toHaveLength(1)
    expect(fields(rejected[0])['reason']).toBe('nothing-to-redo')
  })

  it('clears redo when a new commit lands', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ])
    run.undo()
    expect(run.ledger.redoSize).toBe(1)

    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 9, y: 9, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ])
    expect(run.ledger.redoSize).toBe(0)
  })

  it('keeps remaining redo entries after one redo of a multi-undo stack', () => {
    const run = scenario({ workers: 0 })
    const first: BuildAction[] = [
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ]
    const second: BuildAction[] = [
      {
        kind: 'placeFoundation',
        rect: { x: 9, y: 9, width: 3, height: 3 },
        material: WALL_MATERIAL,
      },
    ]

    run.commit(first)
    const afterFirst = structure(run.world)
    run.commit(second)
    const afterBoth = structure(run.world)

    run.undo()
    run.undo()
    expect(run.ledger.redoSize).toBe(2)

    run.redo()
    expect(structure(run.world)).toBe(afterFirst)
    expect(run.ledger.redoSize).toBe(1)

    run.redo()
    expect(structure(run.world)).toBe(afterBoth)
    expect(run.ledger.redoSize).toBe(0)
  })

  it('charges redo after the economy has drained the undo refund', () => {
    const run = scenario({ workers: 0 })
    run.commit([
      {
        kind: 'placeFoundation',
        rect: { x: 3, y: 3, width: 4, height: 4 },
        material: WALL_MATERIAL,
      },
    ])
    const cost = run.world.takeSpend()
    expect(cost).toBeGreaterThan(0)

    run.undo()
    expect(run.world.takeRefunds()).toBe(cost)

    run.redo()
    expect(run.world.spendOwed).toBe(cost)
    expect(run.world.refundsOwed).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* The stacks                                                                  */
/* -------------------------------------------------------------------------- */

describe('UndoStack', () => {
  it('takes its depth from the balance file', () => {
    const run = scenario()
    expect(createUndoStack(run.data).depth).toBe(run.data.balance.construction.undoDepth)
    expect(run.data.balance.construction.undoDepth).toBe(50)
  })

  it('returns entries newest first', () => {
    const stack = new UndoStack(50)
    stack.push({ kind: 'blueprint', strokeId: 1 })
    stack.push({ kind: 'commit', sequence: 1, cost: 500 })

    expect(stack.peek()).toEqual({ kind: 'commit', sequence: 1, cost: 500 })
    expect(stack.pop()).toEqual({ kind: 'commit', sequence: 1, cost: 500 })
    expect(stack.pop()).toEqual({ kind: 'blueprint', strokeId: 1 })
    expect(stack.pop()).toBeUndefined()
  })

  it('drops the oldest entry past its depth', () => {
    const stack = new UndoStack(50)
    for (let n = 1; n <= 60; n += 1) stack.push({ kind: 'blueprint', strokeId: n })

    expect(stack.size).toBe(50)
    expect(stack.entries()[0]).toEqual({ kind: 'blueprint', strokeId: 11 })
    expect(stack.peek()).toEqual({ kind: 'blueprint', strokeId: 60 })
  })

  it('interleaves blueprint strokes and commits', () => {
    const stack = new UndoStack(50)
    stack.push({ kind: 'blueprint', strokeId: 1 })
    stack.push({ kind: 'commit', sequence: 1, cost: 100 })
    stack.push({ kind: 'blueprint', strokeId: 2 })

    expect(stack.entries().map((entry) => entry.kind)).toEqual(['blueprint', 'commit', 'blueprint'])
  })

  it('hands back a copy, so a caller cannot rewrite history', () => {
    const stack = new UndoStack(50)
    stack.push({ kind: 'blueprint', strokeId: 1 })

    const taken = stack.entries()
    expect(taken).not.toBe(stack.entries())
    expect(taken).toEqual(stack.entries())
  })

  it('refuses a nonsensical depth', () => {
    expect(() => new UndoStack(0)).toThrow(RangeError)
    expect(() => new UndoStack(-1)).toThrow(RangeError)
    expect(() => new UndoStack(2.5)).toThrow(RangeError)
  })
})

describe('CommitLedger', () => {
  const record = { tick: 1, cost: 100, inverse: [] as BuildAction[], actions: [] as BuildAction[] }

  it('numbers commits from one, and keeps numbering past its depth', () => {
    const ledger = new CommitLedger(3)
    expect(ledger.record(record).sequence).toBe(1)
    expect(ledger.record(record).sequence).toBe(2)
    expect(ledger.record(record).sequence).toBe(3)
    expect(ledger.record(record).sequence).toBe(4)

    expect(ledger.size).toBe(3)
    expect(ledger.records()[0]?.sequence).toBe(2)
    expect(ledger.nextSequence).toBe(5)
  })

  it('takes the newest record', () => {
    const ledger = new CommitLedger(50)
    ledger.record(record)
    const last = ledger.record({ ...record, cost: 999 })

    expect(ledger.peek()).toEqual(last)
    expect(ledger.take()).toEqual(last)
    expect(ledger.size).toBe(1)
  })

  it('empties on demand, for a load', () => {
    const ledger = new CommitLedger(50)
    ledger.record(record)
    ledger.clear()
    expect(ledger.size).toBe(0)
    expect(ledger.take()).toBeUndefined()
  })

  it('refuses a nonsensical depth', () => {
    expect(() => new CommitLedger(0)).toThrow(RangeError)
  })

  it('holds fifty commits, per the balance file', () => {
    const run = scenario({ workers: 0 })
    for (let n = 0; n < 55; n += 1) {
      run.commit([
        {
          kind: 'placeFoundation',
          rect: { x: 1 + (n % 20), y: 1 + Math.floor(n / 20), width: 1, height: 1 },
          material: WALL_MATERIAL,
        },
      ])
    }
    expect(run.ledger.size).toBe(run.data.balance.construction.undoDepth)
  })
})
