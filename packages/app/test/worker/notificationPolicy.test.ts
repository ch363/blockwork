/**
 * T6.3 — notification severity, grouping, mute and auto-pause (PRD 6.5).
 */

import { describe, expect, it } from 'vitest'

import { NOTIFICATION_SEVERITY, TICKS_PER_HOUR } from '@blockwork/sim'

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  GROUPING_WINDOW_TICKS,
  NotificationPolicy,
  categoryOfKind,
  severityForKind,
} from '../../src/worker/notificationPolicy'

describe('notification severity (PRD 6.5)', () => {
  it('logs anything that is not a registered Trace kind', () => {
    expect(severityForKind('objects.rejected')).toBe(NOTIFICATION_SEVERITY.INFO)
    expect(severityForKind('not.a.real.kind')).toBe(NOTIFICATION_SEVERITY.INFO)
  })

  it('keeps the periodic danger recompute off the toast rail', () => {
    expect(severityForKind('danger.recomputed')).toBe(NOTIFICATION_SEVERITY.INFO)
    expect(severityForKind('grades.recomputed')).toBe(NOTIFICATION_SEVERITY.INFO)
  })

  it('promotes deaths, escapes, riots and failures to critical', () => {
    for (const kind of [
      'inmate.starved',
      'combat.died',
      'riot.started',
      'escape.inmateEscaped',
      'failure.riot',
    ]) {
      expect(severityForKind(kind), kind).toBe(NOTIFICATION_SEVERITY.CRITICAL)
    }
  })

  it('leaves everything else a warning', () => {
    expect(severityForKind('fire.spread')).toBe(NOTIFICATION_SEVERITY.WARN)
    expect(severityForKind('kitchen.noIngredients')).toBe(NOTIFICATION_SEVERITY.WARN)
  })
})

describe('notification categories', () => {
  it('takes the category from the kind prefix', () => {
    expect(categoryOfKind('fire.spread')).toBe('fire')
    expect(categoryOfKind('kitchen.noIngredients')).toBe('kitchen')
    expect(categoryOfKind('escape.tunnelDiscovered')).toBe('escape')
  })

  it('treats a kind with no prefix as its own category', () => {
    expect(categoryOfKind('standalone')).toBe('standalone')
  })
})

describe('notification grouping (PRD 6.5)', () => {
  it('collapses identical notifications inside the 60 minute window', () => {
    const policy = new NotificationPolicy()

    const first = policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 0 })
    expect(first.kind).toBe('raise')
    policy.recordRaised({ kind: 'fire.spread', subjectId: 7, tick: 0, notificationId: 41 })

    const second = policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 100 })
    expect(second).toMatchObject({ kind: 'group', notificationId: 41, count: 2 })

    const third = policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 200 })
    expect(third).toMatchObject({ kind: 'group', notificationId: 41, count: 3 })
  })

  it('treats a different subject as a different notification', () => {
    const policy = new NotificationPolicy()
    policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 0 })
    policy.recordRaised({ kind: 'fire.spread', subjectId: 7, tick: 0, notificationId: 1 })

    // Two fires are two notifications.
    expect(policy.admit({ kind: 'fire.spread', subjectId: 9, tick: 10 }).kind).toBe('raise')
  })

  it('treats a different kind as a different notification', () => {
    const policy = new NotificationPolicy()
    policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 0 })
    policy.recordRaised({ kind: 'fire.spread', subjectId: 7, tick: 0, notificationId: 1 })

    expect(policy.admit({ kind: 'fire.ignited', subjectId: 7, tick: 10 }).kind).toBe('raise')
  })

  it('opens a new notification once the window has passed', () => {
    const policy = new NotificationPolicy()
    policy.admit({ kind: 'fire.spread', subjectId: 7, tick: 0 })
    policy.recordRaised({ kind: 'fire.spread', subjectId: 7, tick: 0, notificationId: 1 })

    const inside = policy.admit({
      kind: 'fire.spread',
      subjectId: 7,
      tick: GROUPING_WINDOW_TICKS - 1,
    })
    expect(inside.kind).toBe('group')

    // The window slides with the group, so measure from the last member.
    const outside = policy.admit({
      kind: 'fire.spread',
      subjectId: 7,
      tick: GROUPING_WINDOW_TICKS * 2,
    })
    expect(outside.kind).toBe('raise')
  })

  it('uses a 60 in-game minute window', () => {
    expect(GROUPING_WINDOW_TICKS).toBe(TICKS_PER_HOUR)
  })

  it('prunes windows that have expired, so a long game does not leak them', () => {
    const policy = new NotificationPolicy()
    for (let i = 0; i < 20; i += 1) {
      policy.admit({ kind: 'fire.spread', subjectId: i, tick: 0 })
      policy.recordRaised({ kind: 'fire.spread', subjectId: i, tick: 0, notificationId: i + 1 })
    }
    expect(policy.openGroups).toBe(20)

    policy.admit({ kind: 'riot.started', subjectId: 1, tick: GROUPING_WINDOW_TICKS * 3 })
    expect(policy.openGroups).toBe(0)
  })
})

describe('per-category mute (PRD 6.5)', () => {
  it('drops a muted category entirely, badge included', () => {
    const policy = new NotificationPolicy()
    policy.apply({ mutedCategories: ['fire'] })

    expect(policy.isMuted('fire')).toBe(true)
    expect(policy.admit({ kind: 'fire.spread', subjectId: 1, tick: 0 })).toEqual({
      kind: 'drop',
      reason: 'muted',
    })
    // Unrelated categories are unaffected.
    expect(policy.admit({ kind: 'riot.started', subjectId: 1, tick: 0 }).kind).toBe('raise')
  })

  it('unmutes when the category is removed', () => {
    const policy = new NotificationPolicy()
    policy.apply({ mutedCategories: ['fire'] })
    policy.apply({ mutedCategories: [] })
    expect(policy.admit({ kind: 'fire.spread', subjectId: 1, tick: 0 }).kind).toBe('raise')
  })

  it('leaves the rest of the settings alone on a partial change', () => {
    const policy = new NotificationPolicy()
    policy.apply({ mutedCategories: ['fire'], autoPauseOnCritical: true })
    policy.apply({ autoPauseOnCritical: false })

    expect(policy.settings()).toEqual({
      mutedCategories: ['fire'],
      autoPauseOnCritical: false,
    })
  })

  it('never mutes by default', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.mutedCategories).toEqual([])
  })
})

describe('auto-pause on critical (PRD 6.5)', () => {
  it('is off unless the player asks for it', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.autoPauseOnCritical).toBe(false)
    expect(new NotificationPolicy().autoPauseOnCritical).toBe(false)
  })

  it('flags a critical exactly once', () => {
    const policy = new NotificationPolicy()
    policy.apply({ autoPauseOnCritical: true })

    expect(policy.takeCriticalRaised()).toBe(false)
    policy.admit({ kind: 'combat.died', subjectId: 3, tick: 0 })
    expect(policy.takeCriticalRaised()).toBe(true)
    // Take-once: unpausing must not immediately re-pause.
    expect(policy.takeCriticalRaised()).toBe(false)
  })

  it('does not flag a warning', () => {
    const policy = new NotificationPolicy()
    policy.admit({ kind: 'fire.spread', subjectId: 1, tick: 0 })
    expect(policy.takeCriticalRaised()).toBe(false)
  })

  it('does not flag a critical that was grouped into an existing one', () => {
    const policy = new NotificationPolicy()
    policy.admit({ kind: 'combat.died', subjectId: 3, tick: 0 })
    policy.recordRaised({ kind: 'combat.died', subjectId: 3, tick: 0, notificationId: 1 })
    expect(policy.takeCriticalRaised()).toBe(true)

    policy.admit({ kind: 'combat.died', subjectId: 3, tick: 10 })
    expect(policy.takeCriticalRaised()).toBe(false)
  })

  it('does not flag a muted critical', () => {
    const policy = new NotificationPolicy()
    policy.apply({ mutedCategories: ['combat'], autoPauseOnCritical: true })
    policy.admit({ kind: 'combat.died', subjectId: 3, tick: 0 })
    expect(policy.takeCriticalRaised()).toBe(false)
  })
})
