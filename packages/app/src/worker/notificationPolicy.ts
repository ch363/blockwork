/**
 * Notification policy: severity, grouping, mute and auto-pause (T6.3, PRD 6.5).
 *
 * The relay used to be the whole story — every warn-or-above event became a
 * toast, immediately, forever. That is fine until a fire starts, at which point
 * eleven `fire.spread` events a minute bury the one notification the player
 * needed to read. PRD 6.5's answer is three rules, and this module is all three
 * in one place so they can be reasoned about together:
 *
 *   - **Grouping.** Identical notifications inside a 60 in-game minute window
 *     collapse into the *same* notification with a rising count. Identical
 *     means same kind and same subject: two fires are two notifications, one
 *     fire spreading eleven times is one.
 *   - **Mute** is per category, and a muted category is silent all the way
 *     down — no toast, no badge. A mute that still bumped the alert count
 *     would be a worse lie than no mute at all.
 *   - **Auto-pause** is optional and fires only on `critical`. The policy
 *     records that one was raised; stopping the clock is the loop's job.
 *
 * Everything here is pure over its inputs plus an explicit tick, so the whole
 * of PRD 6.5 is testable without a worker, a simulation or a clock.
 */

import { NOTIFICATION_SEVERITY, TICKS_PER_HOUR, isTraceKind } from '@blockwork/sim'
import type { NotificationSeverity } from '@blockwork/sim'

/**
 * PRD 6.5: "identical notifications within 60 in-game minutes collapse into
 * one with a count".
 */
export const GROUPING_WINDOW_TICKS = TICKS_PER_HOUR

/**
 * The category a notification is muted by.
 *
 * Derived from the Trace kind's own prefix rather than a second table: kinds
 * are already named `fire.spread`, `riot.started`, `kitchen.noIngredients`, so
 * the grouping the player would draw by hand is the one the data already has.
 * A kind with no dot is its own category.
 */
export function categoryOfKind(kind: string): string {
  const dot = kind.indexOf('.')
  return dot <= 0 ? kind : kind.slice(0, dot)
}

/**
 * Severity for a recorded event kind (PRD 6.5).
 *
 * Anything not registered as a Trace kind is log-only: an unregistered kind has
 * no catalogue string, so a toast for it would be blank.
 */
export function severityForKind(kind: string): NotificationSeverity {
  if (!isTraceKind(kind)) return NOTIFICATION_SEVERITY.INFO
  // Periodic recomputes belong on the top-bar meter, not in the toast rail.
  if (kind === 'danger.recomputed') return NOTIFICATION_SEVERITY.INFO
  if (CRITICAL_KINDS.has(kind)) return NOTIFICATION_SEVERITY.CRITICAL
  return NOTIFICATION_SEVERITY.WARN
}

/**
 * Kinds that stop the game rather than badge it.
 *
 * A death, an escape, a failure or the moment a riot becomes a riot — the four
 * things a player would want the clock stopped for. Everything else is a
 * warning, however loud it feels while it is happening.
 */
const CRITICAL_KINDS: ReadonlySet<string> = new Set([
  'inmate.starved',
  'combat.died',
  'riot.started',
  'escape.inmateEscaped',
  'escape.failure',
  'escape.failureWarning',
  'failure.riot',
  'failure.riotWarning',
  'emergency.playerFired',
  'release.recidivismFailure',
  'release.recidivismWarning',
])

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

/** What the relay should do with an event. */
export type NotificationAction =
  /** Log it and say nothing: info, or a muted category. */
  | { readonly kind: 'drop'; readonly reason: 'info' | 'muted' }
  /** A new notification. The relay assigns the id. */
  | { readonly kind: 'raise'; readonly severity: NotificationSeverity }
  /** A duplicate: re-publish this id with the new count. */
  | {
      readonly kind: 'group'
      readonly severity: NotificationSeverity
      readonly notificationId: number
      readonly count: number
    }

export interface NotificationSettings {
  readonly mutedCategories: readonly string[]
  readonly autoPauseOnCritical: boolean
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mutedCategories: [],
  // Off by default: a player who has not asked for it should never lose control
  // of the clock. PRD 6.5 calls it optional and means it.
  autoPauseOnCritical: false,
}

interface Group {
  readonly notificationId: number
  /** Tick of the most recent member, which is what the window is measured from. */
  tick: number
  count: number
}

/**
 * The live policy. One per worker loop.
 *
 * Holds the open grouping windows, so it has to be told about a notification's
 * id after the relay assigns it (`recordRaised`). That two-step is deliberate:
 * the policy decides, the relay owns the id space, and neither has to know how
 * the other works.
 */
export class NotificationPolicy {
  #muted: ReadonlySet<string> = new Set()
  #autoPause = DEFAULT_NOTIFICATION_SETTINGS.autoPauseOnCritical
  #criticalPending = false
  readonly #groups = new Map<string, Group>()
  readonly #windowTicks: number

  constructor(windowTicks: number = GROUPING_WINDOW_TICKS) {
    this.#windowTicks = windowTicks
  }

  get autoPauseOnCritical(): boolean {
    return this.#autoPause
  }

  settings(): NotificationSettings {
    return {
      mutedCategories: [...this.#muted].sort(),
      autoPauseOnCritical: this.#autoPause,
    }
  }

  apply(settings: Partial<NotificationSettings>): void {
    if (settings.mutedCategories !== undefined) {
      this.#muted = new Set(settings.mutedCategories)
    }
    if (settings.autoPauseOnCritical !== undefined) {
      this.#autoPause = settings.autoPauseOnCritical
    }
  }

  isMuted(category: string): boolean {
    return this.#muted.has(category)
  }

  /**
   * Decides what becomes of one recorded event.
   *
   * Pruning happens here rather than on a timer because this is the only place
   * that knows the current tick, and a window nobody has asked about does not
   * need to have expired on schedule.
   */
  admit(event: {
    readonly kind: string
    readonly subjectId: number
    readonly tick: number
  }): NotificationAction {
    const severity = severityForKind(event.kind)
    if (severity === NOTIFICATION_SEVERITY.INFO) {
      return { kind: 'drop', reason: 'info' }
    }
    if (this.#muted.has(categoryOfKind(event.kind))) {
      return { kind: 'drop', reason: 'muted' }
    }

    this.#prune(event.tick)

    const key = groupKey(event.kind, event.subjectId)
    const group = this.#groups.get(key)
    if (group !== undefined) {
      group.count += 1
      // The window slides with the group: a fire that keeps spreading stays one
      // notification for as long as it keeps spreading.
      group.tick = event.tick
      return {
        kind: 'group',
        severity,
        notificationId: group.notificationId,
        count: group.count,
      }
    }

    if (severity === NOTIFICATION_SEVERITY.CRITICAL) this.#criticalPending = true
    return { kind: 'raise', severity }
  }

  /** Tells the policy which id the relay gave a `raise`, opening its window. */
  recordRaised(event: {
    readonly kind: string
    readonly subjectId: number
    readonly tick: number
    readonly notificationId: number
  }): void {
    this.#groups.set(groupKey(event.kind, event.subjectId), {
      notificationId: event.notificationId,
      tick: event.tick,
      count: 1,
    })
  }

  /**
   * Whether a critical has been raised since this was last asked, clearing the
   * flag.
   *
   * Take-once, because the loop acts on it exactly once per step and a flag
   * that stayed set would pause the game again the moment the player unpaused.
   */
  takeCriticalRaised(): boolean {
    const raised = this.#criticalPending
    this.#criticalPending = false
    return raised
  }

  /** Open grouping windows. Test and diagnostic use. */
  get openGroups(): number {
    return this.#groups.size
  }

  #prune(tick: number): void {
    for (const [key, group] of this.#groups) {
      if (tick - group.tick < this.#windowTicks) continue
      this.#groups.delete(key)
    }
  }
}

function groupKey(kind: string, subjectId: number): string {
  return `${kind}:${String(subjectId)}`
}
