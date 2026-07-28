/**
 * Water pipe overlay and per-network flow multipliers (T5.5, PRD 5.12).
 *
 * Pipe presence lives beside `TileGrid`. Connected component ids are written
 * into `TileGrid.waterGridId`. Insufficient pump flow never hard-stops a
 * fixture — it lowers `useMultiplier` so need discharge slows instead.
 */

import type { Fnv1aHasher } from '../core/hash'
import { tileCount } from './coords'

/** `waterGridId` 0: tile is on no water network. */
export const NO_WATER_BRANCH = 0

/**
 * Per-tile pipe presence and the flow multiplier for each water-grid id.
 *
 * Multipliers are indexed by branch id; index 0 is unused. Values are in
 * 0..1 (`1` = full flow). Absent ids read as `1` so untracked worlds do not
 * accidentally starve fixtures.
 */
export class WaterGrid {
  readonly size: number
  readonly hasPipe: Uint8Array
  /** Flow fraction per `waterGridId`. Sparse: only ids with pumps are written. */
  readonly useMultiplierByBranch = new Map<number, number>()

  constructor(size: number) {
    this.size = size
    this.hasPipe = new Uint8Array(tileCount(size))
  }

  hasPipeAt(tileIndex: number): boolean {
    return (this.hasPipe[tileIndex] ?? 0) !== 0
  }

  setPipe(tileIndex: number, present: boolean): void {
    if (tileIndex < 0 || tileIndex >= this.hasPipe.length) return
    this.hasPipe[tileIndex] = present ? 1 : 0
  }

  clearMultipliers(): void {
    this.useMultiplierByBranch.clear()
  }

  setUseMultiplier(branchId: number, multiplier: number): void {
    if (branchId <= 0) return
    const clamped = multiplier < 0 ? 0 : multiplier > 1 ? 1 : multiplier
    this.useMultiplierByBranch.set(branchId, clamped)
  }

  /**
   * Fixture-use scale for a tile. Unconnected tiles return 0 so callers that
   * still ask (before `hasWater` is cleared) get a hard stop; connected but
   * under-supplied tiles return (0, 1].
   */
  useMultiplierAt(waterGridId: number): number {
    if (waterGridId <= 0) return 0
    return this.useMultiplierByBranch.get(waterGridId) ?? 1
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.size)
    let pipes = 0
    for (let i = 0; i < this.hasPipe.length; i += 1) {
      if ((this.hasPipe[i] ?? 0) === 0) continue
      pipes += 1
      hasher.writeUint32(i)
    }
    hasher.writeUint32(pipes)
    const entries = [...this.useMultiplierByBranch.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(entries.length)
    for (const [id, mult] of entries) {
      hasher.writeUint32(id)
      hasher.writeFloat64(mult)
    }
  }
}
