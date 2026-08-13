/**
 * Security / emergency world state (T4.6).
 *
 * Lives apart from the systems so `InmateWorld` can own the state without a
 * circular import through danger / riot / emergency update loops.
 */

import type { Fnv1aHasher } from '../core/hash'

/* -------------------------------------------------------------------------- */
/* Misconduct window                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Rolling misconduct tick log for the danger formula's 6-hour window.
 *
 * T4.4 writes via {@link MisconductWindow.record}. Until then tests call
 * `record` directly.
 */
export class MisconductWindow {
  readonly #ticks: number[] = []

  record(tick: number): void {
    this.#ticks.push(tick)
  }

  /** Count of events with `tick > now - windowTicks`. */
  countSince(nowTick: number, windowTicks: number): number {
    const earliest = nowTick - windowTicks
    let drop = 0
    while (drop < this.#ticks.length) {
      const t = this.#ticks[drop]
      if (t === undefined || t > earliest) break
      drop += 1
    }
    if (drop > 0) this.#ticks.splice(0, drop)
    return this.#ticks.length
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#ticks.length)
    for (const tick of this.#ticks) hasher.writeUint32(tick)
  }

  serialise(): readonly number[] {
    return [...this.#ticks]
  }

  restore(ticks: readonly number[]): void {
    this.#ticks.length = 0
    for (const tick of ticks) this.#ticks.push(tick)
  }
}

/* -------------------------------------------------------------------------- */
/* Riot                                                                        */
/* -------------------------------------------------------------------------- */

export class RiotState {
  /** True while at least one inmate is rioting, or during the quiet countdown. */
  active = false
  readonly riotingInmateIds = new Set<number>()
  /** Continuous minutes with zero rioters while `active`. */
  quietMinutes = 0
  startedAtTick = 0
  /** Per-door tile index → minutes spent being broken by rioters. */
  readonly doorBreakProgress = new Map<number, number>()

  clear(): void {
    this.active = false
    this.riotingInmateIds.clear()
    this.quietMinutes = 0
    this.startedAtTick = 0
    this.doorBreakProgress.clear()
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.active ? 1 : 0)
    hasher.writeUint32(this.quietMinutes)
    hasher.writeUint32(this.startedAtTick)
    const ids = [...this.riotingInmateIds].sort((a, b) => a - b)
    hasher.writeUint32(ids.length)
    for (const id of ids) hasher.writeUint32(id)
    const doors = [...this.doorBreakProgress.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(doors.length)
    for (const [tile, minutes] of doors) {
      hasher.writeUint32(tile)
      hasher.writeUint32(minutes)
    }
  }

  serialise(): {
    readonly active: boolean
    readonly riotingInmateIds: readonly number[]
    readonly quietMinutes: number
    readonly startedAtTick: number
    readonly doorBreakProgress: readonly {
      readonly tileIndex: number
      readonly minutes: number
    }[]
  } {
    return {
      active: this.active,
      riotingInmateIds: [...this.riotingInmateIds].sort((a, b) => a - b),
      quietMinutes: this.quietMinutes,
      startedAtTick: this.startedAtTick,
      doorBreakProgress: [...this.doorBreakProgress.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tileIndex, minutes]) => ({ tileIndex, minutes })),
    }
  }

  restore(snapshot: {
    readonly active: boolean
    readonly riotingInmateIds: readonly number[]
    readonly quietMinutes: number
    readonly startedAtTick: number
    readonly doorBreakProgress: readonly {
      readonly tileIndex: number
      readonly minutes: number
    }[]
  }): void {
    this.active = snapshot.active
    this.riotingInmateIds.clear()
    for (const id of snapshot.riotingInmateIds) this.riotingInmateIds.add(id)
    this.quietMinutes = snapshot.quietMinutes
    this.startedAtTick = snapshot.startedAtTick
    this.doorBreakProgress.clear()
    for (const entry of snapshot.doorBreakProgress) {
      this.doorBreakProgress.set(entry.tileIndex, entry.minutes)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Emergency                                                                   */
/* -------------------------------------------------------------------------- */

export class EmergencyState {
  /** Sector ids currently under level-1 lockdown. */
  readonly sectorLockdowns = new Set<number>()
  fullLockdown = false
  riotSquadActive = false
  readonly riotSquadStaffIds: number[] = []
  freeFireActive = false
  /** Applied once when free fire is authorised. */
  freeFirePenaltiesApplied = false
  nationalGuardActive = false
  readonly nationalGuardStaffIds: number[] = []
  /** Player dismissed after national guard / failure. */
  playerFired = false
  /** Optional map mutator — failure conditions default on. */
  riotFailureEnabled = true
  /** Tick when the active riot's failure warning fires / fired. */
  warningAtTick: number | null = null
  /** Tick when the prison fails for uncontained riot. */
  failureAtTick: number | null = null
  warningEmitted = false
  failed = false
  /** Prison-wide PR score penalty accumulator (free fire). */
  prPenalty = 0
  /** Last tick riot-squad wages were charged. */
  riotSquadLastWageTick = 0

  clearCallable(kind: 'riot_squad' | 'national_guard'): void {
    if (kind === 'riot_squad') {
      this.riotSquadActive = false
      this.riotSquadStaffIds.length = 0
      this.riotSquadLastWageTick = 0
    } else {
      this.nationalGuardActive = false
      this.nationalGuardStaffIds.length = 0
    }
  }

  /** Reset failure countdown when a riot is contained. */
  cancelFailureCountdown(): void {
    this.warningAtTick = null
    this.failureAtTick = null
    this.warningEmitted = false
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.fullLockdown ? 1 : 0)
    hasher.writeUint32(this.riotSquadActive ? 1 : 0)
    hasher.writeUint32(this.freeFireActive ? 1 : 0)
    hasher.writeUint32(this.nationalGuardActive ? 1 : 0)
    hasher.writeUint32(this.playerFired ? 1 : 0)
    hasher.writeUint32(this.riotFailureEnabled ? 1 : 0)
    hasher.writeUint32(this.warningEmitted ? 1 : 0)
    hasher.writeUint32(this.failed ? 1 : 0)
    hasher.writeUint32(this.warningAtTick ?? 0xffffffff)
    hasher.writeUint32(this.failureAtTick ?? 0xffffffff)
    hasher.writeFloat64(this.prPenalty)
    const sectors = [...this.sectorLockdowns].sort((a, b) => a - b)
    hasher.writeUint32(sectors.length)
    for (const id of sectors) hasher.writeUint32(id)
    hasher.writeUint32(this.riotSquadStaffIds.length)
    for (const id of this.riotSquadStaffIds) hasher.writeUint32(id)
    hasher.writeUint32(this.nationalGuardStaffIds.length)
    for (const id of this.nationalGuardStaffIds) hasher.writeUint32(id)
  }

  serialise(): {
    readonly sectorLockdowns: readonly number[]
    readonly fullLockdown: boolean
    readonly riotSquadActive: boolean
    readonly riotSquadStaffIds: readonly number[]
    readonly freeFireActive: boolean
    readonly freeFirePenaltiesApplied: boolean
    readonly nationalGuardActive: boolean
    readonly nationalGuardStaffIds: readonly number[]
    readonly playerFired: boolean
    readonly riotFailureEnabled: boolean
    readonly warningAtTick: number | null
    readonly failureAtTick: number | null
    readonly warningEmitted: boolean
    readonly failed: boolean
    readonly prPenalty: number
    readonly riotSquadLastWageTick: number
  } {
    return {
      sectorLockdowns: [...this.sectorLockdowns].sort((a, b) => a - b),
      fullLockdown: this.fullLockdown,
      riotSquadActive: this.riotSquadActive,
      riotSquadStaffIds: [...this.riotSquadStaffIds],
      freeFireActive: this.freeFireActive,
      freeFirePenaltiesApplied: this.freeFirePenaltiesApplied,
      nationalGuardActive: this.nationalGuardActive,
      nationalGuardStaffIds: [...this.nationalGuardStaffIds],
      playerFired: this.playerFired,
      riotFailureEnabled: this.riotFailureEnabled,
      warningAtTick: this.warningAtTick,
      failureAtTick: this.failureAtTick,
      warningEmitted: this.warningEmitted,
      failed: this.failed,
      prPenalty: this.prPenalty,
      riotSquadLastWageTick: this.riotSquadLastWageTick,
    }
  }

  restore(snapshot: {
    readonly sectorLockdowns: readonly number[]
    readonly fullLockdown: boolean
    readonly riotSquadActive: boolean
    readonly riotSquadStaffIds: readonly number[]
    readonly freeFireActive: boolean
    readonly freeFirePenaltiesApplied: boolean
    readonly nationalGuardActive: boolean
    readonly nationalGuardStaffIds: readonly number[]
    readonly playerFired: boolean
    readonly riotFailureEnabled: boolean
    readonly warningAtTick: number | null
    readonly failureAtTick: number | null
    readonly warningEmitted: boolean
    readonly failed: boolean
    readonly prPenalty: number
    readonly riotSquadLastWageTick: number
  }): void {
    this.sectorLockdowns.clear()
    for (const id of snapshot.sectorLockdowns) this.sectorLockdowns.add(id)
    this.fullLockdown = snapshot.fullLockdown
    this.riotSquadActive = snapshot.riotSquadActive
    this.riotSquadStaffIds.length = 0
    this.riotSquadStaffIds.push(...snapshot.riotSquadStaffIds)
    this.freeFireActive = snapshot.freeFireActive
    this.freeFirePenaltiesApplied = snapshot.freeFirePenaltiesApplied
    this.nationalGuardActive = snapshot.nationalGuardActive
    this.nationalGuardStaffIds.length = 0
    this.nationalGuardStaffIds.push(...snapshot.nationalGuardStaffIds)
    this.playerFired = snapshot.playerFired
    this.riotFailureEnabled = snapshot.riotFailureEnabled
    this.warningAtTick = snapshot.warningAtTick
    this.failureAtTick = snapshot.failureAtTick
    this.warningEmitted = snapshot.warningEmitted
    this.failed = snapshot.failed
    this.prPenalty = snapshot.prPenalty
    this.riotSquadLastWageTick = snapshot.riotSquadLastWageTick
  }
}
