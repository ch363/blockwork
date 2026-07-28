/**
 * Player commands and the queue that feeds them into the simulation.
 *
 * PRD 4.6: commands cross the worker boundary as a serialised queue and are
 * applied at the start of the next tick. That is the whole determinism story
 * for player input, so a command must be a plain, structured-clonable,
 * JSON-representable object and nothing more. `enqueue` enforces that at the
 * point of entry rather than letting a stray function or `undefined` surface
 * later as a save failure or a hash mismatch.
 */

export type JsonPrimitive = string | number | boolean | null

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

/** A single player command. Ordering is by insertion, not by `issuedAtTick`. */
export interface Command {
  readonly type: string
  readonly payload: JsonValue
  /** The tick the player issued it on, for latency reporting and replay logs. */
  readonly issuedAtTick: number
}

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): asserts value is JsonValue {
  if (value === null) return

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`command payload ${path} must be a finite number, received ${value}`)
      }
      return
    case 'object':
      break
    default:
      throw new TypeError(`command payload ${path} must be JSON data, received ${describe(value)}`)
  }

  const container = value as object
  if (seen.has(container)) {
    throw new TypeError(`command payload ${path} is cyclic`)
  }
  seen.add(container)

  if (Array.isArray(container)) {
    const items: readonly unknown[] = container
    items.forEach((item, index) => {
      assertJsonValue(item, `${path}[${index}]`, seen)
    })
  } else {
    const prototype: unknown = Object.getPrototypeOf(container)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`command payload ${path} must be a plain object`)
    }
    for (const [key, entry] of Object.entries(container)) {
      assertJsonValue(entry, `${path}.${key}`, seen)
    }
  }

  seen.delete(container)
}

/** Throws with the offending path if `payload` is not plain JSON data. */
export function assertSerialisablePayload(payload: unknown): asserts payload is JsonValue {
  assertJsonValue(payload, 'payload', new Set())
}

export function assertCommand(command: Command): void {
  if (typeof command.type !== 'string' || command.type.length === 0) {
    throw new TypeError('command.type must be a non-empty string')
  }
  if (!Number.isInteger(command.issuedAtTick) || command.issuedAtTick < 0) {
    throw new RangeError(
      `command.issuedAtTick must be a non-negative integer, received ${command.issuedAtTick}`,
    )
  }
  assertSerialisablePayload(command.payload)
}

/**
 * A first-in, first-out queue of pending player commands. The simulation
 * drains it once, at the start of every tick.
 */
export class CommandQueue {
  #pending: Command[] = []

  get size(): number {
    return this.#pending.length
  }

  enqueue(command: Command): void {
    assertCommand(command)
    this.#pending.push(command)
  }

  enqueueAll(commands: Iterable<Command>): void {
    for (const command of commands) {
      this.enqueue(command)
    }
  }

  /** The pending commands in insertion order, without consuming them. */
  peek(): readonly Command[] {
    return this.#pending.slice()
  }

  /** Returns the pending commands in insertion order and empties the queue. */
  drain(): readonly Command[] {
    const drained = this.#pending
    this.#pending = []
    return drained
  }

  clear(): void {
    this.#pending = []
  }

  serialise(): readonly Command[] {
    return this.peek()
  }

  restore(commands: readonly Command[]): void {
    this.#pending = []
    this.enqueueAll(commands)
  }
}
