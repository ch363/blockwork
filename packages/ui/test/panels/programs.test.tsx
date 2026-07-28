/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Programs, blockerSentence, formatHour } from '../../src/panels/Programs'
import type {
  ProgramBlockerKind,
  ProgramRowModel,
  ProgramsModel,
} from '../../src/panels/Programs'
import { mountShell, unmount } from '../helpers/mount'

function row(patch: Partial<ProgramRowModel> & { readonly id: string }): ProgramRowModel {
  return {
    name: patch.id,
    roomName: 'Classroom',
    tutorName: 'Instructor',
    hours: 3,
    seats: 20,
    sessionsRequired: 10,
    costPerSession: 150,
    attendance: 'voluntary',
    enrolled: 4,
    completed: 0,
    slot: null,
    session: null,
    blocker: null,
    ...patch,
  }
}

function sampleModel(selectedId: string | null = 'literacy'): ProgramsModel {
  return {
    canPin: true,
    selectedId,
    rows: [
      row({
        id: 'literacy',
        name: 'Basic Literacy',
        slot: { categoryName: 'Medium', startHour: 9, hours: 3, pinned: false },
        session: { attending: 7, hoursRemaining: 2 },
        completed: 3,
      }),
      row({
        id: 'vocational',
        name: 'Vocational Certificate',
        seats: 10,
        blocker: {
          kind: 'not_enough_seats',
          have: 6,
          need: 10,
          subjectName: 'Classroom desk',
        },
      }),
      row({
        id: 'joinery',
        name: 'Joinery Apprenticeship',
        roomName: 'Workshop',
        blocker: {
          kind: 'no_contiguous_work_block',
          have: 2,
          need: 3,
          subjectName: 'Medium',
        },
      }),
    ],
  }
}

describe('Programs panel', () => {
  it('lists every programme with its state', () => {
    const host = mountShell(
      <Programs
        model={sampleModel()}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.querySelector('.bw-programs-panel')?.getAttribute('data-open')).toBe('true')
      expect(host.textContent).toContain('1 of 3 able to run')
      expect(host.querySelectorAll('.bw-programs-row')).toHaveLength(3)
      expect(host.textContent).toContain('In session · 7 present')
      expect(
        [...host.querySelectorAll('.bw-programs-row')].filter(
          (element) => element.getAttribute('data-blocked') === 'true',
        ),
      ).toHaveLength(2)
    } finally {
      unmount(host)
    }
  })

  it('states the seat shortfall with both numbers (PRD 5.9)', () => {
    const host = mountShell(
      <Programs
        model={sampleModel('vocational')}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Room has 6 × Classroom desk, this needs 10.')
    } finally {
      unmount(host)
    }
  })

  it('states the contiguity shortfall with the longest block it found', () => {
    const host = mountShell(
      <Programs
        model={sampleModel('joinery')}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain(
        'Needs 3 contiguous work hours; the longest block in the Medium routine is 2.',
      )
    } finally {
      unmount(host)
    }
  })

  it('hides pinning until Delegation is researched', () => {
    const model = { ...sampleModel(), canPin: false }
    const host = mountShell(
      <Programs model={model} onSelect={() => undefined} onClose={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('Research Delegation to pin')
      const pin = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Pin to this slot'),
      )
      expect(pin).toBeUndefined()
    } finally {
      unmount(host)
    }
  })

  it('pins the selected programme', () => {
    const pinned: string[] = []
    const host = mountShell(
      <Programs
        model={sampleModel()}
        onSelect={() => undefined}
        onClose={() => undefined}
        onPin={(id) => {
          pinned.push(id)
        }}
      />,
    )

    try {
      const pin = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Pin to this slot'),
      )
      pin?.click()
      expect(pinned).toEqual(['literacy'])
    } finally {
      unmount(host)
    }
  })

  it('selects a programme when its row is tapped', () => {
    const selected: (string | null)[] = []
    const host = mountShell(
      <Programs
        model={sampleModel(null)}
        onSelect={(id) => {
          selected.push(id)
        }}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Select a programme')
      const rows = host.querySelectorAll('.bw-programs-row')
      ;(rows[1] as HTMLButtonElement | undefined)?.click()
      expect(selected).toEqual(['vocational'])
    } finally {
      unmount(host)
    }
  })
})

describe('blocker copy', () => {
  it('names a number for every reason that has one', () => {
    const cases: readonly { kind: ProgramBlockerKind; expect: string }[] = [
      { kind: 'locked', expect: 'Education' },
      { kind: 'no_tutor', expect: '1' },
      { kind: 'no_room', expect: 'Education' },
      { kind: 'room_not_functional', expect: 'Education' },
      { kind: 'not_enough_seats', expect: '10' },
      { kind: 'no_contiguous_work_block', expect: '3' },
      { kind: 'no_enrolment', expect: 'Nobody' },
      { kind: 'insufficient_funds', expect: '150' },
    ]

    for (const entry of cases) {
      const sentence = blockerSentence({
        kind: entry.kind,
        have: entry.kind === 'insufficient_funds' ? 20 : 6,
        need: entry.kind === 'insufficient_funds' ? 150 : entry.kind === 'no_tutor' ? 1 : entry.kind === 'no_contiguous_work_block' ? 3 : 10,
        subjectName: 'Education',
      })
      expect(sentence, entry.kind).toContain(entry.expect)
      expect(sentence.endsWith('.'), entry.kind).toBe(true)
    }
  })

  it('formats an hour as a 24-hour clock time', () => {
    expect(formatHour(0)).toBe('00:00')
    expect(formatHour(9)).toBe('09:00')
    expect(formatHour(21)).toBe('21:00')
  })
})
