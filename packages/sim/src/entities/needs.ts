/**
 * Inmate needs: stable index, fill/discharge maths, and per-inmate runtime
 * state for object use (T2.5, PRD 5.4).
 *
 * Needs live as a `Float32Array` on each inmate, keyed by file order in
 * `needs.json`. That order is part of the save contract — reordering the file
 * silently remaps every stored value — so `NeedIndex` fingerprints the order
 * and refuses to reconcile a mismatched list rather than guessing.
 *
 * Fill and discharge are pure over definitions + context so unit tests can
 * assert the minute maths without a world. The system layer (`needsSystem`)
 * gathers context, applies the deltas, and fires critical behaviours.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import type { Balance, NeedDef, NeedDriver } from '../data/schemas'
import { NO_OBJECT, isOperational } from './objects'
import type { ObjectEntity, ObjectRegistry } from './objects'
import type { InmateEntity, InmateRegistry } from './inmate'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const NEED_MIN = 0
export const NEED_MAX = 100

/** CausalEvent kinds emitted by the needs system. */
export const NEEDS_EVENTS = {
  critical: 'needs.critical',
  rejected: 'needs.rejected',
} as const

export type NeedsRejection = 'object-busy' | 'object-missing' | 'object-unusable' | 'unknown-inmate'

/* -------------------------------------------------------------------------- */
/* Need index                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stable mapping from need id ↔ typed-array index, locked to `needs.json`
 * order at load.
 */
export class NeedIndex {
  readonly order: readonly string[]
  readonly defs: readonly NeedDef[]
  readonly #byId: ReadonlyMap<string, number>

  constructor(defs: readonly NeedDef[]) {
    this.defs = defs
    this.order = defs.map((def) => def.id)
    const byId = new Map<string, number>()
    defs.forEach((def, index) => {
      byId.set(def.id, index)
    })
    this.#byId = byId
  }

  static fromData(data: GameData): NeedIndex {
    return new NeedIndex(data.needs.all)
  }

  get size(): number {
    return this.defs.length
  }

  indexOf(id: string): number {
    return this.#byId.get(id) ?? -1
  }

  /** Throws when the id is unknown — safe after load. */
  require(id: string): number {
    const index = this.#byId.get(id)
    if (index === undefined) {
      throw new Error(`unknown need '${id}'`)
    }
    return index
  }

  defAt(index: number): NeedDef {
    const def = this.defs[index]
    if (def === undefined) {
      throw new RangeError(`need index ${index} out of range 0..${this.size - 1}`)
    }
    return def
  }

  idAt(index: number): string {
    return this.defAt(index).id
  }

  /**
   * Verifies that `order` is exactly this index's file order.
   *
   * Saves and tests pass the order they believe the Float32Arrays were laid
   * out with. A reorder of `needs.json` must throw here rather than quietly
   * remapping bladder onto sleep.
   */
  assertCompatible(order: readonly string[]): void {
    if (order.length !== this.order.length) {
      throw new Error(
        `need order length mismatch: expected ${this.order.length}, got ${order.length}`,
      )
    }
    for (let i = 0; i < this.order.length; i += 1) {
      const expected = this.order[i]
      const actual = order[i]
      if (expected !== actual) {
        throw new Error(
          `need order mismatch at index ${i}: expected '${expected}', got '${actual}'`,
        )
      }
    }
  }

  /** Allocates a zeroed need vector for a new inmate. */
  allocate(): Float32Array {
    return new Float32Array(this.size)
  }

  /**
   * Reads a need value. Throws if the array length does not match this index
   * — a length mismatch is the other way silent corruption arrives.
   */
  get(values: Float32Array, id: string): number {
    assertNeedLength(values, this.size)
    return values[this.require(id)] ?? 0
  }

  set(values: Float32Array, id: string, value: number): void {
    assertNeedLength(values, this.size)
    values[this.require(id)] = clampNeed(value)
  }
}

export function assertNeedLength(values: Float32Array, expected: number): void {
  if (values.length !== expected) {
    throw new Error(`need array length mismatch: expected ${expected}, got ${values.length}`)
  }
}

export function clampNeed(value: number): number {
  if (value <= NEED_MIN) return NEED_MIN
  if (value >= NEED_MAX) return NEED_MAX
  return value
}

/* -------------------------------------------------------------------------- */
/* Per-inmate runtime                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Mutable activity state the needs system (and later ActivitySystem) shares.
 *
 * `criticalLatch` records which needs are currently at-or-above critical so
 * crossings fire once on the rising edge.
 */
export interface InmateNeedState {
  /** Object being used for discharge, or `NO_OBJECT`. */
  usingObjectId: number
  /** Freedom fill × `freedomLockedUpMultiplier` while true. */
  lockedUp: boolean
  /** One byte per need: 1 while the need sits at critical. */
  readonly criticalLatch: Uint8Array
  /** Set by the `seekWeapon` critical behaviour until combat resolves it. */
  seekingWeapon: boolean
  /** Set by the `digTunnel` critical behaviour until security resolves it. */
  diggingTunnel: boolean
  /** Minutes spent with food at critical since the last drop below. */
  starveMinutes: number
}

export function createInmateNeedState(needCount: number): InmateNeedState {
  return {
    usingObjectId: NO_OBJECT,
    lockedUp: false,
    criticalLatch: new Uint8Array(needCount),
    seekingWeapon: false,
    diggingTunnel: false,
    starveMinutes: 0,
  }
}

/**
 * Runtime map keyed by inmate id. Lives on `InmateWorld` so ActivitySystem
 * (T2.6) can claim objects without reaching into the needs system.
 */
export class NeedsRuntime {
  readonly #byInmate = new Map<number, InmateNeedState>()
  readonly #usersByObject = new Map<number, Set<number>>()
  readonly needCount: number

  constructor(needCount: number) {
    this.needCount = needCount
  }

  stateOf(inmateId: number): InmateNeedState {
    let state = this.#byInmate.get(inmateId)
    if (state === undefined) {
      state = createInmateNeedState(this.needCount)
      this.#byInmate.set(inmateId, state)
    }
    return state
  }

  /** Drops runtime state when an inmate leaves the prison. */
  remove(inmateId: number): void {
    const state = this.#byInmate.get(inmateId)
    if (state === undefined) return
    this.#clearUse(inmateId, state)
    this.#byInmate.delete(inmateId)
  }

  usersOf(objectId: number): number {
    return this.#usersByObject.get(objectId)?.size ?? 0
  }

  /**
   * Claims an object for discharge. Enforces `concurrentUsers` on the first
   * served-need entry that lists a cap (all entries share the same fixture).
   *
   * @returns undefined on success, or a rejection reason.
   */
  beginUsing(
    inmateId: number,
    object: ObjectEntity,
    defServes: readonly { readonly need: string; readonly concurrentUsers: number }[],
  ): NeedsRejection | undefined {
    if (defServes.length === 0) return 'object-unusable'
    if (!isOperational(object)) return 'object-unusable'

    const cap = defServes[0]?.concurrentUsers ?? 1
    const current = this.usersOf(object.id)
    const state = this.stateOf(inmateId)
    const alreadyHere = state.usingObjectId === object.id
    if (!alreadyHere && current >= cap) return 'object-busy'

    if (state.usingObjectId !== NO_OBJECT && state.usingObjectId !== object.id) {
      this.#clearUse(inmateId, state)
    }

    state.usingObjectId = object.id
    let users = this.#usersByObject.get(object.id)
    if (users === undefined) {
      users = new Set()
      this.#usersByObject.set(object.id, users)
    }
    users.add(inmateId)
    return undefined
  }

  endUsing(inmateId: number): void {
    const state = this.#byInmate.get(inmateId)
    if (state === undefined) return
    this.#clearUse(inmateId, state)
  }

  hashInto(hasher: Fnv1aHasher): void {
    const ids = [...this.#byInmate.keys()].sort((a, b) => a - b)
    hasher.writeUint32(ids.length)
    for (const id of ids) {
      const state = this.#byInmate.get(id)
      if (state === undefined) continue
      hasher.writeUint32(id)
      hasher.writeUint32(state.usingObjectId)
      hasher.writeUint32(state.lockedUp ? 1 : 0)
      hasher.writeUint32(state.seekingWeapon ? 1 : 0)
      hasher.writeUint32(state.diggingTunnel ? 1 : 0)
      hasher.writeUint32(state.starveMinutes)
      hasher.writeUint32(state.criticalLatch.length)
      for (let i = 0; i < state.criticalLatch.length; i += 1) {
        hasher.writeUint32(state.criticalLatch[i] ?? 0)
      }
    }
  }

  #clearUse(inmateId: number, state: InmateNeedState): void {
    const objectId = state.usingObjectId
    if (objectId === NO_OBJECT) return
    const users = this.#usersByObject.get(objectId)
    if (users !== undefined) {
      users.delete(inmateId)
      if (users.size === 0) this.#usersByObject.delete(objectId)
    }
    state.usingObjectId = NO_OBJECT
  }
}

/* -------------------------------------------------------------------------- */
/* Fill / discharge maths                                                      */
/* -------------------------------------------------------------------------- */

export interface NeedFillContext {
  readonly lockedUp: boolean
  /** Prison-wide danger 0..100 (SecuritySystem). */
  readonly dangerLevel: number
  /** Mean dirt of the inmate's current room, 0..255. */
  readonly meanRoomDirt: number
  /** Other inmates sharing the room (privacy). */
  readonly nearbyInmateCount: number
  /** Tile temperature in °C. */
  readonly temperatureC: number
  readonly traits: readonly string[]
  readonly addictions: readonly { readonly substance: string; readonly strength: number }[]
}

export type NeedFillResult =
  | { readonly mode: 'add'; readonly delta: number }
  | { readonly mode: 'set'; readonly value: number }
  | { readonly mode: 'skip' }

/**
 * How one need moves this minute from its driver, before discharge.
 *
 * Additive drivers return a delta to add; contextual drivers return an absolute
 * value to write. Trait-gated needs that do not apply return `skip`.
 */
export function computeNeedFill(
  def: NeedDef,
  balance: Balance['needs'],
  ctx: NeedFillContext,
): NeedFillResult {
  if (def.onlyWithTrait !== undefined && !ctx.traits.includes(def.onlyWithTrait)) {
    return { mode: 'skip' }
  }

  switch (def.driver as NeedDriver) {
    case 'time':
      return { mode: 'add', delta: def.fillPerMinute }

    case 'confinement': {
      const mult = ctx.lockedUp ? balance.freedomLockedUpMultiplier : 1
      return { mode: 'add', delta: def.fillPerMinute * mult }
    }

    case 'addiction': {
      const substance = def.id === 'alcohol' ? 'alcohol' : 'narcotics'
      const addiction = ctx.addictions.find((entry) => entry.substance === substance)
      if (addiction === undefined) return { mode: 'skip' }
      return { mode: 'add', delta: def.fillPerMinute * addiction.strength }
    }

    case 'danger':
      return { mode: 'set', value: clampNeed(ctx.dangerLevel) }

    case 'dirt':
      return {
        mode: 'set',
        value: clampNeed(ctx.meanRoomDirt * balance.environmentDirtScale),
      }

    case 'proximity':
      return {
        mode: 'set',
        value: clampNeed(ctx.nearbyInmateCount * balance.privacyPerNeighbour),
      }

    case 'temperature': {
      const threshold = balance.warmthColdThresholdC
      if (ctx.temperatureC >= threshold) return { mode: 'set', value: 0 }
      const degrees = threshold - ctx.temperatureC
      return {
        mode: 'set',
        value: clampNeed(degrees * balance.warmthPerDegreeBelow),
      }
    }
  }
}

/**
 * Applies one minute of fill to every need on an inmate.
 *
 * @returns the values after fill (mutates `values` in place).
 */
export function applyNeedFills(
  values: Float32Array,
  index: NeedIndex,
  balance: Balance['needs'],
  ctx: NeedFillContext,
): void {
  assertNeedLength(values, index.size)
  for (let i = 0; i < index.size; i += 1) {
    const def = index.defAt(i)
    const result = computeNeedFill(def, balance, ctx)
    if (result.mode === 'skip') continue
    if (result.mode === 'set') {
      values[i] = result.value
    } else {
      values[i] = clampNeed((values[i] ?? 0) + result.delta)
    }
  }
}

/**
 * Subtracts `decayOnUse` for every need the object serves, while the inmate
 * holds a use claim. Values clamp at zero.
 */
export function applyNeedDischarge(
  values: Float32Array,
  index: NeedIndex,
  servedNeeds: readonly { readonly need: string }[],
  scale = 1,
): void {
  assertNeedLength(values, index.size)
  for (const served of servedNeeds) {
    const needIndex = index.indexOf(served.need)
    if (needIndex < 0) continue
    const def = index.defAt(needIndex)
    values[needIndex] = clampNeed((values[needIndex] ?? 0) - def.decayOnUse * scale)
  }
}

/* -------------------------------------------------------------------------- */
/* World helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mean dirt of the room containing `tileIndex`, falling back to that tile's
 * dirt when the inmate stands outside any room.
 */
export function meanRoomDirt(
  grid: {
    readonly size: number
    readonly dirt: Uint8Array
    getAt(field: 'roomId', index: number): number
  },
  rooms: { get(id: number): { readonly tiles: readonly number[] } | undefined },
  tileIndex: number,
): number {
  const roomId = grid.getAt('roomId', tileIndex)
  const room = rooms.get(roomId)
  if (room === undefined || room.tiles.length === 0) {
    return grid.dirt[tileIndex] ?? 0
  }
  let sum = 0
  for (const tile of room.tiles) {
    sum += grid.dirt[tile] ?? 0
  }
  return sum / room.tiles.length
}

/**
 * Counts inmates standing in the same room as `entity` (by tile roomId),
 * excluding self. Privacy is about crowding where they are, not their
 * assigned housing.
 */
export function nearbyInmatesInTileRoom(
  inmates: InmateRegistry,
  grid: { readonly size: number; getAt(field: 'roomId', index: number): number },
  entity: InmateEntity,
): number {
  const selfTile = entity.ty * grid.size + entity.tx
  const roomId = grid.getAt('roomId', selfTile)
  if (roomId === 0) return 0

  let count = 0
  for (const other of inmates.all()) {
    if (other.id === entity.id) continue
    const otherTile = other.ty * grid.size + other.tx
    if (grid.getAt('roomId', otherTile) === roomId) count += 1
  }
  return count
}

export function resolveUsingObject(
  objects: ObjectRegistry,
  usingObjectId: number,
): ObjectEntity | undefined {
  if (usingObjectId === NO_OBJECT) return undefined
  return objects.get(usingObjectId)
}
