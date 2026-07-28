/**
 * Contraband world state: tile stashes, arranged throw-ins, live prices (T4.2).
 *
 * Lives outside `contrabandSystem.ts` so `InmateWorld` can own it without a
 * circular import through the system module.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { InmateComponent } from './inmate'

export interface ContrabandStash {
  readonly id: number
  tileIndex: number
  itemId: string
  /** Inmate who hid it, or 0 for unclaimed drops / contamination. */
  ownerInmateId: number
}

export interface ArrangedThrowIn {
  readonly id: number
  inmateId: number
  itemId: string
  tileIndex: number
  collectTick: number
  resolved: boolean
}

/**
 * Prison-wide illicit economy state: stashes, arranged throw-ins, live prices.
 */
export class ContrabandState {
  readonly stashes: ContrabandStash[] = []
  readonly throwIns: ArrangedThrowIn[] = []
  /** Live market price per contraband item id. */
  readonly prices = new Map<string, number>()
  /** Inmate ids waiting for an arrival-possession roll (T4.2). */
  readonly pendingArrivalIds: number[] = []
  /** Delivery lines waiting for a contamination roll (T4.2). */
  readonly pendingDeliveryLines: {
    itemId: string
    units: number
    truckId: number
  }[] = []
  #nextStashId = 1
  #nextThrowInId = 1

  queueArrival(inmateId: number): void {
    this.pendingArrivalIds.push(inmateId)
  }

  takePendingArrivals(): number[] {
    const ids = this.pendingArrivalIds.slice()
    this.pendingArrivalIds.length = 0
    return ids
  }

  queueDelivery(itemId: string, units: number, truckId: number): void {
    this.pendingDeliveryLines.push({ itemId, units, truckId })
  }

  takePendingDeliveries(): { itemId: string; units: number; truckId: number }[] {
    const lines = this.pendingDeliveryLines.slice()
    this.pendingDeliveryLines.length = 0
    return lines
  }

  addStash(tileIndex: number, itemId: string, ownerInmateId: number): ContrabandStash {
    const stash: ContrabandStash = {
      id: this.#nextStashId,
      tileIndex,
      itemId,
      ownerInmateId,
    }
    this.#nextStashId += 1
    this.stashes.push(stash)
    return stash
  }

  removeStash(stashId: number): ContrabandStash | undefined {
    const index = this.stashes.findIndex((entry) => entry.id === stashId)
    if (index < 0) return undefined
    const [removed] = this.stashes.splice(index, 1)
    return removed
  }

  addThrowIn(options: {
    readonly inmateId: number
    readonly itemId: string
    readonly tileIndex: number
    readonly collectTick: number
  }): ArrangedThrowIn {
    const entry: ArrangedThrowIn = {
      id: this.#nextThrowInId,
      inmateId: options.inmateId,
      itemId: options.itemId,
      tileIndex: options.tileIndex,
      collectTick: options.collectTick,
      resolved: false,
    }
    this.#nextThrowInId += 1
    this.throwIns.push(entry)
    return entry
  }


  /** Running total of items confiscated by searches (T4.3). */
  confiscatedCount = 0

  /** Give carried contraband; mirrors onto inmate inventory (T4.2 + T4.3). */
  giveCarried(inmate: InmateComponent, _inmateId: number, defId: string): void {
    mutableInventory(inmate).push(defId)
  }

  /** Carried items live on the inmate inventory after T4.2. */
  carriedOf(inmate: InmateComponent): readonly string[] {
    return inmate.inventory
  }

  confiscateCarried(inmate: InmateComponent, _inmateId: number): string[] {
    const inv = mutableInventory(inmate)
    const taken = inv.splice(0, inv.length)
    this.confiscatedCount += taken.length
    return taken
  }

  confiscateCarriedWithChance(
    inmate: InmateComponent,
    _inmateId: number,
    chance: number,
    roll: () => boolean,
  ): string[] {
    const inv = mutableInventory(inmate)
    if (inv.length === 0) return []
    const kept: string[] = []
    const taken: string[] = []
    for (const defId of inv) {
      if (chance >= 1 || (chance > 0 && roll())) taken.push(defId)
      else kept.push(defId)
    }
    inv.splice(0, inv.length, ...kept)
    this.confiscatedCount += taken.length
    return taken
  }

  /** Hide one or more items at a tile (search tests / AI stash). */
  hideAt(tileIndex: number, items: readonly string[], ownerInmateId = 0): void {
    for (const itemId of items) {
      this.addStash(tileIndex, itemId, ownerInmateId)
    }
  }

  /**
   * Roll each stash item at a tile independently. Removes found stashes.
   */
  searchStash(tileIndex: number, chance: number, roll: () => boolean): string[] {
    const taken: string[] = []
    const kept: ContrabandStash[] = []
    for (const stash of this.stashes) {
      if (stash.tileIndex !== tileIndex) {
        kept.push(stash)
        continue
      }
      if (chance >= 1 || (chance > 0 && roll())) {
        taken.push(stash.itemId)
      } else {
        kept.push(stash)
      }
    }
    this.stashes.length = 0
    this.stashes.push(...kept)
    this.confiscatedCount += taken.length
    return taken
  }

  stashCount(): number {
    const tiles = new Set<number>()
    for (const stash of this.stashes) tiles.add(stash.tileIndex)
    return tiles.size
  }

  clearStash(tileIndex: number): string[] {
    const taken: string[] = []
    const kept: ContrabandStash[] = []
    for (const stash of this.stashes) {
      if (stash.tileIndex === tileIndex) taken.push(stash.itemId)
      else kept.push(stash)
    }
    this.stashes.length = 0
    this.stashes.push(...kept)
    this.confiscatedCount += taken.length
    return taken
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.confiscatedCount)
    hasher.writeUint32(this.#nextStashId)
    hasher.writeUint32(this.#nextThrowInId)
    hasher.writeUint32(this.pendingArrivalIds.length)
    for (const id of this.pendingArrivalIds) hasher.writeUint32(id)
    hasher.writeUint32(this.pendingDeliveryLines.length)
    for (const line of this.pendingDeliveryLines) {
      hasher.writeString(line.itemId)
      hasher.writeUint32(line.units)
      hasher.writeUint32(line.truckId)
    }
    hasher.writeUint32(this.stashes.length)
    for (const stash of this.stashes) {
      hasher.writeUint32(stash.id)
      hasher.writeUint32(stash.tileIndex)
      hasher.writeString(stash.itemId)
      hasher.writeUint32(stash.ownerInmateId)
    }
    hasher.writeUint32(this.throwIns.length)
    for (const entry of this.throwIns) {
      hasher.writeUint32(entry.id)
      hasher.writeUint32(entry.inmateId)
      hasher.writeString(entry.itemId)
      hasher.writeUint32(entry.tileIndex)
      hasher.writeUint32(entry.collectTick)
      hasher.writeUint32(entry.resolved ? 1 : 0)
    }
    const prices = [...this.prices.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    hasher.writeUint32(prices.length)
    for (const [itemId, price] of prices) {
      hasher.writeString(itemId)
      hasher.writeUint32(price)
    }
  }
}

export function createContrabandState(): ContrabandState {
  return new ContrabandState()
}

function mutableInventory(inmate: InmateComponent): string[] {
  return inmate.inventory as string[]
}
