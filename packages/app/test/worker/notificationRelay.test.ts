/**
 * T6.3 — the policy as the live relay applies it: grouping across snapshots,
 * mute, auto-pause, and a `traceId` on every warn-or-above.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SNAPSHOT_LIMITS, NOTIFICATION_SEVERITY, TICKS_PER_HOUR } from '@blockwork/sim'
import type { SnapshotLimits } from '@blockwork/sim'

import { SimWorkerLoop } from '../../src/worker/simWorker'
import type { SimWorkerOutbound } from '../../src/worker/simWorker'

const MAP_SIZE = 32
const SEED = 0xb10c_6003

const LIMITS: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, maxEntities: 64 }

interface Harness {
  readonly loop: SimWorkerLoop
  readonly posted: SimWorkerOutbound[]
}

function harness(): Harness {
  const posted: SimWorkerOutbound[] = []
  const loop = new SimWorkerLoop({
    seed: SEED,
    mapSize: MAP_SIZE,
    limits: LIMITS,
    speed: 1,
    post: (message) => {
      posted.push(message)
    },
    // An empty prison publishes no entities; the notification path is the
    // subject here, and collecting agents would only add noise.
    collectEntities: () => undefined,
  })
  return { loop, posted }
}

/** Raises one event through the loop's own sink, exactly as a system would. */
function raise(loop: SimWorkerLoop, kind: string, subjectId: number, tick: number): void {
  loop.events.emit({ tick, kind, subjectId, causeIds: [], data: {} })
}

describe('notification relay — grouping across snapshots', () => {
  it('publishes one notification with a rising count, not four toasts', () => {
    const { loop } = harness()

    // Four spreads of the same fire, minutes apart, all inside the window.
    raise(loop, 'fire.spread', 42, 0)
    raise(loop, 'fire.spread', 42, 100)
    raise(loop, 'fire.spread', 42, 200)
    raise(loop, 'fire.spread', 42, 300)

    const notifications = loop.peekNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.count).toBe(4)
  })

  it('keeps two different fires apart', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 1, 0)
    raise(loop, 'fire.spread', 2, 0)

    expect(loop.peekNotifications()).toHaveLength(2)
  })

  it('starts a fresh notification once the window has passed', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 42, 0)
    loop.drainNotifications()

    raise(loop, 'fire.spread', 42, TICKS_PER_HOUR * 2)
    const second = loop.peekNotifications()
    expect(second).toHaveLength(1)
    expect(second[0]?.count).toBe(1)
  })

  it('regroups onto the same id after the first batch was drained', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 42, 0)
    const first = loop.peekNotifications()[0]
    expect(first?.count).toBe(1)
    loop.drainNotifications()

    raise(loop, 'fire.spread', 42, 60)
    const second = loop.peekNotifications()
    expect(second).toHaveLength(1)
    // Same id: the main thread updates the toast it already has rather than
    // stacking a second one.
    expect(second[0]?.id).toBe(first?.id)
    expect(second[0]?.count).toBe(2)
  })

  it('crosses the boundary once per group, with the final count', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 42, 0)
    raise(loop, 'fire.spread', 42, 10)
    raise(loop, 'fire.spread', 42, 20)

    const drained = loop.drainNotifications()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.count).toBe(3)
  })
})

describe('notification relay — mute and the badge', () => {
  it('does not badge a muted category', () => {
    const { loop } = harness()
    loop.setNotificationSettings({ mutedCategories: ['fire'] })

    const before = loop.alerts
    raise(loop, 'fire.spread', 42, 0)

    expect(loop.peekNotifications()).toHaveLength(0)
    expect(loop.alerts).toBe(before)
  })

  it('still badges an unmuted category', () => {
    const { loop } = harness()
    loop.setNotificationSettings({ mutedCategories: ['fire'] })

    const before = loop.alerts
    raise(loop, 'riot.started', 1, 0)
    expect(loop.alerts).toBe(before + 1)
  })

  it('counts a group once, not once per member', () => {
    const { loop } = harness()
    const before = loop.alerts
    raise(loop, 'fire.spread', 42, 0)
    raise(loop, 'fire.spread', 42, 10)
    raise(loop, 'fire.spread', 42, 20)
    expect(loop.alerts).toBe(before + 1)
  })

  it('logs a muted event even though it says nothing about it', () => {
    const { loop } = harness()
    loop.setNotificationSettings({ mutedCategories: ['fire'] })
    raise(loop, 'fire.spread', 42, 0)

    // Muted is not un-recorded: the Reports log and the Trace still have it.
    expect(loop.peekNotifications()).toHaveLength(0)
    expect(loop.trace(1, 0)).not.toBeUndefined()
  })
})

describe('notification relay — traceId (PRD 6.5)', () => {
  it('gives every warn-or-above a chain to open', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 42, 0)
    raise(loop, 'riot.started', 1, 0)
    raise(loop, 'combat.died', 5, 0)

    const notifications = loop.peekNotifications()
    expect(notifications.length).toBeGreaterThan(0)
    for (const notification of notifications) {
      expect(notification.severity).not.toBe(NOTIFICATION_SEVERITY.INFO)
      expect(notification.traceId, String(notification.id)).toBeGreaterThan(0)
    }
  })

  it('keeps the chain of the first member when a group grows', () => {
    const { loop } = harness()
    raise(loop, 'fire.spread', 42, 0)
    const originalTrace = loop.peekNotifications()[0]?.traceId ?? 0
    expect(originalTrace).toBeGreaterThan(0)

    raise(loop, 'fire.spread', 42, 60)
    expect(loop.peekNotifications()[0]?.traceId).toBe(originalTrace)
  })

  it('raises nothing at all for an unregistered kind', () => {
    const { loop } = harness()
    raise(loop, 'objects.rejected', 1, 0)
    expect(loop.peekNotifications()).toHaveLength(0)
  })
})

describe('notification relay — auto-pause on critical', () => {
  it('stops the clock and says so when enabled', () => {
    const { loop, posted } = harness()
    loop.setNotificationSettings({ autoPauseOnCritical: true })

    loop.advance(0)
    raise(loop, 'combat.died', 5, 0)
    loop.advance(1000)

    expect(loop.speed).toBe(0)
    const changed = posted.filter((message) => message.type === 'sim:speedChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ speed: 0, reason: 'critical' })
  })

  it('leaves the clock alone when disabled', () => {
    const { loop, posted } = harness()

    loop.advance(0)
    raise(loop, 'combat.died', 5, 0)
    loop.advance(1000)

    expect(loop.speed).toBe(1)
    expect(posted.filter((message) => message.type === 'sim:speedChanged')).toHaveLength(0)
  })

  it('does not pause on a warning', () => {
    const { loop } = harness()
    loop.setNotificationSettings({ autoPauseOnCritical: true })

    loop.advance(0)
    raise(loop, 'fire.spread', 42, 0)
    loop.advance(1000)

    expect(loop.speed).toBe(1)
  })

  it('reports the settings it is running under', () => {
    const { loop } = harness()
    loop.setNotificationSettings({ mutedCategories: ['fire', 'kitchen'] })
    expect(loop.notificationSettings()).toEqual({
      mutedCategories: ['fire', 'kitchen'],
      autoPauseOnCritical: false,
    })
  })
})
