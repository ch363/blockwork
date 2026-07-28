import { describe, expect, it } from 'vitest'

import { Fnv1aHasher } from '../../src/core/hash'
import { loadGameData } from '../../src/data/loader'
import { DOOR_TYPES } from '../../src/data/schemas'
import type { DoorType } from '../../src/data/schemas'
import {
  DoorRegistry,
  doorPassability,
  doorTypeIndex,
  initialLockState,
} from '../../src/world/doors'
import { PASSABILITY } from '../../src/world/tileGrid'

const DATA = loadGameData()

function def(type: DoorType) {
  return DATA.doors.get(type)
}

describe('door definitions (T1.2)', () => {
  it('defines all six types the build tool offers', () => {
    expect(DATA.doors.ids()).toEqual([...DOOR_TYPES])
  })

  it('gives every type a distinct stable index for hashing', () => {
    const indices = DOOR_TYPES.map((type) => doorTypeIndex(type))
    expect(new Set(indices).size).toBe(DOOR_TYPES.length)
    expect(doorTypeIndex('standard')).toBe(0)
  })
})

describe('doorPassability (PRD 4.3, 4.5)', () => {
  it('marks every unlocked door walkable and a door', () => {
    for (const type of DOOR_TYPES) {
      const mask = doorPassability(def(type), false)
      expect(mask & PASSABILITY.WALKABLE).toBe(PASSABILITY.WALKABLE)
      expect(mask & PASSABILITY.DOOR).toBe(PASSABILITY.DOOR)
    }
  })

  it('keeps a locked door in the region graph but takes it out of the walk', () => {
    const mask = doorPassability(def('isolation'), true)

    expect(mask & PASSABILITY.WALKABLE).toBe(0)
    expect(mask & PASSABILITY.DOOR).toBe(PASSABILITY.DOOR)
  })

  it('carries the access bits its definition declares', () => {
    expect(doorPassability(def('standard'), false)).toBe(PASSABILITY.WALKABLE | PASSABILITY.DOOR)

    expect(doorPassability(def('staff'), false)).toBe(
      PASSABILITY.WALKABLE | PASSABILITY.DOOR | PASSABILITY.STAFF_ONLY,
    )

    expect(doorPassability(def('secure'), false)).toBe(
      PASSABILITY.WALKABLE | PASSABILITY.DOOR | PASSABILITY.SECURE,
    )

    expect(doorPassability(def('isolation'), false)).toBe(
      PASSABILITY.WALKABLE | PASSABILITY.DOOR | PASSABILITY.STAFF_ONLY | PASSABILITY.SECURE,
    )
  })

  it('starts secure housing doors locked and open doors unlocked', () => {
    expect(initialLockState(def('standard'))).toBe(false)
    expect(initialLockState(def('barred'))).toBe(true)
    expect(initialLockState(def('isolation'))).toBe(true)
    expect(initialLockState(def('remote'))).toBe(true)
  })
})

describe('DoorRegistry', () => {
  it('places, finds, relocks and removes doors by tile', () => {
    const doors = new DoorRegistry()

    doors.place(42, 'secure', false)

    expect(doors.size).toBe(1)
    expect(doors.has(42)).toBe(true)
    expect(doors.get(42)?.type).toBe('secure')
    expect(doors.get(42)?.locked).toBe(false)

    expect(doors.setLocked(42, true)).toBe(true)
    expect(doors.get(42)?.locked).toBe(true)
    expect(doors.setLocked(7, true)).toBe(false)

    expect(doors.remove(42)?.type).toBe('secure')
    expect(doors.has(42)).toBe(false)
    expect(doors.remove(42)).toBeUndefined()
  })

  it('iterates in tile order whatever order doors were placed in', () => {
    const forwards = new DoorRegistry()
    forwards.place(3, 'standard', false)
    forwards.place(11, 'barred', true)
    forwards.place(7, 'staff', false)

    const backwards = new DoorRegistry()
    backwards.place(7, 'staff', false)
    backwards.place(11, 'barred', true)
    backwards.place(3, 'standard', false)

    expect(forwards.indices()).toEqual([3, 7, 11])
    expect(forwards.entries()).toEqual(backwards.entries())
  })

  it('hashes placement order out and lock state in', () => {
    const digest = (doors: DoorRegistry): number => {
      const hasher = new Fnv1aHasher()
      doors.hashInto(hasher)
      return hasher.digest()
    }

    const a = new DoorRegistry()
    a.place(3, 'standard', false)
    a.place(11, 'barred', true)

    const b = new DoorRegistry()
    b.place(11, 'barred', true)
    b.place(3, 'standard', false)

    expect(digest(a)).toBe(digest(b))

    b.setLocked(3, true)
    expect(digest(a)).not.toBe(digest(b))
  })
})
