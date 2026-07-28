/**
 * T1.5, first of the ticket's three test areas: **validation without
 * mutation**, plus the pricing and the end-to-end acceptance case that
 * validation exists to serve.
 */

import { describe, expect, it } from 'vitest'

import {
  Blueprint,
  actionFromJson,
  actionToJson,
  projectBlueprint,
  validateBlueprint,
} from '../../src/core/blueprint'
import type { BuildAction } from '../../src/core/blueprint'
import { isJsonArray } from '../../src/core/commands'

import {
  FLOOR_MATERIAL,
  WALL_MATERIAL,
  buildOut,
  interiorOf,
  makeRoom,
  putWall,
  roomShapes,
  scenario,
  structure,
} from './blueprintFixture'
import type { BlueprintScenario } from './blueprintFixture'

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                               */
/* -------------------------------------------------------------------------- */

const CELL_WIDTH = 4
const CELL_HEIGHT = 5

/** Six cells in a row, each a 4x5 shell whose 2x3 interior is a cell. */
function cellBlock(count: number, originX = 2, originY = 2): BuildAction[] {
  const actions: BuildAction[] = []

  for (let n = 0; n < count; n += 1) {
    // Shells share their side walls, so each cell after the first starts one
    // tile back. That is how a player draws a block, and it is the case where
    // a naive per-rectangle price would charge for the shared wall twice.
    const shell = {
      x: originX + n * (CELL_WIDTH - 1),
      y: originY,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
    }
    actions.push({ kind: 'placeFoundation', rect: shell, material: WALL_MATERIAL })
    actions.push({ kind: 'designateRoom', rect: interiorOf(shell), roomDefId: 'cell' })
  }

  return actions
}

/** The interior tiles of the nth cell drawn by `cellBlock`. */
function cellInterior(n: number, originX = 2, originY = 2): { x: number; y: number } {
  return { x: originX + n * (CELL_WIDTH - 1) + 1, y: originY + 1 }
}

function issueFor(
  run: BlueprintScenario,
  actions: readonly BuildAction[],
  subject: string,
): { count: number } | undefined {
  const report = validateBlueprint(run.world, run.data, actions)
  return report.issues.find((issue) => issue.subject === subject)
}

/* -------------------------------------------------------------------------- */

describe('validation does not mutate the world', () => {
  it('leaves an empty world untouched by a large blueprint', () => {
    const run = scenario()
    const before = structure(run.world)

    const report = validateBlueprint(run.world, run.data, cellBlock(6))

    expect(report.tiles).toBeGreaterThan(0)
    expect(structure(run.world)).toBe(before)
    expect([...run.world.sites.all()]).toHaveLength(0)
    expect([...run.world.objects.all()]).toHaveLength(0)
    expect([...run.world.rooms.all()]).toHaveLength(0)
  })

  it('leaves a built world untouched, including its rooms and objects', () => {
    const run = scenario()
    makeRoom(run, { x: 2, y: 2, width: 4, height: 5 }, 'cell')
    const spot = cellInterior(0)
    run.sim.enqueue({
      type: 'objects.place',
      payload: { x: spot.x, y: spot.y, objectId: 'bed', rotation: 0 },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()

    const before = structure(run.world)
    const roomsBefore = roomShapes(run.world)
    const hashBefore = run.sim.hash()

    // A blueprint that demolishes the room, repaints it and furnishes it: if
    // anything leaked, this would leak loudly.
    validateBlueprint(run.world, run.data, [
      { kind: 'demolish', rect: { x: 2, y: 2, width: 4, height: 5 } },
      {
        kind: 'placeFoundation',
        rect: { x: 8, y: 2, width: 4, height: 5 },
        material: WALL_MATERIAL,
      },
      { kind: 'designateRoom', rect: { x: 9, y: 3, width: 2, height: 3 }, roomDefId: 'cell' },
      { kind: 'placeObject', tile: { x: 9, y: 3 }, objectDefId: 'toilet', rotation: 0 },
      { kind: 'removeObject', entityId: 1 },
    ])

    expect(structure(run.world)).toBe(before)
    expect(roomShapes(run.world)).toEqual(roomsBefore)
    expect(run.sim.hash()).toBe(hashBefore)
  })

  it('is idempotent: validating twice gives the same report', () => {
    const run = scenario()
    const actions = cellBlock(6)

    const first = validateBlueprint(run.world, run.data, actions)
    const second = validateBlueprint(run.world, run.data, actions)

    expect(second).toEqual(first)
  })

  it('projects into a world that shares no buffers with the source', () => {
    const run = scenario()
    const projection = projectBlueprint(run.world, run.data, cellBlock(2))

    const source = run.world.grid.buffers()
    const copy = projection.world.grid.buffers()

    expect(copy.floorMaterial).not.toBe(source.floorMaterial)
    expect(copy.wallMaterial).not.toBe(source.wallMaterial)
    expect(projection.world.rooms).not.toBe(run.world.rooms)
    expect(projection.world.objects).not.toBe(run.world.objects)

    // Writing through the projection cannot reach the original.
    projection.world.grid.setAt('floorMaterial', 0, 3)
    expect(run.world.grid.getAt('floorMaterial', 0)).toBe(0)
  })

  it('sees rooms that do not exist yet', () => {
    const run = scenario()
    const projection = projectBlueprint(run.world, run.data, cellBlock(6))

    expect(run.world.rooms.all()).toHaveLength(0)
    expect(projection.world.rooms.all()).toHaveLength(6)
  })

  it('settles construction that is still in progress', () => {
    const run = scenario({ workers: 0 })
    run.commit(cellBlock(1))

    // Nothing is built: the sites are queued with no builders to work them, so
    // the designated tiles are an unenclosed patch of open ground.
    expect([...run.world.sites.all()].length).toBeGreaterThan(0)
    const real = run.world.rooms.all()[0]
    expect(real).toBeDefined()
    expect(real?.properties.enclosed).toBe(false)

    // The forecast answers for the finished prison, not the scaffolding.
    const projection = projectBlueprint(run.world, run.data, [])
    expect([...projection.world.sites.all()]).toHaveLength(0)
    const forecast = projection.world.rooms.all()[0]
    expect(forecast?.properties.enclosed).toBe(true)
  })
})

describe('pricing', () => {
  it('charges what the commit deducts', () => {
    const run = scenario()
    const actions = cellBlock(6)

    const quoted = validateBlueprint(run.world, run.data, actions).cost
    run.commit(actions)

    expect(quoted).toBeGreaterThan(0)
    expect(run.world.spendOwed).toBe(quoted)
  })

  it('charges a stroke drawn twice only once', () => {
    const run = scenario()
    const rect = { x: 2, y: 2, width: 6, height: 6 }
    const once: BuildAction[] = [{ kind: 'placeFoundation', rect, material: WALL_MATERIAL }]
    const twice: BuildAction[] = [
      ...once,
      { kind: 'placeFoundation', rect, material: WALL_MATERIAL },
    ]

    expect(validateBlueprint(run.world, run.data, twice).cost).toBe(
      validateBlueprint(run.world, run.data, once).cost,
    )
  })

  it('does not charge for structure the player already owns', () => {
    const run = scenario()
    const rect = { x: 2, y: 2, width: 4, height: 4 }
    const actions: BuildAction[] = [{ kind: 'placeFoundation', rect, material: WALL_MATERIAL }]

    const onOpenGround = validateBlueprint(run.world, run.data, actions).cost

    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) putWall(run, x, y)
    }

    expect(validateBlueprint(run.world, run.data, actions).cost).toBeLessThan(onOpenGround)
  })

  it('counts objects separately from tiles', () => {
    const run = scenario()
    makeRoom(run, { x: 2, y: 2, width: 4, height: 5 }, 'cell')
    const spot = cellInterior(0)

    const report = validateBlueprint(run.world, run.data, [
      { kind: 'placeObject', tile: spot, objectDefId: 'toilet', rotation: 0 },
    ])

    expect(report.objects).toBe(1)
    expect(report.tiles).toBe(0)
    expect(report.cost).toBe(run.data.objects.get('toilet').cost)
  })
})

describe('the acceptance case: a six-cell block', () => {
  it('reports the cells that have no toilet, then stops once they have one', () => {
    const run = scenario({ workers: 32 })
    const block = cellBlock(6)

    // Every cell also needs a bed. Furnish all six with beds and three of them
    // with toilets, so the toilet is the only thing three cells are short of.
    const beds: BuildAction[] = []
    const toilets: BuildAction[] = []
    for (let n = 0; n < 6; n += 1) {
      const interior = cellInterior(n)
      beds.push({ kind: 'placeObject', tile: interior, objectDefId: 'bed', rotation: 0 })
      if (n < 3) {
        toilets.push({
          kind: 'placeObject',
          tile: { x: interior.x + 1, y: interior.y + 2 },
          objectDefId: 'toilet',
          rotation: 0,
        })
      }
    }

    const partial = [...block, ...beds, ...toilets]
    const missing = issueFor(run, partial, 'toilet')
    expect(missing?.count).toBe(3)
    expect(issueFor(run, partial, 'bed')).toBeUndefined()

    // Add the three missing toilets and the complaint goes away.
    const rest: BuildAction[] = []
    for (let n = 3; n < 6; n += 1) {
      const interior = cellInterior(n)
      rest.push({
        kind: 'placeObject',
        tile: { x: interior.x + 1, y: interior.y + 2 },
        objectDefId: 'toilet',
        rotation: 0,
      })
    }

    const complete = [...partial, ...rest]
    const report = validateBlueprint(run.world, run.data, complete)
    expect(report.issues).toEqual([])
    expect(report.valid).toBe(true)
    expect(report.objects).toBe(12)

    // And it commits: six working cells, furnished, in the real world.
    run.commit(complete)
    buildOut(run)

    expect([...run.world.sites.all()]).toHaveLength(0)
    expect(run.world.rooms.all()).toHaveLength(6)
    expect([...run.world.objects.all()]).toHaveLength(12)
    for (const room of run.world.rooms.all()) {
      expect(run.world.rooms.statusOf(room.id)?.functional).toBe(true)
    }
  })

  it('groups one problem per requirement rather than one per room', () => {
    const run = scenario()
    const report = validateBlueprint(run.world, run.data, cellBlock(6))

    // Six unfurnished cells: two problems, each affecting six rooms.
    expect(report.issues).toHaveLength(2)
    for (const issue of report.issues) {
      expect(issue.count).toBe(6)
      expect(issue.focus).toHaveLength(6)
      expect(issue.sourceName).toBe('Cell')
    }
    expect(report.issues.map((issue) => issue.subject).sort()).toEqual(['bed', 'toilet'])
  })

  it('gives every issue somewhere to pan to', () => {
    const run = scenario()
    const report = validateBlueprint(run.world, run.data, cellBlock(6))

    for (const issue of report.issues) {
      for (const tile of issue.focus) {
        expect(run.world.grid.inBounds(tile.x, tile.y)).toBe(true)
      }
    }
  })

  it('says nothing about rooms the blueprint does not touch', () => {
    const run = scenario()
    // An unfurnished cell that the player is not currently drawing on.
    makeRoom(run, { x: 20, y: 20, width: 4, height: 5 }, 'cell')
    expect(validateBlueprint(run.world, run.data, []).issues).toEqual([])

    const report = validateBlueprint(run.world, run.data, cellBlock(1))
    for (const issue of report.issues) expect(issue.count).toBe(1)
  })

  it('reports a refused action as its own issue', () => {
    const run = scenario()
    makeRoom(run, { x: 2, y: 2, width: 4, height: 5 }, 'cell')
    const spot = cellInterior(0)

    const report = validateBlueprint(run.world, run.data, [
      { kind: 'placeObject', tile: spot, objectDefId: 'bed', rotation: 0 },
      // The same tile twice: the second bed has nowhere to go.
      { kind: 'placeObject', tile: spot, objectDefId: 'bed', rotation: 0 },
    ])

    expect(report.valid).toBe(false)
    const rejected = report.issues.filter((issue) => issue.kind === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.source).toBe('placeObject')
    expect(rejected[0]?.count).toBe(1)
    // One bed still gets placed, and is still charged for.
    expect(report.objects).toBe(1)
  })
})

describe('Blueprint staging', () => {
  const stroke: BuildAction = {
    kind: 'placeFoundation',
    rect: { x: 1, y: 1, width: 2, height: 2 },
    material: WALL_MATERIAL,
  }

  it('starts empty', () => {
    const blueprint = new Blueprint()
    expect(blueprint.empty).toBe(true)
    expect(blueprint.size).toBe(0)
    expect(blueprint.actions()).toEqual([])
  })

  it('takes back the last stroke instantly and locally', () => {
    const blueprint = new Blueprint()
    const first = blueprint.add(stroke)
    const second = blueprint.add({ kind: 'demolish', rect: { x: 4, y: 4, width: 1, height: 1 } })

    expect(blueprint.undoStroke()).toBe(second)
    expect(blueprint.size).toBe(1)
    expect(blueprint.actions()).toEqual([first.action])

    expect(blueprint.undoStroke()).toBe(first)
    expect(blueprint.empty).toBe(true)
    expect(blueprint.undoStroke()).toBeUndefined()
  })

  it('gives every stroke a distinct id, including after an undo', () => {
    const blueprint = new Blueprint()
    const first = blueprint.add(stroke)
    blueprint.undoStroke()
    const second = blueprint.add(stroke)

    expect(second.id).not.toBe(first.id)
  })

  it('removes a stroke from the middle', () => {
    const blueprint = new Blueprint()
    const first = blueprint.add(stroke)
    const middle = blueprint.add(stroke)
    const last = blueprint.add(stroke)

    expect(blueprint.remove(middle.id)).toBe(middle)
    expect(blueprint.strokes()).toEqual([first, last])
    expect(blueprint.remove(middle.id)).toBeUndefined()
  })

  it('discards everything in one call', () => {
    const blueprint = new Blueprint()
    blueprint.add(stroke)
    blueprint.add(stroke)
    blueprint.clear()

    expect(blueprint.empty).toBe(true)
  })

  it('hands its whole list to one command', () => {
    const blueprint = new Blueprint()
    blueprint.add(stroke)
    blueprint.add(stroke)

    const command = blueprint.commitCommand(7)
    expect(command.type).toBe('blueprint.commit')
    expect(command.issuedAtTick).toBe(7)

    const payload = command.payload
    if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) {
      throw new Error('commit payload should be an object')
    }
    expect(payload['actions']).toHaveLength(2)
  })
})

describe('the JSON codec', () => {
  const samples: BuildAction[] = [
    { kind: 'placeFoundation', rect: { x: 1, y: 2, width: 3, height: 4 }, material: WALL_MATERIAL },
    { kind: 'placeWall', line: { x1: 1, y1: 1, x2: 5, y2: 1 }, material: WALL_MATERIAL },
    { kind: 'removeWall', line: { x1: 1, y1: 1, x2: 5, y2: 1 } },
    { kind: 'placeDoor', tile: { x: 3, y: 1 }, doorType: 'standard' },
    { kind: 'paintFloor', rect: { x: 1, y: 2, width: 3, height: 4 }, material: FLOOR_MATERIAL },
    { kind: 'demolish', rect: { x: 0, y: 0, width: 2, height: 2 } },
    { kind: 'designateRoom', rect: { x: 1, y: 1, width: 2, height: 3 }, roomDefId: 'cell' },
    { kind: 'undesignateRoom', rect: { x: 1, y: 1, width: 2, height: 3 } },
    { kind: 'placeObject', tile: { x: 4, y: 4 }, objectDefId: 'toilet', rotation: 180 },
    { kind: 'removeObject', entityId: 12 },
    { kind: 'removeObjectAt', tile: { x: 4, y: 4 } },
    {
      kind: 'restore',
      tiles: [
        {
          index: 99,
          wall: WALL_MATERIAL,
          floor: FLOOR_MATERIAL,
          door: 'standard',
          doorLocked: true,
          outdoors: false,
          designation: 'cell',
        },
        {
          index: 100,
          wall: null,
          floor: null,
          door: null,
          doorLocked: false,
          outdoors: true,
          designation: null,
        },
      ],
    },
  ]

  it.each(samples.map((action) => [action.kind, action] as const))(
    'round-trips %s',
    (_kind, action) => {
      expect(actionFromJson(actionToJson(action))).toEqual(action)
    },
  )

  it('covers every action kind', () => {
    expect(new Set(samples.map((action) => action.kind)).size).toBe(samples.length)
  })

  it('survives a structured-clone round trip', () => {
    for (const action of samples) {
      const wire: unknown = structuredClone(actionToJson(action))
      expect(actionFromJson(wire as ReturnType<typeof actionToJson>)).toEqual(action)
    }
  })

  it('refuses malformed input rather than guessing', () => {
    expect(actionFromJson(null)).toBeUndefined()
    expect(actionFromJson('placeWall')).toBeUndefined()
    expect(actionFromJson([])).toBeUndefined()
    expect(actionFromJson({ kind: 'notAThing' })).toBeUndefined()
    expect(actionFromJson({ kind: 'placeDoor', tile: { x: 1, y: 1 } })).toBeUndefined()
    expect(
      actionFromJson({ kind: 'placeDoor', tile: { x: 1, y: 1 }, doorType: 'gossamer' }),
    ).toBeUndefined()
    expect(actionFromJson({ kind: 'removeObject', entityId: 1.5 })).toBeUndefined()
    expect(
      actionFromJson({
        kind: 'placeObject',
        tile: { x: 1, y: 1 },
        objectDefId: 'bed',
        rotation: 7,
      }),
    ).toBeUndefined()
  })
})
