/**
 * Per-tile fire intensity and smoke (T4.8).
 *
 * Lives beside `TileGrid` rather than inside it — PRD 4.3 does not list fire
 * fields, and EmergencySystem owns the emergency. Kept in its own module so
 * `InmateWorld` can hold a grid without importing the full fire system.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import { tileCount } from './coords'

/**
 * Per-tile fire and smoke. Intensity 0 is cold; smoke is independent so a
 * suppressed blaze still leaves a temporary movement / visibility penalty.
 */
export class FireGrid {
  readonly size: number
  /** 0..maxIntensity. */
  readonly intensity: Uint8Array
  /** 0..smokeMax. */
  readonly smoke: Uint8Array
  /**
   * Remaining fuel 0..255, seeded from local flammability when a tile ignites.
   * When fuel hits 0 the blaze decays instead of growing / spreading.
   */
  readonly fuel: Uint8Array
  /** Power-grid ids currently treated as overloaded (electrical ignition). */
  readonly overloadedBranches = new Set<number>()

  constructor(size: number) {
    this.size = size
    const tiles = tileCount(size)
    this.intensity = new Uint8Array(tiles)
    this.smoke = new Uint8Array(tiles)
    this.fuel = new Uint8Array(tiles)
  }

  intensityAt(tileIndex: number): number {
    return this.intensity[tileIndex] ?? 0
  }

  smokeAt(tileIndex: number): number {
    return this.smoke[tileIndex] ?? 0
  }

  isBurning(tileIndex: number): boolean {
    return this.intensityAt(tileIndex) > 0
  }

  /** Mark a power branch as overloaded so electrical faults can ignite. */
  markBranchOverloaded(powerGridId: number): void {
    if (powerGridId <= 0) return
    this.overloadedBranches.add(powerGridId)
  }

  clearBranchOverload(powerGridId: number): void {
    this.overloadedBranches.delete(powerGridId)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.size)
    let burning = 0
    let smoky = 0
    for (let i = 0; i < this.intensity.length; i += 1) {
      const intensity = this.intensity[i] ?? 0
      const smoke = this.smoke[i] ?? 0
      if (intensity > 0) {
        burning += 1
        hasher.writeUint32(i)
        hasher.writeUint32(intensity)
        hasher.writeUint32(this.fuel[i] ?? 0)
      }
      if (smoke > 0) {
        smoky += 1
        hasher.writeUint32(i)
        hasher.writeUint32(smoke)
      }
    }
    hasher.writeUint32(burning)
    hasher.writeUint32(smoky)
    hasher.writeUint32(this.overloadedBranches.size)
    for (const id of [...this.overloadedBranches].sort((a, b) => a - b)) {
      hasher.writeUint32(id)
    }
  }

  serialise(): {
    readonly size: number
    readonly burning: readonly {
      readonly tileIndex: number
      readonly intensity: number
      readonly fuel: number
    }[]
    readonly smoke: readonly { readonly tileIndex: number; readonly smoke: number }[]
    readonly overloadedBranches: readonly number[]
  } {
    const burning: { tileIndex: number; intensity: number; fuel: number }[] = []
    const smoke: { tileIndex: number; smoke: number }[] = []
    for (let i = 0; i < this.intensity.length; i += 1) {
      const intensity = this.intensity[i] ?? 0
      const smokeValue = this.smoke[i] ?? 0
      if (intensity > 0) {
        burning.push({ tileIndex: i, intensity, fuel: this.fuel[i] ?? 0 })
      }
      if (smokeValue > 0) {
        smoke.push({ tileIndex: i, smoke: smokeValue })
      }
    }
    return {
      size: this.size,
      burning,
      smoke,
      overloadedBranches: [...this.overloadedBranches].sort((a, b) => a - b),
    }
  }

  restore(snapshot: {
    readonly size: number
    readonly burning: readonly {
      readonly tileIndex: number
      readonly intensity: number
      readonly fuel: number
    }[]
    readonly smoke: readonly { readonly tileIndex: number; readonly smoke: number }[]
    readonly overloadedBranches: readonly number[]
  }): void {
    this.intensity.fill(0)
    this.smoke.fill(0)
    this.fuel.fill(0)
    this.overloadedBranches.clear()
    for (const entry of snapshot.burning) {
      if (entry.tileIndex < 0 || entry.tileIndex >= this.intensity.length) continue
      this.intensity[entry.tileIndex] = entry.intensity & 0xff
      this.fuel[entry.tileIndex] = entry.fuel & 0xff
    }
    for (const entry of snapshot.smoke) {
      if (entry.tileIndex < 0 || entry.tileIndex >= this.smoke.length) continue
      this.smoke[entry.tileIndex] = entry.smoke & 0xff
    }
    for (const id of snapshot.overloadedBranches) this.overloadedBranches.add(id)
  }
}

/** Seconds represented by one sim tick (10 ticks / in-game minute). */
export function secondsPerTick(ticksPerMinute: number): number {
  return 60 / ticksPerMinute
}

/** Convert a per-second rate to a per-tick amount. */
export function perTickFromPerSecond(perSecond: number, ticksPerMinute: number): number {
  return perSecond * secondsPerTick(ticksPerMinute)
}

/**
 * Multiplier applied to agent speed while standing in smoke.
 * Full smoke → `1 - smokeMovementPenalty`; clear air → 1.
 */
export function smokeMovementMultiplier(
  fire: FireGrid,
  tileIndex: number,
  data: GameData,
): number {
  const max = data.balance.fire.smokeMax
  if (max <= 0) return 1
  const fraction = fire.smokeAt(tileIndex) / max
  return Math.max(0, 1 - fraction * data.balance.fire.smokeMovementPenalty)
}

/** True when smoke on the tile meets or exceeds the visibility threshold. */
export function smokeBlocksVisibility(
  fire: FireGrid,
  tileIndex: number,
  data: GameData,
): boolean {
  const max = data.balance.fire.smokeMax
  if (max <= 0) return false
  return fire.smokeAt(tileIndex) / max >= data.balance.fire.smokeVisibilityThreshold
}
