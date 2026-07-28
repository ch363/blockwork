/**
 * The blueprint bar's pure parts.
 *
 * The component itself is not rendered here: the workspace runs vitest in the
 * `node` environment with no DOM, and T1.5 does not ask for a UI test. What is
 * worth pinning is the wording, because it is the only place in the codebase
 * that turns a grouped `BlueprintIssue` into a sentence, and the acceptance
 * criterion is a sentence.
 */

import type { BlueprintIssue } from '@blockwork/sim'
import { describe, expect, it } from 'vitest'

import { formatCost, issueSentence, plural } from '../../src/index'

function requirement(overrides: Partial<BlueprintIssue> = {}): BlueprintIssue {
  return {
    kind: 'requirement',
    source: 'cell',
    sourceName: 'Cell',
    subject: 'toilet',
    subjectName: 'Toilet',
    count: 3,
    focus: [
      { x: 4, y: 4 },
      { x: 8, y: 4 },
      { x: 12, y: 4 },
    ],
    ...overrides,
  }
}

describe('plural', () => {
  it('leaves a single thing alone', () => {
    expect(plural('cell', 1)).toBe('cell')
    expect(plural('dormitory', 1)).toBe('dormitory')
  })

  it('adds s to a regular noun', () => {
    expect(plural('cell', 3)).toBe('cells')
    expect(plural('mess hall', 2)).toBe('mess halls')
    expect(plural('refuse point', 2)).toBe('refuse points')
  })

  it('turns a consonant-y into -ies', () => {
    expect(plural('dormitory', 2)).toBe('dormitories')
    expect(plural('armoury', 2)).toBe('armouries')
  })

  it('leaves a vowel-y alone', () => {
    expect(plural('doorway', 2)).toBe('doorways')
  })

  it('adds es after a sibilant', () => {
    expect(plural('box', 2)).toBe('boxes')
    expect(plural('bench', 2)).toBe('benches')
    expect(plural('press', 2)).toBe('presses')
  })
})

describe('issueSentence', () => {
  it('writes the acceptance case', () => {
    expect(issueSentence(requirement())).toBe('3 cells have no toilet')
  })

  it('uses the singular for one room, and keeps its capital', () => {
    expect(
      issueSentence(requirement({ count: 1, sourceName: 'Washroom', subjectName: 'Shower head' })),
    ).toBe('Washroom has no shower head')
  })

  it('leaves a name that is deliberately capitalised alone', () => {
    expect(issueSentence(requirement({ count: 2, sourceName: 'C Wing' }))).toBe(
      '2 C Wings have no toilet',
    )
  })

  it('says what a refused action was refused for', () => {
    expect(
      issueSentence({
        kind: 'rejected',
        source: 'placeObject',
        sourceName: 'placeObject',
        subject: 'needs-room',
        subjectName: 'needs-room',
        count: 4,
        focus: [{ x: 1, y: 1 }],
      }),
    ).toBe('4 placeObjects were refused: needs room')
  })
})

describe('formatCost', () => {
  it('groups thousands and drops the pennies', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(150)).toBe('$150')
    expect(formatCost(22_430)).toBe('$22,430')
    expect(formatCost(1_000_000)).toBe('$1,000,000')
  })

  it('handles a refund', () => {
    expect(formatCost(-1_250)).toBe('-$1,250')
  })
})
