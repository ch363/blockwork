/**
 * Electrical cable overlay and load-shedding branch state (T5.5, PRD 5.12).
 *
 * Cable presence lives beside `TileGrid` (like `FireGrid`) because PRD 4.3 does
 * not list a cable material slot — floors and cables share a tile. Connected
 * components and brownout branch ids are written into `TileGrid.powerGridId`.
 */

import type { Fnv1aHasher } from '../core/hash'
import { tileCount } from './coords'

/** `powerGridId` / shed bookkeeping: 0 means no live or shed branch. */
export const NO_POWER_BRANCH = 0

/**
 * Per-tile cable presence plus the set of browned-out branch ids for this map.
 */
export class PowerGrid {
  readonly size: number
  /** 1 when a cable (or conductive utility object footprint) occupies the tile. */
  readonly hasCable: Uint8Array
  /** Branch ids currently shed for overload (mirrors fire electrical ignition). */
  readonly shedBranches = new Set<number>()

  constructor(size: number) {
    this.size = size
    this.hasCable = new Uint8Array(tileCount(size))
  }

  hasCableAt(tileIndex: number): boolean {
    return (this.hasCable[tileIndex] ?? 0) !== 0
  }

  setCable(tileIndex: number, present: boolean): void {
    if (tileIndex < 0 || tileIndex >= this.hasCable.length) return
    this.hasCable[tileIndex] = present ? 1 : 0
  }

  isBranchShed(branchId: number): boolean {
    return branchId > 0 && this.shedBranches.has(branchId)
  }

  markBranchShed(branchId: number): void {
    if (branchId <= 0) return
    this.shedBranches.add(branchId)
  }

  clearShedBranches(): void {
    this.shedBranches.clear()
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.size)
    let cables = 0
    for (let i = 0; i < this.hasCable.length; i += 1) {
      if ((this.hasCable[i] ?? 0) === 0) continue
      cables += 1
      hasher.writeUint32(i)
    }
    hasher.writeUint32(cables)
    hasher.writeUint32(this.shedBranches.size)
    for (const id of [...this.shedBranches].sort((a, b) => a - b)) {
      hasher.writeUint32(id)
    }
  }
}
