/**
 * Minimal contraband surface for search / detection (T4.3).
 *
 * T4.2 owns the full illicit economy. Until that lands (or merges), search
 * needs a place to put carried items and tile stashes, confiscate them, and
 * hash the result. This stub is intentionally thin: acquisition vectors,
 * trading and throw-ins stay out of scope.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { InmateComponent } from '../entities/inmate'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface ContrabandStash {
  /** Tile index in the world's grid. */
  readonly tileIndex: number
  /** Contraband definition ids hidden at this tile. */
  readonly items: string[]
  /** Inmate who hid them, or 0 when unknown. */
  readonly ownerInmateId: number
}

/**
 * Carried + stashed contraband. Carried items also mirror onto
 * `InmateComponent.inventory` so inspectors and later tickets stay consistent.
 */
export class ContrabandStub {
  /** inmateId → carried contraband def ids. */
  readonly carried = new Map<number, string[]>()
  /** tileIndex → stash. */
  readonly stashes = new Map<number, ContrabandStash>()
  /** Running total of items confiscated (tests / contracts). */
  confiscatedCount = 0

  giveCarried(inmate: InmateComponent, inmateId: number, defId: string): void {
    const bag = this.carried.get(inmateId) ?? []
    bag.push(defId)
    this.carried.set(inmateId, bag)
    mutableInventory(inmate).push(defId)
  }

  carriedOf(inmateId: number): readonly string[] {
    return this.carried.get(inmateId) ?? []
  }

  /**
   * Removes every carried item for an inmate. Returns the confiscated def ids.
   */
  confiscateCarried(inmate: InmateComponent, inmateId: number): string[] {
    const bag = this.carried.get(inmateId) ?? []
    const taken = bag.splice(0, bag.length)
    if (bag.length === 0) this.carried.delete(inmateId)
    else this.carried.set(inmateId, bag)
    const inv = mutableInventory(inmate)
    inv.splice(0, inv.length)
    this.confiscatedCount += taken.length
    return taken
  }

  /**
   * Rolls each carried item independently. Items that fail stay on the inmate.
   */
  confiscateCarriedWithChance(
    inmate: InmateComponent,
    inmateId: number,
    chance: number,
    roll: () => boolean,
  ): string[] {
    const bag = this.carried.get(inmateId) ?? []
    if (bag.length === 0) return []
    const kept: string[] = []
    const taken: string[] = []
    for (const defId of bag) {
      if (chance >= 1 || (chance > 0 && roll())) taken.push(defId)
      else kept.push(defId)
    }
    if (kept.length === 0) this.carried.delete(inmateId)
    else this.carried.set(inmateId, kept)
    const inv = mutableInventory(inmate)
    inv.splice(0, inv.length, ...kept)
    this.confiscatedCount += taken.length
    return taken
  }

  hideAt(tileIndex: number, items: readonly string[], ownerInmateId = 0): ContrabandStash {
    const existing = this.stashes.get(tileIndex)
    if (existing !== undefined) {
      existing.items.push(...items)
      return existing
    }
    const stash: ContrabandStash = {
      tileIndex,
      items: [...items],
      ownerInmateId,
    }
    this.stashes.set(tileIndex, stash)
    return stash
  }

  /**
   * Attempts to find each item in a stash. Returns confiscated ids; empties
   * the stash when nothing remains.
   */
  searchStash(tileIndex: number, chance: number, roll: () => boolean): string[] {
    const stash = this.stashes.get(tileIndex)
    if (stash === undefined) return []
    const kept: string[] = []
    const taken: string[] = []
    for (const defId of stash.items) {
      if (chance >= 1 || (chance > 0 && roll())) taken.push(defId)
      else kept.push(defId)
    }
    if (kept.length === 0) this.stashes.delete(tileIndex)
    else {
      stash.items.splice(0, stash.items.length, ...kept)
    }
    this.confiscatedCount += taken.length
    return taken
  }

  /** Clears a stash entirely (cell search / shakedown certainty paths). */
  clearStash(tileIndex: number): string[] {
    const stash = this.stashes.get(tileIndex)
    if (stash === undefined) return []
    const taken = stash.items.splice(0, stash.items.length)
    this.stashes.delete(tileIndex)
    this.confiscatedCount += taken.length
    return taken
  }

  stashCount(): number {
    return this.stashes.size
  }

  itemCount(): number {
    let total = 0
    for (const bag of this.carried.values()) total += bag.length
    for (const stash of this.stashes.values()) total += stash.items.length
    return total
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.confiscatedCount)
    const carriedIds = [...this.carried.keys()].sort((a, b) => a - b)
    hasher.writeUint32(carriedIds.length)
    for (const id of carriedIds) {
      hasher.writeUint32(id)
      const bag = this.carried.get(id) ?? []
      hasher.writeUint32(bag.length)
      for (const defId of bag) hasher.writeString(defId)
    }
    const tiles = [...this.stashes.keys()].sort((a, b) => a - b)
    hasher.writeUint32(tiles.length)
    for (const tile of tiles) {
      const stash = this.stashes.get(tile)
      if (stash === undefined) continue
      hasher.writeUint32(tile)
      hasher.writeUint32(stash.ownerInmateId)
      hasher.writeUint32(stash.items.length)
      for (const defId of stash.items) hasher.writeString(defId)
    }
  }
}

function mutableInventory(inmate: InmateComponent): string[] {
  // Inventory is created as a mutable array; the component type marks it
  // readonly so callers do not casually push. Search / the stub own writes.
  return inmate.inventory as string[]
}
