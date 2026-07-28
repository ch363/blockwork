/**
 * The simulation root: it owns the clock, the RNG, the world and the ordered
 * system list, and `step()` advances all of it by exactly one tick.
 *
 * Determinism contract (PRD 4.1, 4.4). Within a step, in this order:
 *
 *   1. The clock advances. This is the `TimeSystem` slot in the PRD's fixed
 *      system order, so "the start of tick N" means the clock already reads N.
 *   2. Pending player commands are drained and applied in insertion order.
 *   3. Systems run in registration order, each one only on ticks that are a
 *      multiple of its declared period.
 *
 * Nothing in that sequence may read wall-clock time, real elapsed time, or an
 * unseeded random source. Given the same seed and the same ordered command
 * list, `hash()` must agree at every tick.
 */

import { Clock } from './clock'
import type { ReadonlyClock } from './clock'
import { CommandQueue } from './commands'
import type { Command, JsonValue } from './commands'
import { Fnv1aHasher } from './hash'
import { Rng } from './rng'

/**
 * The mutable state systems read and write.
 *
 * T0.3 replaces this with the typed-array `TileGrid` and the entity store. The
 * one thing the core needs from it now is a contribution to the determinism
 * hash, and that requirement does not change when the real world lands: every
 * byte of simulation state has to reach `hashInto`, or determinism tests will
 * pass while the simulation diverges.
 */
export interface World {
  hashInto(hasher: Fnv1aHasher): void
}

/** A world with no state, for tests and for the pre-T0.3 boot path. */
export function createEmptyWorld(): World {
  return {
    hashInto(hasher: Fnv1aHasher): void {
      hasher.writeUint32(0)
    },
  }
}

/**
 * A simulation failure or warning, in the shape of PRD 3.1's `CausalEvent`
 * minus the `id`, which the recorder assigns.
 *
 * `CausalEventLog` (T3.1) records these into a ring buffer. `subjectId` is the
 * entity the Trace panel pans to; omit or pass 0 when there is no subject.
 */
export interface SimulationEvent {
  readonly tick: number
  readonly kind: string
  /** Entity the event is about, or 0 / omitted. */
  readonly subjectId?: number
  readonly causeIds: readonly number[]
  readonly data: JsonValue
}

export interface EventSink {
  emit(event: SimulationEvent): void
}

/** Discards events. Prefer {@link CausalEventLog} in production paths. */
export const nullEventSink: EventSink = {
  emit(): void {
    // Intentionally empty.
  },
}

/** What a system is handed on every update. Systems may not advance the clock. */
export interface SystemContext {
  readonly clock: ReadonlyClock
  readonly rng: Rng
  readonly world: World
  readonly events: EventSink
}

/**
 * One entry in the fixed system order of PRD 4.4. `period` is in ticks: 1 is
 * every tick, 10 is every in-game minute, 600 every in-game hour.
 */
export interface System {
  readonly name: string
  readonly period: number
  update(context: SystemContext): void
}

export type CommandHandler = (command: Command, context: SystemContext) => void

export interface SimulationOptions {
  /** The master seed, an unsigned 32-bit integer. */
  readonly seed: number
  readonly world?: World
  /** Run in this order, every tick, forever. Changing the order changes the game. */
  readonly systems?: readonly System[]
  readonly commandHandlers?: Readonly<Record<string, CommandHandler>>
  readonly events?: EventSink
}

export class Simulation {
  readonly rng: Rng
  readonly world: World
  readonly systems: readonly System[]

  readonly #clock = new Clock()
  readonly #queue = new CommandQueue()
  readonly #handlers: ReadonlyMap<string, CommandHandler>
  readonly #events: EventSink
  readonly #context: SystemContext

  constructor(options: SimulationOptions) {
    this.rng = new Rng(options.seed)
    this.world = options.world ?? createEmptyWorld()
    this.systems = options.systems ?? []
    this.#events = options.events ?? nullEventSink
    this.#handlers = new Map(Object.entries(options.commandHandlers ?? {}))

    for (const system of this.systems) {
      if (!Number.isInteger(system.period) || system.period < 1) {
        throw new RangeError(
          `system '${system.name}' must declare an integer period of at least 1, received ${system.period}`,
        )
      }
    }

    this.#context = {
      clock: this.#clock,
      rng: this.rng,
      world: this.world,
      events: this.#events,
    }
  }

  get clock(): ReadonlyClock {
    return this.#clock
  }

  get tick(): number {
    return this.#clock.tick
  }

  /** Queues a command for the start of the next step. */
  enqueue(command: Command): void {
    this.#queue.enqueue(command)
  }

  enqueueAll(commands: Iterable<Command>): void {
    this.#queue.enqueueAll(commands)
  }

  /** Commands still waiting for the next step. */
  pendingCommands(): readonly Command[] {
    return this.#queue.peek()
  }

  /** Advances the simulation by exactly one tick. */
  step(): void {
    this.#clock.advance()
    this.#applyCommands()
    this.#runSystems()
  }

  /**
   * A stable FNV-1a fingerprint of all simulation state. Two runs that agree
   * on this at every tick are the same run.
   */
  hash(): number {
    const hasher = new Fnv1aHasher()

    hasher.writeUint32(this.#clock.tick)

    const rngState = this.rng.serialise()
    hasher.writeUint32(rngState.seed)
    hasher.writeUint32(rngState.streams.length)
    for (const stream of rngState.streams) {
      hasher.writeString(stream.name)
      hasher.writeUint32(stream.state)
    }

    const pending = this.#queue.serialise()
    hasher.writeUint32(pending.length)
    for (const command of pending) {
      hasher.writeString(command.type)
      hasher.writeUint32(command.issuedAtTick)
      hasher.writeJson(command.payload)
    }

    this.world.hashInto(hasher)

    return hasher.digest()
  }

  #applyCommands(): void {
    for (const command of this.#queue.drain()) {
      const handler = this.#handlers.get(command.type)
      if (handler === undefined) {
        this.#events.emit({
          tick: this.#clock.tick,
          kind: 'command.unhandled',
          causeIds: [],
          data: { type: command.type, issuedAtTick: command.issuedAtTick },
        })
        continue
      }
      handler(command, this.#context)
    }
  }

  #runSystems(): void {
    const tick = this.#clock.tick
    for (const system of this.systems) {
      if (tick % system.period === 0) {
        system.update(this.#context)
      }
    }
  }
}
