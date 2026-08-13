/**
 * T6.4 — the Guided Contract: objectives from the contract's own to-do list,
 * coach marks after 60 seconds of inaction, skippable, and a veteran mode.
 */

import { describe, expect, it } from 'vitest'

import {
  COACH_MARK_IDLE_MS,
  Onboarding,
  coachMarkFor,
  isProgressToward,
  objectivesFromContract,
} from '../../src/game/onboarding'
import type { OnboardingObjective } from '../../src/game/onboarding'

const CONTRACT = {
  todoItems: [
    { label: 'Build 8 cells', predicate: { type: 'roomCount', roomId: 'cell', min: 8 } },
    { label: 'Build a mess hall', predicate: { type: 'roomCount', roomId: 'mess_hall', min: 1 } },
    { label: 'Hold 8 inmates', predicate: { type: 'capacityAtLeast', min: 8 } },
  ],
  itemPassed: [true, false, false],
}

function objectives(): readonly OnboardingObjective[] {
  return objectivesFromContract(CONTRACT)
}

describe('objectives come from the contract itself', () => {
  it('mirrors the to-do list, with what is already done', () => {
    const list = objectives()
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ index: 0, label: 'Build 8 cells', done: true })
    expect(list[1]).toMatchObject({ index: 1, done: false, predicateType: 'roomCount' })
  })

  it('digs the subject out of whichever field the predicate names it in', () => {
    const list = objectives()
    expect(list[1]?.subject).toBe('mess_hall')
    // `capacityAtLeast` names no subject, and that is fine.
    expect(list[2]?.subject).toBe('')
  })

  it('is empty when there is no active contract', () => {
    expect(objectivesFromContract(null)).toEqual([])
  })
})

describe('coach mark copy', () => {
  it('points a room objective at the Rooms tool and names the room', () => {
    const mark = coachMarkFor({
      index: 1,
      label: 'Build a mess hall',
      done: false,
      predicateType: 'roomCount',
      subject: 'mess_hall',
    })
    expect(mark.anchor).toBe('tool:rooms')
    expect(mark.body).toContain('Mess hall')
  })

  it('points a staff objective at the Staff tool', () => {
    const mark = coachMarkFor({
      index: 0,
      label: 'Hire a warden',
      done: false,
      predicateType: 'staffHired',
      subject: 'warden',
    })
    expect(mark.anchor).toBe('tool:staff')
    expect(mark.body).toContain('Warden')
  })

  it('falls back rather than showing nothing for an unknown predicate', () => {
    const mark = coachMarkFor({
      index: 0,
      label: 'Something new',
      done: false,
      predicateType: 'somePredicateNobodyHasWrittenYet',
      subject: '',
    })
    expect(mark.title.length).toBeGreaterThan(0)
    expect(mark.body.length).toBeGreaterThan(0)
  })
})

describe('what counts as progress', () => {
  const roomObjective: OnboardingObjective = {
    index: 0,
    label: 'Build a kitchen',
    done: false,
    predicateType: 'roomCount',
    subject: 'kitchen',
  }

  it('counts designating a room toward a room objective', () => {
    expect(isProgressToward(roomObjective, 'rooms.designate')).toBe(true)
    expect(isProgressToward(roomObjective, 'blueprint.commit')).toBe(true)
  })

  it('does not count opening a panel or hiring someone', () => {
    expect(isProgressToward(roomObjective, 'staff.hire')).toBe(false)
    expect(isProgressToward(roomObjective, 'sim:speed')).toBe(false)
  })
})

describe('the idle gate (PRD 3.8)', () => {
  it('waits a full sixty seconds before offering a mark', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)

    expect(guide.state(0).marks).toHaveLength(0)
    expect(guide.state(COACH_MARK_IDLE_MS - 1).marks).toHaveLength(0)
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(1)
  })

  it('marks the first outstanding objective, not the first objective', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)

    const mark = guide.state(COACH_MARK_IDLE_MS).marks[0]
    // Objective 0 is already done; the guide is on 1.
    expect(mark?.objectiveIndex).toBe(1)
    expect(guide.state(0).currentIndex).toBe(1)
  })

  it('resets the clock on an action toward the current objective', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)

    guide.noteCommand('rooms.designate', 30_000)
    // Sixty seconds from the action, not from the start.
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(0)
    expect(guide.state(30_000 + COACH_MARK_IDLE_MS).marks).toHaveLength(1)
  })

  it('ignores an action that has nothing to do with the objective', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)

    guide.noteCommand('staff.hire', 30_000)
    // A player hiring staff while the objective is a mess hall is still stuck
    // on the mess hall.
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(1)
  })

  it('restarts the clock when an objective completes', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(1)

    // The mess hall goes up at the one-minute mark.
    guide.update(
      objectivesFromContract({ ...CONTRACT, itemPassed: [true, true, false] }),
      COACH_MARK_IDLE_MS,
    )
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(0)
    expect(guide.state(COACH_MARK_IDLE_MS).currentIndex).toBe(2)
  })

  it('offers nothing once every objective is met', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(
      objectivesFromContract({ ...CONTRACT, itemPassed: [true, true, true] }),
      0,
    )
    const state = guide.state(COACH_MARK_IDLE_MS * 10)
    expect(state.currentIndex).toBeNull()
    expect(state.marks).toHaveLength(0)
  })

  it('reports how long the player has been stuck', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    expect(guide.idleMs(5_000)).toBe(5_000)
    guide.noteCommand('rooms.designate', 5_000)
    expect(guide.idleMs(6_000)).toBe(1_000)
  })
})

describe('dismissing and skipping (PRD 3.8)', () => {
  it('hides the current mark without leaving the guide', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(1)

    guide.dismissCurrent()
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(0)
    // The checklist stays.
    expect(guide.state(COACH_MARK_IDLE_MS).objectives).toHaveLength(3)
  })

  it('offers a mark again once the next objective comes round', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    guide.dismissCurrent()

    guide.update(
      objectivesFromContract({ ...CONTRACT, itemPassed: [true, true, false] }),
      COACH_MARK_IDLE_MS,
    )
    expect(guide.state(COACH_MARK_IDLE_MS * 2).marks).toHaveLength(1)
  })

  it('skips fully — no objectives, no marks', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    guide.skip(0)

    const state = guide.state(COACH_MARK_IDLE_MS * 10)
    expect(state.mode).toBe('off')
    expect(state.objectives).toEqual([])
    expect(state.marks).toEqual([])
  })
})

describe('veteran mode — show me everything', () => {
  it('offers every outstanding mark at once, with no idle gate', () => {
    const guide = new Onboarding('veteran', 0)
    guide.update(objectives(), 0)

    const state = guide.state(0)
    expect(state.mode).toBe('veteran')
    // Two outstanding of three, immediately.
    expect(state.marks).toHaveLength(2)
    expect(state.marks.map((mark) => mark.objectiveIndex)).toEqual([1, 2])
  })

  it('switching mode gives the player a fresh minute', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)

    guide.setMode('guided', COACH_MARK_IDLE_MS)
    expect(guide.state(COACH_MARK_IDLE_MS).marks).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('round-trips the mode and what has been waved away', () => {
    const guide = new Onboarding('guided', 0)
    guide.update(objectives(), 0)
    guide.dismissCurrent()
    guide.setMode('veteran', 0)

    const snapshot = guide.serialise()
    expect(snapshot).toEqual({ mode: 'veteran', dismissed: [1] })

    const restored = new Onboarding('guided', 0)
    restored.restore(snapshot, 0)
    restored.update(objectives(), 0)
    expect(restored.mode).toBe('veteran')
  })
})
