import { describe, expect, it } from 'vitest'

import { CommandQueue } from '../../src/core/commands'
import type { Command } from '../../src/core/commands'

function command(type: string, issuedAtTick: number): Command {
  return { type, payload: { tick: issuedAtTick }, issuedAtTick }
}

/** Enqueues a payload the type system would otherwise reject, to test the guard. */
function enqueueUnchecked(queue: CommandQueue, payload: unknown): void {
  queue.enqueue({ type: 'x', payload, issuedAtTick: 0 } as Command)
}

describe('CommandQueue', () => {
  it('drains in insertion order, not in issuedAtTick order', () => {
    const queue = new CommandQueue()
    queue.enqueue(command('paintFloor', 90))
    queue.enqueue(command('placeWall', 12))
    queue.enqueue(command('placeDoor', 40))

    expect(queue.drain().map((entry) => entry.type)).toEqual([
      'paintFloor',
      'placeWall',
      'placeDoor',
    ])
  })

  it('empties on drain', () => {
    const queue = new CommandQueue()
    queue.enqueue(command('placeWall', 1))

    expect(queue.drain()).toHaveLength(1)
    expect(queue.drain()).toHaveLength(0)
    expect(queue.size).toBe(0)
  })

  it('peeks without consuming', () => {
    const queue = new CommandQueue()
    queue.enqueue(command('placeWall', 1))

    expect(queue.peek()).toHaveLength(1)
    expect(queue.size).toBe(1)
  })

  it('does not expose its backing array through peek', () => {
    const queue = new CommandQueue()
    queue.enqueue(command('placeWall', 1))

    const peeked = queue.peek() as Command[]
    peeked.push(command('placeDoor', 2))

    expect(queue.size).toBe(1)
  })

  it('accepts nested plain JSON payloads', () => {
    const queue = new CommandQueue()

    expect(() =>
      queue.enqueue({
        type: 'commitBlueprint',
        payload: {
          rect: { x: 4, y: 9, w: 10, h: 8 },
          material: 'concrete',
          objects: [{ id: 'bed', rotation: 0 }],
          replaceExisting: false,
          note: null,
        },
        issuedAtTick: 120,
      }),
    ).not.toThrow()
  })

  it('rejects payloads that would not survive the worker boundary', () => {
    const queue = new CommandQueue()

    expect(() => enqueueUnchecked(queue, () => 1)).toThrow(TypeError)
    expect(() => enqueueUnchecked(queue, undefined)).toThrow(TypeError)
    expect(() => enqueueUnchecked(queue, { when: new Date(0) })).toThrow(TypeError)
    expect(() => enqueueUnchecked(queue, { ids: new Set([1]) })).toThrow(TypeError)
    expect(() => enqueueUnchecked(queue, { count: Number.NaN })).toThrow(TypeError)
    expect(() => enqueueUnchecked(queue, { count: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(queue.size).toBe(0)
  })

  it('names the offending path when a payload is invalid', () => {
    const queue = new CommandQueue()
    const payload = { objects: [{ id: 'bed', onPlaced: () => undefined }] }

    expect(() => enqueueUnchecked(queue, payload)).toThrow('payload.objects[0].onPlaced')
  })

  it('rejects a cyclic payload rather than hanging', () => {
    const queue = new CommandQueue()
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic

    expect(() => enqueueUnchecked(queue, cyclic)).toThrow(/cyclic/)
  })

  it('rejects a malformed type or issuedAtTick', () => {
    const queue = new CommandQueue()

    expect(() => queue.enqueue({ type: '', payload: null, issuedAtTick: 0 })).toThrow(TypeError)
    expect(() => queue.enqueue({ type: 'x', payload: null, issuedAtTick: -1 })).toThrow(RangeError)
    expect(() => queue.enqueue({ type: 'x', payload: null, issuedAtTick: 1.5 })).toThrow(RangeError)
  })

  it('round-trips through serialise and restore', () => {
    const queue = new CommandQueue()
    queue.enqueueAll([command('a', 1), command('b', 2)])

    const restored = new CommandQueue()
    restored.restore(queue.serialise())

    expect(restored.drain()).toEqual(queue.drain())
  })
})
