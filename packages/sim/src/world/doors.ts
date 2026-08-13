/**
 * Doors: the holes in the prison, and the only part of a wall line that an
 * agent may cross (T1.2, PRD 4.5).
 *
 * A door is two things at once. To the tile grid it is a `passability` mask,
 * and to the region graph it is an edge, which is why `PASSABILITY.DOOR` is a
 * flag of its own rather than a kind of walkable: the pathfinder needs to know
 * a tile is a door before it knows whether this particular agent may use it.
 *
 * The mask is derived, never stored twice. `materials.json` gives each type
 * the two access facts it has — is it staff only, is it inside a secure
 * boundary — and `doorPassability` turns those plus the live lock state into
 * the bits the grid holds. A locked door keeps its `DOOR` bit and loses
 * `WALKABLE`: it is still an edge in the region graph, still a queue point,
 * still somewhere a guard can be sent to open it, but nobody walks through it
 * this tick.
 *
 * Lock state is per door, not per type, because it changes at runtime: cell
 * doors lock at night, isolation doors stay locked, remote doors open only
 * when a control room says so (T4.6). The registry is therefore world state
 * and hashes into the determinism fingerprint.
 */

import type { Fnv1aHasher } from '../core/hash'
import { DOOR_TYPES } from '../data/schemas'
import type { DoorDef, DoorType } from '../data/schemas'

import { PASSABILITY } from './tileGrid'

/** One placed door. Its type is fixed; its lock state is not. */
export interface Door {
  readonly type: DoorType
  locked: boolean
}

/** A door and the tile it stands on, for ordered iteration. */
export interface PlacedDoor extends Door {
  readonly tileIndex: number
}

/** Stable integer per type, for hashing and for typed-array storage in saves. */
export function doorTypeIndex(type: DoorType): number {
  return DOOR_TYPES.indexOf(type)
}

export function isDoorType(value: string): value is DoorType {
  return (DOOR_TYPES as readonly string[]).includes(value)
}

/**
 * The `passability` bits a door contributes.
 *
 * `DOOR` is unconditional: a locked door is still a door, and a region graph
 * that forgot about it would route agents around a corridor they are one
 * unlock away from using.
 */
export function doorPassability(def: DoorDef, locked: boolean): number {
  let mask = PASSABILITY.DOOR
  if (!locked) mask |= PASSABILITY.WALKABLE
  if (def.staffOnly) mask |= PASSABILITY.STAFF_ONLY
  if (def.secure) mask |= PASSABILITY.SECURE
  return mask
}

/** Whether a door of this type is locked the moment it is built. */
export function initialLockState(def: DoorDef): boolean {
  return def.lockable && def.startsLocked
}

/**
 * Every door in the world, keyed by tile index.
 *
 * A `Map` rather than a parallel typed array because doors are sparse — a
 * built prison has hundreds, against tens of thousands of tiles — and because
 * the grid already carries the derived mask, which is what the hot paths read.
 * Iteration is always in ascending tile order so that two runs which placed
 * the same doors in a different order still agree byte for byte.
 */
export class DoorRegistry {
  readonly #doors = new Map<number, Door>()

  get size(): number {
    return this.#doors.size
  }

  has(tileIndex: number): boolean {
    return this.#doors.has(tileIndex)
  }

  get(tileIndex: number): Door | undefined {
    return this.#doors.get(tileIndex)
  }

  /** Adds or replaces the door on a tile. */
  place(tileIndex: number, type: DoorType, locked: boolean): Door {
    const door: Door = { type, locked }
    this.#doors.set(tileIndex, door)
    return door
  }

  /** The removed door, or `undefined` if the tile had none. */
  remove(tileIndex: number): Door | undefined {
    const door = this.#doors.get(tileIndex)
    this.#doors.delete(tileIndex)
    return door
  }

  /** `false` if there is no door there. Callers decide whether that is a fault. */
  setLocked(tileIndex: number, locked: boolean): boolean {
    const door = this.#doors.get(tileIndex)
    if (door === undefined) return false
    door.locked = locked
    return true
  }

  /** Tile indices in ascending order. */
  indices(): number[] {
    return [...this.#doors.keys()].sort((a, b) => a - b)
  }

  /** Every door in ascending tile order. */
  entries(): PlacedDoor[] {
    const out: PlacedDoor[] = []
    for (const [tileIndex, door] of this.#doors) {
      out.push({ tileIndex, type: door.type, locked: door.locked })
    }
    out.sort((a, b) => a.tileIndex - b.tileIndex)
    return out
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#doors.size)
    for (const door of this.entries()) {
      hasher.writeUint32(door.tileIndex)
      hasher.writeUint32(doorTypeIndex(door.type))
      hasher.writeBoolean(door.locked)
    }
  }

  serialise(): readonly { readonly tileIndex: number; readonly type: DoorType; readonly locked: boolean }[] {
    return this.entries()
  }

  restore(doors: readonly { readonly tileIndex: number; readonly type: string; readonly locked: boolean }[]): void {
    this.#doors.clear()
    for (const entry of doors) {
      if (!isDoorType(entry.type)) continue
      this.place(entry.tileIndex, entry.type, entry.locked)
    }
  }
}
