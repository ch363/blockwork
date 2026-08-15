/**
 * The composition root, and with it Phase 1's exit criterion end to end:
 * draw a foundation, wall it, designate a room, place objects, and watch the
 * room report itself functional.
 *
 * These are the tests that could not exist before `createGame`. Every piece
 * was covered in isolation — construction geometry, room detection,
 * requirement evaluation — and none of it was ever run *together*, through the
 * command queue, on a clock. Two real defects lived in that gap: a simulation
 * with no command handlers answered every player command with
 * `command.unhandled`, and nothing called `updateStaleRooms`, so a room closed
 * by a wall the construction system finished stayed stale forever.
 */

import { describe, expect, it } from 'vitest'

import { CONSTRUCTION_COMMANDS } from '../../src/world/construction'
import { OBJECT_COMMANDS } from '../../src/entities/objects'
import { ROOM_COMMANDS } from '../../src/world/roomDetection'
import { TICKS_PER_MINUTE } from '../../src/core/clock'
import { allocateTileGridBuffers, applyNewPrisonConfig, createGame, createGameWorld } from '../../src/core/game'
import { defaultNewPrisonConfig } from '../../src/core/mapSettings'
import { INTAKE_COMMANDS } from '../../src/systems/intakeSystem'
import { loadGameData } from '../../src/data/loader'
import { uniformWorkforce } from '../../src/systems/constructionSystem'
import type { Command, SimulationEvent } from '../../src/index'
import type { Game } from '../../src/core/game'

const RAW_DATA = loadGameData()

/** Phase 1 exit tests build without a dock; real supply is covered in T3.4. */
const DATA = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    construction: { ...RAW_DATA.balance.construction, stubMaterialDelivery: true },
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}
const SEED = 0xb10c_9001
const MAP = 40

/** Somewhere with room around it, away from the map edge. */
const SHELL = { x: 10, y: 10, width: 8, height: 7 }
/** The inside of that shell. */
const INSIDE = { x: 11, y: 11, width: 6, height: 5 }

function command(type: string, payload: Record<string, unknown>): Command {
  return { type, payload: payload as never, issuedAtTick: 0 }
}

interface Harness {
  readonly game: Game
  readonly events: SimulationEvent[]
  send(command: Command): void
  run(ticks: number): void
}

function harness(builders = 4): Harness {
  const events: SimulationEvent[] = []

  const game = createGame({
    seed: SEED,
    mapSize: MAP,
    data: DATA,
    workforce: uniformWorkforce(builders),
    applyOpening: false,
    events: {
      emit(event) {
        events.push(event)
      },
    },
  })

  return {
    game,
    events,
    send(cmd) {
      game.simulation.enqueue(cmd)
    },
    run(ticks) {
      for (let i = 0; i < ticks; i += 1) game.simulation.step()
    },
  }
}

/** Long enough for the ten-tick systems to run several times over. */
const SETTLE_TICKS = TICKS_PER_MINUTE * 30

describe('createGame', () => {
  it('handles every build command the UI can send', () => {
    const { game } = harness()

    // A command with no handler is answered with `command.unhandled` rather
    // than a throw, so the only way to catch a missing handler is to look.
    const handled = [
      ...Object.values(CONSTRUCTION_COMMANDS),
      ...Object.values(ROOM_COMMANDS),
      ...Object.values(OBJECT_COMMANDS),
      'blueprint.commit',
      'blueprint.undo',
    ]

    for (const type of handled) {
      const events: SimulationEvent[] = []
      const probe = createGame({
        seed: SEED,
        mapSize: MAP,
        data: DATA,
        applyOpening: false,
        events: {
          emit(event) {
            events.push(event)
          },
        },
      })
      probe.simulation.enqueue(command(type, {}))
      probe.simulation.step()

      expect(
        events.some((event) => event.kind === 'command.unhandled'),
        `${type} has no handler`,
      ).toBe(false)
    }

    expect(game.simulation.systems.map((system) => system.name)).toEqual([
      'routine',
      'jobAssignment',
      'staff',
      'posts',
      'navigation',
      'pathing',
      'movement',
      'combat',
      'needs',
      'staffNeeds',
      'activity',
      'mealChain',
      'supply',
      'deliveries',
      'cleaning',
      'laundry',
      'labour',
      'construction',
      'rooms',
      'utilities',
      'objects',
      'intake',
      'contraband',
      'search',
      'misconduct',
      'punishment',
      'intelligence',
      'danger',
      'riot',
      'emergency',
      'fire',
      'escape',
      'programs',
      'directorate',
      'economy',
      'contracts',
      'grading',
      'grades',
      'parole',
      'release',
    ])
  })

  it('builds a foundation the player ordered, given someone to build it', () => {
    const { game, send, run } = harness()

    send(
      command(CONSTRUCTION_COMMANDS.placeFoundation, {
        rect: SHELL,
        material: 'brick_wall',
      }),
    )
    run(SETTLE_TICKS)

    const { grid } = game.world
    // Perimeter walls, floor inside, and the whole footprint indoors.
    expect(grid.get('wallMaterial', SHELL.x, SHELL.y)).toBeGreaterThan(0)
    expect(grid.get('wallMaterial', SHELL.x + 3, SHELL.y)).toBeGreaterThan(0)
    expect(grid.get('wallMaterial', INSIDE.x, INSIDE.y)).toBe(0)
    expect(grid.get('floorMaterial', INSIDE.x, INSIDE.y)).toBeGreaterThan(0)
    expect(grid.get('outdoors', INSIDE.x, INSIDE.y)).toBe(0)
  })

  it('never finishes a site with nobody to build it', () => {
    const { game, send, run } = harness(0)

    send(
      command(CONSTRUCTION_COMMANDS.placeFoundation, {
        rect: SHELL,
        material: 'brick_wall',
      }),
    )
    run(SETTLE_TICKS)

    expect(game.world.grid.get('wallMaterial', SHELL.x, SHELL.y)).toBe(0)
    expect(game.world.sites.all().length).toBeGreaterThan(0)
  })
})

describe('a cell, end to end (Phase 1 exit criterion)', () => {
  /** Builds the shell, zones it as a cell, and settles. */
  function cell(): Harness {
    const h = harness()

    h.send(
      command(CONSTRUCTION_COMMANDS.placeFoundation, {
        rect: SHELL,
        material: 'brick_wall',
      }),
    )
    h.run(SETTLE_TICKS)

    h.send(command(ROOM_COMMANDS.designateRoom, { rect: INSIDE, roomDefId: 'cell' }))
    h.run(TICKS_PER_MINUTE * 2)

    return h
  }

  function onlyRoom(h: Harness): { id: number; functional: boolean; missing: string[] } {
    const rooms = h.game.world.rooms.all()
    expect(rooms.length).toBe(1)
    const room = rooms[0] as (typeof rooms)[number]
    const status = h.game.world.rooms.statusOf(room.id)
    expect(status).toBeDefined()

    return {
      id: room.id,
      functional: status?.functional ?? false,
      missing: (status?.requirements ?? [])
        .filter((requirement) => !requirement.met)
        .map((requirement) => requirement.subject),
    }
  }

  it('reports the enclosed, empty cell as missing exactly its two objects', () => {
    const h = cell()
    const room = onlyRoom(h)

    expect(room.functional).toBe(false)
    // Not "not a cell": the whole point of `RoomStatus` is that it names what
    // is wrong, one line per rule (T1.3).
    expect([...room.missing].sort()).toEqual(['bed', 'toilet'])
  })

  it('reports the cell as functional once the bed and toilet are in', () => {
    const h = cell()

    h.send(
      command(OBJECT_COMMANDS.placeObject, {
        tile: { x: INSIDE.x, y: INSIDE.y },
        objectDefId: 'bed',
        rotation: 0,
      }),
    )
    h.send(
      command(OBJECT_COMMANDS.placeObject, {
        tile: { x: INSIDE.x + 3, y: INSIDE.y + 2 },
        objectDefId: 'toilet',
        rotation: 0,
      }),
    )
    h.run(TICKS_PER_MINUTE * 2)

    const room = onlyRoom(h)
    expect(room.missing).toEqual([])
    expect(room.functional).toBe(true)
  })

  it('re-detects a room that a demolished wall opened up', () => {
    const h = cell()
    expect(onlyRoom(h).functional).toBe(false)

    // Knock a hole in the shell. The room is now open to the outdoors through
    // a gap that is not a door, so it loses `enclosed` — but only if something
    // re-runs detection, which is the `RoomSystem`'s whole job.
    h.send(
      command(CONSTRUCTION_COMMANDS.demolish, {
        rect: { x: SHELL.x + 3, y: SHELL.y, width: 1, height: 1 },
      }),
    )
    h.run(SETTLE_TICKS)

    const status = h.game.world.rooms.statusOf(onlyRoom(h).id)
    const enclosed = status?.requirements.find(
      (requirement) => requirement.kind === 'property' && requirement.subject === 'enclosed',
    )

    expect(enclosed?.met).toBe(false)
  })
})

describe('createGameWorld', () => {
  it('starts outdoors, unwalled and fully dirty', () => {
    const world = createGameWorld({ size: 16, data: DATA })

    expect(world.grid.get('outdoors', 0, 0)).toBe(1)
    expect(world.grid.get('wallMaterial', 0, 0)).toBe(0)
    // A renderer attaching to a fresh world has drawn nothing yet.
    expect(world.grid.consumeDirtyChunks().length).toBe(world.grid.chunkCount)
  })

  it('builds over caller-supplied buffers without copying them', () => {
    const buffers = allocateTileGridBuffers(16)
    const world = createGameWorld({ size: 16, data: DATA, buffers })

    world.grid.set('floorMaterial', 3, 4, 7)

    // The same bytes, not a copy: this is what lets the renderer read the
    // simulation's grid over shared memory.
    expect(new Uint8Array(buffers.floorMaterial)[4 * 16 + 3]).toBe(7)
  })
})

describe('determinism (PRD 4.1)', () => {
  it('produces the same hash from the same seed and command list', () => {
    const build = (): Harness => {
      const h = harness()
      h.send(
        command(CONSTRUCTION_COMMANDS.placeFoundation, {
          rect: SHELL,
          material: 'brick_wall',
        }),
      )
      h.send(command(ROOM_COMMANDS.designateRoom, { rect: INSIDE, roomDefId: 'cell' }))
      return h
    }

    const a = build()
    const b = build()

    for (let tick = 0; tick < 400; tick += 1) {
      a.run(1)
      b.run(1)
      expect(a.game.simulation.hash(), `diverged at tick ${String(tick)}`).toBe(
        b.game.simulation.hash(),
      )
    }
  })
})

describe('New Prison config (T8.8)', () => {
  it('writes funds, intake and failure toggles onto a live world', () => {
    const game = createGame({
      seed: SEED,
      mapSize: MAP,
      data: DATA,
      applyOpening: false,
    })
    const config = {
      ...defaultNewPrisonConfig(DATA, SEED),
      mapSize: MAP,
      startingFunds: 77_000,
      continuousIntake: false,
      randomEvents: false,
      firstOrderGrace: false,
      failures: { ...defaultNewPrisonConfig(DATA, SEED).failures, insolvency: false },
    }
    applyNewPrisonConfig(game.world, config)
    expect(game.world.economy.balance).toBe(77_000)
    expect(game.world.intake.continuous).toBe(false)
    expect(game.world.settings.randomEvents).toBe(false)
    expect(game.world.settings.firstOrderGrace).toBe(false)
    expect(game.world.settings.failures.insolvency).toBe(false)
  })
})

describe('UI payload aliases (T8.10)', () => {
  it('accepts intake.setRequested with categoryId', () => {
    const events: SimulationEvent[] = []
    const game = createGame({
      seed: SEED,
      mapSize: MAP,
      data: DATA,
      applyOpening: false,
      events: { emit(event) { events.push(event) } },
    })
    game.simulation.enqueue({
      type: INTAKE_COMMANDS.setRequested,
      issuedAtTick: 0,
      payload: { categoryId: 'medium', count: 3 },
    })
    game.simulation.step()
    expect(events.some((event) => event.kind === 'intake.rejected')).toBe(false)
    expect(game.world.intake.requestedCounts.get('medium')).toBe(3)
  })
})
