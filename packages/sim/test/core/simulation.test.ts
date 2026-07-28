import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import type { Command } from '../../src/core/commands'
import type { Fnv1aHasher } from '../../src/core/hash'
import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type {
  EventSink,
  SimulationEvent,
  System,
  SystemContext,
  World,
} from '../../src/core/simulation'

const SEED = 0xb10c_0001
const STEPS = 10_000
const CHECKPOINTS = [1, 100, 1000, 10_000] as const

/**
 * A stand-in for the T0.3 world: enough mutable state, touched by enough
 * different systems, that a determinism failure anywhere in the core would
 * show up in the hash.
 */
class FixtureWorld implements World {
  readonly counters = new Int32Array(8)
  balance = 0
  lastCommand = ''

  hashInto(hasher: Fnv1aHasher): void {
    for (let i = 0; i < this.counters.length; i += 1) {
      hasher.writeInt32(this.counters[i] ?? 0)
    }
    hasher.writeFloat64(this.balance)
    hasher.writeString(this.lastCommand)
  }

  bump(index: number, by: number): void {
    const slot = index % this.counters.length
    this.counters[slot] = (this.counters[slot] ?? 0) + by
  }
}

function fixtureSystems(world: FixtureWorld): System[] {
  return [
    {
      name: 'movement',
      period: 1,
      update({ rng }: SystemContext): void {
        world.bump(0, rng.stream('movement').nextInt(-2, 3))
      },
    },
    {
      name: 'needs',
      period: TICKS_PER_MINUTE,
      update({ rng, clock }: SystemContext): void {
        world.bump(clock.hour, rng.stream('needs').chance(0.3) ? 1 : 0)
      },
    },
    {
      name: 'economy',
      period: TICKS_PER_HOUR,
      update({ rng, clock }: SystemContext): void {
        world.balance += rng.stream('economy').next() * 100 - 40
        world.bump(7, clock.day)
      },
    },
  ]
}

class RecordingEventSink implements EventSink {
  readonly events: SimulationEvent[] = []

  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

interface Scenario {
  readonly sim: Simulation
  readonly world: FixtureWorld
}

// A type alias, not an interface, so that it keeps the implicit index
// signature that makes it assignable to JsonValue.
type BumpPayload = { readonly amount: number; readonly note: string }

function createScenario(seed = SEED): Scenario {
  const world = new FixtureWorld()
  const sim = new Simulation({
    seed,
    world,
    systems: fixtureSystems(world),
    commandHandlers: {
      'test.bump': (command) => {
        const payload = command.payload as BumpPayload
        world.bump(1, payload.amount)
        world.lastCommand = payload.note
      },
    },
  })
  return { sim, world }
}

/** The same ordered command list for every run: a command every 250 steps. */
function scheduledCommand(step: number): Command | undefined {
  if (step % 250 !== 0) return undefined
  return {
    type: 'test.bump',
    payload: { amount: (step / 250) % 7, note: `step ${step}` },
    issuedAtTick: step - 1,
  }
}

function runAndHash(scenario: Scenario, steps: number): number[] {
  const hashes: number[] = []
  for (let step = 1; step <= steps; step += 1) {
    const command = scheduledCommand(step)
    if (command !== undefined) {
      scenario.sim.enqueue(command)
    }
    scenario.sim.step()
    hashes.push(scenario.sim.hash())
  }
  return hashes
}

describe('Simulation determinism (PRD 4.1)', () => {
  it('produces identical hashes at every step of a 10,000 step run', () => {
    const a = runAndHash(createScenario(), STEPS)
    const b = runAndHash(createScenario(), STEPS)

    for (const checkpoint of CHECKPOINTS) {
      expect(b[checkpoint - 1], `hash at step ${checkpoint}`).toBe(a[checkpoint - 1])
    }
    expect(b).toEqual(a)
  })

  it('actually advances state, so the hash comparison is not vacuous', () => {
    const hashes = runAndHash(createScenario(), STEPS)

    expect(hashes).toHaveLength(STEPS)
    expect(new Set(hashes).size).toBeGreaterThan(STEPS * 0.99)
  })

  it('diverges on a different seed', () => {
    const a = runAndHash(createScenario(SEED), 1_000)
    const b = runAndHash(createScenario(SEED + 1), 1_000)

    expect(b.at(-1)).not.toBe(a.at(-1))
  })

  it('diverges on a different command list', () => {
    const baseline = createScenario()
    const altered = createScenario()

    runAndHash(baseline, 500)

    for (let step = 1; step <= 500; step += 1) {
      const command = scheduledCommand(step)
      if (command !== undefined) {
        altered.sim.enqueue({ ...command, payload: { amount: 99, note: 'different' } })
      }
      altered.sim.step()
    }

    expect(altered.sim.hash()).not.toBe(baseline.sim.hash())
  })

  it('hashes command payloads regardless of key insertion order', () => {
    const a = createScenario()
    const b = createScenario()

    a.sim.enqueue({ type: 'unhandled', payload: { x: 1, y: 2 }, issuedAtTick: 0 })
    b.sim.enqueue({ type: 'unhandled', payload: { y: 2, x: 1 }, issuedAtTick: 0 })

    expect(b.sim.hash()).toBe(a.sim.hash())
  })
})

describe('Simulation step order', () => {
  it('starts at tick 0 and advances exactly one tick per step', () => {
    const sim = new Simulation({ seed: SEED })

    expect(sim.tick).toBe(0)
    sim.step()
    expect(sim.tick).toBe(1)
    sim.step()
    expect(sim.tick).toBe(2)
  })

  it('applies commands at the start of a tick, before any system runs', () => {
    const order: string[] = []
    const sim = new Simulation({
      seed: SEED,
      systems: [
        {
          name: 'observer',
          period: 1,
          update({ clock }: SystemContext): void {
            order.push(`system@${clock.tick}`)
          },
        },
      ],
      commandHandlers: {
        'test.note': (command, { clock }) => {
          order.push(`command:${command.type}@${clock.tick}`)
        },
      },
    })

    sim.enqueue({ type: 'test.note', payload: null, issuedAtTick: 0 })
    sim.step()

    expect(order).toEqual(['command:test.note@1', 'system@1'])
  })

  it('applies commands in insertion order', () => {
    const applied: number[] = []
    const sim = new Simulation({
      seed: SEED,
      commandHandlers: {
        'test.note': (command) => {
          applied.push(command.issuedAtTick)
        },
      },
    })

    sim.enqueue({ type: 'test.note', payload: null, issuedAtTick: 90 })
    sim.enqueue({ type: 'test.note', payload: null, issuedAtTick: 12 })
    sim.enqueue({ type: 'test.note', payload: null, issuedAtTick: 40 })
    sim.step()

    expect(applied).toEqual([90, 12, 40])
  })

  it('drains the queue once, so a command never applies twice', () => {
    let applications = 0
    const sim = new Simulation({
      seed: SEED,
      commandHandlers: {
        'test.note': () => {
          applications += 1
        },
      },
    })

    sim.enqueue({ type: 'test.note', payload: null, issuedAtTick: 0 })
    sim.step()
    sim.step()
    sim.step()

    expect(applications).toBe(1)
    expect(sim.pendingCommands()).toHaveLength(0)
  })

  it('runs each system only on ticks that are a multiple of its period', () => {
    const runs = { fast: 0, minute: 0, hour: 0 }
    const sim = new Simulation({
      seed: SEED,
      systems: [
        {
          name: 'fast',
          period: 1,
          update: () => {
            runs.fast += 1
          },
        },
        {
          name: 'minute',
          period: TICKS_PER_MINUTE,
          update: () => {
            runs.minute += 1
          },
        },
        {
          name: 'hour',
          period: TICKS_PER_HOUR,
          update: () => {
            runs.hour += 1
          },
        },
      ],
    })

    for (let step = 0; step < TICKS_PER_HOUR; step += 1) {
      sim.step()
    }

    expect(runs).toEqual({ fast: 600, minute: 60, hour: 1 })
  })

  it('runs systems in registration order every tick', () => {
    const order: string[] = []
    const named = (name: string): System => ({
      name,
      period: 1,
      update: () => {
        order.push(name)
      },
    })
    const sim = new Simulation({
      seed: SEED,
      systems: [named('routine'), named('pathing'), named('movement')],
    })

    sim.step()
    sim.step()

    expect(order).toEqual(['routine', 'pathing', 'movement', 'routine', 'pathing', 'movement'])
  })

  it('rejects a system with a nonsense period', () => {
    const bad: System = { name: 'broken', period: 0, update: () => undefined }

    expect(() => new Simulation({ seed: SEED, systems: [bad] })).toThrow(RangeError)
  })
})

describe('Simulation causal events (CLAUDE.md rule 5)', () => {
  it('emits an event for a command with no registered handler', () => {
    const events = new RecordingEventSink()
    const sim = new Simulation({ seed: SEED, events })

    sim.enqueue({ type: 'placeUnicorn', payload: { x: 3 }, issuedAtTick: 7 })
    sim.step()

    expect(events.events).toEqual([
      {
        tick: 1,
        kind: 'command.unhandled',
        causeIds: [],
        data: { type: 'placeUnicorn', issuedAtTick: 7 },
      },
    ])
  })

  it('keeps running after an unhandled command', () => {
    const sim = new Simulation({ seed: SEED, world: createEmptyWorld() })

    sim.enqueue({ type: 'placeUnicorn', payload: null, issuedAtTick: 0 })

    expect(() => sim.step()).not.toThrow()
    expect(sim.tick).toBe(1)
  })
})
