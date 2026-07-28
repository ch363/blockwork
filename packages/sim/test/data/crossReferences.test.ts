/**
 * One case per class of cross-reference failure (T1.1).
 *
 * Every case starts from the real content files and breaks exactly one link,
 * then asserts that the load fails with a message naming both ends and the
 * exact path. Testing against the shipped data rather than a fixture is the
 * point: a check that only fires on a toy dataset is not a check.
 */

import { describe, expect, it } from 'vitest'

import { GameDataError, loadGameData } from '../../src/data/loader'
import type { GameDataFileName } from '../../src/data/schemas'

import { defOf, cloneRawData, objectArray, removeDef, stringArray } from './rawData'

type Raw = ReturnType<typeof cloneRawData>

interface Case {
  /** What the content author did wrong. */
  readonly name: string
  readonly breakIt: (raw: Raw) => void
  /** Every pattern must appear somewhere in the thrown message. */
  readonly expected: readonly RegExp[]
}

/** Reads a predicate object out of a contract's todo list. */
function predicateOf(raw: Raw, contractId: string, index: number): Record<string, unknown> {
  const contract = defOf(raw, 'contracts', 'contracts', contractId)
  const item = objectArray(contract, 'todoItems')[index]
  if (item === undefined) {
    throw new Error(`contract '${contractId}' has no todo item at ${index}`)
  }
  return item['predicate'] as Record<string, unknown>
}

function nested(def: Record<string, unknown>, key: string): Record<string, unknown> {
  return def[key] as Record<string, unknown>
}

const CASES: readonly Case[] = [
  /* ---- rooms ---- */
  {
    name: 'a room requires an object that has been deleted',
    breakIt: (raw) => removeDef(raw, 'objects', 'objects', 'bed'),
    expected: [
      /rooms\.json rooms\[\d+\]\.requiredObjects\[\d+\]\.objectId/,
      /room 'cell' references object 'bed', which is not defined in objects\.json/,
    ],
  },
  {
    name: 'a required object does not count for the room that requires it',
    breakIt: (raw) => {
      defOf(raw, 'objects', 'objects', 'bed')['countsForRooms'] = ['dormitory']
    },
    expected: [
      /room 'cell' requires object 'bed', but that object's countsForRooms does not list 'cell'/,
    ],
  },
  {
    name: 'a room suggests an object that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'rooms', 'rooms', 'cell'), 'suggestedObjects').push('hammock')
    },
    expected: [
      /rooms\.json rooms\[\d+\]\.suggestedObjects\[\d+\]/,
      /room 'cell' references object 'hammock'/,
    ],
  },
  {
    name: 'a room serves a need that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'rooms', 'rooms', 'cell'), 'servesNeeds').push('morale')
    },
    expected: [/room 'cell' references need 'morale', which is not defined in needs\.json/],
  },
  {
    name: 'a room offers job slots on an object that does not exist',
    breakIt: (raw) => {
      nested(defOf(raw, 'rooms', 'rooms', 'library'), 'jobSlots')['objectId'] = 'ghost_desk'
    },
    expected: [
      /rooms\.json rooms\[\d+\]\.jobSlots\.objectId/,
      /room 'library' references object 'ghost_desk'/,
    ],
  },
  {
    name: 'a room auto-purchases a supply that does not exist',
    breakIt: (raw) => {
      const entry = objectArray(defOf(raw, 'rooms', 'rooms', 'supply_closet'), 'autoPurchase')[0]
      if (entry !== undefined) entry['itemId'] = 'bleach'
    },
    expected: [
      /room 'supply_closet' references supply 'bleach', which is not defined in materials\.json/,
    ],
  },
  {
    name: 'a room is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'rooms', 'rooms', 'cell')['unlockedBy'] = 'mystery_node'
    },
    expected: [
      /rooms\.json rooms\[\d+\]\.unlockedBy/,
      /room 'cell' references Directorate node 'mystery_node', which is not defined in directorate\.json/,
    ],
  },
  {
    name: 'a grading rule awards points for an object that does not exist',
    breakIt: (raw) => {
      const rules = nested(defOf(raw, 'rooms', 'rooms', 'cell'), 'gradingRules')
      const rule = objectArray(rules, 'objectPoints')[0]
      if (rule !== undefined) rule['objectIds'] = ['gilded_bed']
    },
    expected: [
      /rooms\.json rooms\[\d+\]\.gradingRules\.objectPoints\[\d+\]\.objectIds\[\d+\]/,
      /room 'cell' grading references object 'gilded_bed'/,
    ],
  },
  {
    name: 'a grading rule penalises a material that does not exist',
    breakIt: (raw) => {
      const rules = nested(defOf(raw, 'rooms', 'rooms', 'cell'), 'gradingRules')
      const rule = objectArray(rules, 'materialPenalties')[0]
      if (rule !== undefined) rule['materialIds'] = ['damp_render']
    },
    expected: [/room 'cell' grading references material 'damp_render'/],
  },
  {
    name: 'a graded room declares no grading rules',
    breakIt: (raw) => {
      delete defOf(raw, 'rooms', 'rooms', 'cell')['gradingRules']
    },
    expected: [/room 'cell' is graded but declares no gradingRules/],
  },
  {
    name: 'an ungraded room declares grading rules',
    breakIt: (raw) => {
      const cell = defOf(raw, 'rooms', 'rooms', 'cell')
      defOf(raw, 'rooms', 'rooms', 'kitchen')['gradingRules'] = cell['gradingRules']
    },
    expected: [/room 'kitchen' declares gradingRules but is not graded/],
  },

  /* ---- objects ---- */
  {
    name: 'an object serves a need that does not exist',
    breakIt: (raw) => {
      const serves = objectArray(defOf(raw, 'objects', 'objects', 'bed'), 'servesNeeds')[0]
      if (serves !== undefined) serves['need'] = 'dreams'
    },
    expected: [
      /objects\.json objects\[\d+\]\.servesNeeds\[\d+\]\.need/,
      /object 'bed' references need 'dreams'/,
    ],
  },
  {
    name: 'an object counts for a room that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'objects', 'objects', 'bed'), 'countsForRooms').push('penthouse')
    },
    expected: [/object 'bed' references room 'penthouse', which is not defined in rooms\.json/],
  },
  {
    name: 'an object sources a contraband item that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'objects', 'objects', 'weapon_rack'), 'contrabandSourceFor').push(
        'cannon',
      )
    },
    expected: [
      /object 'weapon_rack' references contraband item 'cannon', which is not defined in contraband\.json/,
    ],
  },
  {
    name: 'an object is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'objects', 'objects', 'camera')['unlockedBy'] = 'ghost_node'
    },
    expected: [/object 'camera' references Directorate node 'ghost_node'/],
  },

  /* ---- doors (T1.2) ---- */
  {
    name: 'a door is built from something that is neither a material nor a supply',
    breakIt: (raw) => {
      const entry = objectArray(defOf(raw, 'materials', 'doors', 'secure'), 'materials')[0]
      if (entry === undefined) throw new Error("door 'secure' has no bill of materials")
      entry['itemId'] = 'unobtainium'
    },
    expected: [
      /materials\.json doors\[\d+\]\.materials\[\d+\]\.itemId/,
      /door 'secure' is built from 'unobtainium', which is neither a material nor a supply/,
    ],
  },
  {
    name: 'a door starts locked but cannot be locked',
    breakIt: (raw) => {
      defOf(raw, 'materials', 'doors', 'barred')['lockable'] = false
    },
    expected: [/door 'barred' starts locked but is not lockable/],
  },
  {
    name: 'a door type is missing altogether',
    breakIt: (raw) => removeDef(raw, 'materials', 'doors', 'remote'),
    expected: [/materials\.json doors: door type 'remote' has no definition/],
  },
  {
    name: 'a door is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'materials', 'doors', 'isolation')['unlockedBy'] = 'ghost_node'
    },
    expected: [/door 'isolation' references Directorate node 'ghost_node'/],
  },

  /* ---- needs ---- */
  {
    name: 'a need is gated on a trait that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'needs', 'needs', 'literacy')['onlyWithTrait'] = 'bookish'
    },
    expected: [
      /needs\.json needs\[\d+\]\.onlyWithTrait/,
      /need 'literacy' references trait 'bookish', which is not defined in inmates\.json/,
    ],
  },
  {
    name: 'a need has thresholds that do not increase',
    breakIt: (raw) => {
      defOf(raw, 'needs', 'needs', 'food')['thresholds'] = { medium: 70, high: 65, critical: 88 }
    },
    expected: [/need 'food' thresholds must increase: medium 70, high 65, critical 88/],
  },

  /* ---- staff ---- */
  {
    name: 'a staff role lists a need that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'staff', 'staff', 'officer'), 'needs').push('wanderlust')
    },
    expected: [/staff 'officer' references need 'wanderlust'/],
  },
  {
    name: 'a staff role lists an inmate-only need',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'staff', 'staff', 'officer'), 'needs').push('freedom')
    },
    expected: [/staff 'officer' lists need 'freedom', which is not a staff need/],
  },
  {
    name: 'a staff role requires a room that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'staff', 'staff', 'armed_officer')['requiresRoom'] = 'bunker'
    },
    expected: [/staff 'armed_officer' references room 'bunker'/],
  },
  {
    name: 'a staff role requires a per-head object that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'staff', 'staff', 'armed_officer')['requiresObjectPerHead'] = 'gun_locker'
    },
    expected: [/staff 'armed_officer' references object 'gun_locker'/],
  },
  {
    name: 'a staff role is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'staff', 'staff', 'medic')['unlockedBy'] = 'ghost_node'
    },
    expected: [/staff 'medic' references Directorate node 'ghost_node'/],
  },
  {
    name: 'an administrator does not require an office',
    breakIt: (raw) => {
      defOf(raw, 'staff', 'staff', 'warden')['requiresOffice'] = false
    },
    expected: [/staff 'warden' is an administrator but requires no office/],
  },

  /* ---- directorate ---- */
  {
    name: 'a Directorate node names a prerequisite that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'directorate', 'nodes', 'canine')['prerequisites'] = ['ghost_node']
    },
    expected: [
      /directorate\.json nodes\[\d+\]\.prerequisites\[\d+\]/,
      /Directorate node 'canine' references Directorate node 'ghost_node'/,
    ],
  },
  {
    name: 'Directorate prerequisites form a cycle',
    breakIt: (raw) => {
      defOf(raw, 'directorate', 'nodes', 'security_office')['prerequisites'] = ['patrols']
    },
    expected: [/prerequisite cycle: security_office -> patrols -> security_office/],
  },
  {
    name: 'a Directorate node is owned by a staff role that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'directorate', 'nodes', 'welfare')['administrator'] = 'chancellor'
    },
    expected: [/Directorate node 'welfare' references staff 'chancellor'/],
  },
  {
    name: 'a Directorate node is owned by a non-administrator',
    breakIt: (raw) => {
      defOf(raw, 'directorate', 'nodes', 'welfare')['administrator'] = 'officer'
    },
    expected: [
      /Directorate node 'welfare' is owned by staff 'officer', which is not an administrator/,
    ],
  },
  {
    name: 'a Directorate node unlocks a feature that balance.json does not list',
    breakIt: (raw) => {
      defOf(raw, 'directorate', 'nodes', 'welfare')['unlocksFeatures'] = ['telepathy']
    },
    expected: [
      /Directorate node 'welfare' references feature 'telepathy', which is not defined in balance\.json/,
    ],
  },

  /* ---- programs ---- */
  {
    name: 'a program names a tutor that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'basic_literacy')['tutorStaffId'] = 'professor'
    },
    expected: [/program 'basic_literacy' references staff 'professor'/],
  },
  {
    name: 'a program runs in a room that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'basic_literacy')['roomId'] = 'lecture_hall'
    },
    expected: [/program 'basic_literacy' references room 'lecture_hall'/],
  },
  {
    name: 'a program seats inmates at an object that does not belong in its room',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'basic_literacy')['seatObjectId'] = 'bed'
    },
    expected: [
      /program 'basic_literacy' seats inmates at 'bed', which does not count for its room 'classroom'/,
    ],
  },
  {
    name: 'a program names a prerequisite program that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'vocational_certificate')['prerequisiteProgramId'] =
        'ghost'
    },
    expected: [/program 'vocational_certificate' references program 'ghost'/],
  },
  {
    name: 'program prerequisites form a cycle',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'basic_literacy')['prerequisiteProgramId'] =
        'vocational_certificate'
    },
    expected: [/prerequisite cycle: basic_literacy -> vocational_certificate -> basic_literacy/],
  },
  {
    name: 'a program effect suppresses a need that does not exist',
    breakIt: (raw) => {
      const effect = objectArray(
        defOf(raw, 'programs', 'programs', 'substance_treatment'),
        'effects',
      )[0]
      if (effect !== undefined) effect['needId'] = 'sobriety'
    },
    expected: [/program 'substance_treatment' references need 'sobriety'/],
  },
  {
    name: 'a program effect modifies a trait that does not exist',
    breakIt: (raw) => {
      const effect = objectArray(
        defOf(raw, 'programs', 'programs', 'anger_management'),
        'effects',
      )[0]
      if (effect !== undefined) effect['traitId'] = 'rage'
    },
    expected: [/program 'anger_management' references trait 'rage'/],
  },
  {
    name: 'a program is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'programs', 'programs', 'basic_literacy')['unlockedBy'] = 'ghost_node'
    },
    expected: [/program 'basic_literacy' references Directorate node 'ghost_node'/],
  },

  /* ---- contraband ---- */
  {
    name: 'a contraband item is sourced from a room that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'contraband', 'items', 'pistol')['sourceRooms'] = ['bunker']
    },
    expected: [
      /contraband\.json items\[\d+\]\.sourceRooms\[\d+\]/,
      /contraband item 'pistol' references room 'bunker', which is not defined in rooms\.json/,
    ],
  },
  {
    name: 'a contraband item is crafted in a room that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'contraband', 'items', 'shiv')['craftableIn'] = ['forge']
    },
    expected: [/contraband item 'shiv' references room 'forge'/],
  },
  {
    name: 'a contraband item is sourced from a room that has been deleted',
    breakIt: (raw) => removeDef(raw, 'rooms', 'rooms', 'grove'),
    expected: [/contraband item 'pruning_shears' references room 'grove'/],
  },

  /* ---- contracts ---- */
  {
    name: 'a contract requires a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'contracts', 'contracts', 'education_trial')['prerequisites'] = ['ghost_node']
    },
    expected: [/contract 'education_trial' references Directorate node 'ghost_node'/],
  },
  {
    name: 'a contract predicate counts a room that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'fit_for_purpose', 0)['roomId'] = 'ghost_room'
    },
    expected: [
      /contracts\.json contracts\[\d+\]\.todoItems\[\d+\]\.predicate\.roomId/,
      /contract 'fit_for_purpose' references room 'ghost_room'/,
    ],
  },
  {
    name: 'a contract predicate counts an object that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'secure_estate', 0)['objectId'] = 'ghost_camera'
    },
    expected: [/contract 'secure_estate' references object 'ghost_camera'/],
  },
  {
    name: 'a contract predicate names a staff role that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'administration', 1)['staffId'] = 'ghost_warden'
    },
    expected: [/contract 'administration' references staff 'ghost_warden'/],
  },
  {
    name: 'a contract predicate names a program that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'education_trial', 2)['programId'] = 'ghost_course'
    },
    expected: [/contract 'education_trial' references program 'ghost_course'/],
  },
  {
    name: 'a contract predicate names a Directorate node that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'administration', 2)['nodeId'] = 'ghost_node'
    },
    expected: [/contract 'administration' references Directorate node 'ghost_node'/],
  },
  {
    name: 'a contract predicate names a need that does not exist',
    breakIt: (raw) => {
      predicateOf(raw, 'duty_of_care', 3)['needId'] = 'ghost_need'
    },
    expected: [/contract 'duty_of_care' references need 'ghost_need'/],
  },
  {
    name: 'a hidden contract has no reveal predicate',
    breakIt: (raw) => {
      delete defOf(raw, 'contracts', 'contracts', 'rescue_package')['revealWhen']
    },
    expected: [/contract 'rescue_package' is hidden but has no reveal predicate/],
  },
  {
    name: 'a visible contract has a reveal predicate',
    breakIt: (raw) => {
      defOf(raw, 'contracts', 'contracts', 'fit_for_purpose')['revealWhen'] = [
        { type: 'insolvencyImminent' },
      ]
    },
    expected: [/contract 'fit_for_purpose' has a reveal predicate but is not hidden/],
  },

  /* ---- inmates ---- */
  {
    name: 'a security category is unlocked by a Directorate node that does not exist',
    breakIt: (raw) => {
      defOf(raw, 'inmates', 'securityCategories', 'condemned')['unlockedBy'] = 'ghost_node'
    },
    expected: [/security category 'condemned' references Directorate node 'ghost_node'/],
  },
  {
    name: 'a conviction grants a trait that does not exist',
    breakIt: (raw) => {
      stringArray(defOf(raw, 'inmates', 'convictions', 'murder'), 'grantsTraits').push('malicious')
    },
    expected: [
      /conviction 'murder' references trait 'malicious', which is not defined in inmates\.json/,
    ],
  },
  {
    name: 'a conviction grants a trait that has been deleted',
    breakIt: (raw) => removeDef(raw, 'inmates', 'traits', 'clever'),
    expected: [/references trait 'clever'/],
  },
  {
    name: 'a conviction sentence range is inverted',
    breakIt: (raw) => {
      defOf(raw, 'inmates', 'convictions', 'murder')['minYears'] = 30
    },
    expected: [/conviction 'murder' has minYears 30 above maxYears 25/],
  },

  /* ---- balance ---- */
  {
    name: 'balance.json rates a security category that does not exist',
    breakIt: (raw) => {
      const rates = nested(
        nested(raw['balance'] as Record<string, unknown>, 'misconduct'),
        'baseRatePer10MinutesByCategory',
      )
      rates['ultramax'] = 0.02
    },
    expected: [
      /balance\.json misconduct\.baseRatePer10MinutesByCategory\.ultramax/,
      /references security category 'ultramax', which is not defined in inmates\.json/,
    ],
  },
  {
    name: 'balance.json omits a security category',
    breakIt: (raw) => {
      const rates = nested(
        nested(raw['balance'] as Record<string, unknown>, 'misconduct'),
        'baseRatePer10MinutesByCategory',
      )
      delete rates['supermax']
    },
    expected: [/security category 'supermax' has no base misconduct rate/],
  },
  {
    name: 'balance.json lays a foundation floor that does not exist',
    breakIt: (raw) => {
      const balance = raw['balance'] as Record<string, unknown>
      nested(balance, 'construction')['foundationFloorMaterial'] = 'terrazzo'
    },
    expected: [
      /balance\.json construction\.foundationFloorMaterial/,
      /references material 'terrazzo', which is not defined in materials\.json/,
    ],
  },
  {
    name: 'balance.json lays a wall material as a foundation floor',
    breakIt: (raw) => {
      const balance = raw['balance'] as Record<string, unknown>
      nested(balance, 'construction')['foundationFloorMaterial'] = 'brick_wall'
    },
    expected: [/foundations lay 'brick_wall', which is not a floor material/],
  },
  {
    name: 'balance.json lists a feature twice',
    breakIt: (raw) => {
      const balance = raw['balance'] as Record<string, unknown>
      const features = balance['features'] as string[]
      features.push('sector_view')
    },
    expected: [/balance\.json features: contains duplicate feature ids/],
  },
]

describe('loadGameData, cross-reference validation', () => {
  it.each(CASES)('rejects: $name', ({ breakIt, expected }) => {
    const raw = cloneRawData()
    breakIt(raw)

    let thrown: unknown
    try {
      loadGameData(raw)
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'expected loadGameData to throw').toBeInstanceOf(GameDataError)
    const message = (thrown as GameDataError).message
    for (const pattern of expected) {
      expect(message).toMatch(pattern)
    }
  })

  it('names the file, the path and both ends of every issue', () => {
    const raw = cloneRawData()
    removeDef(raw, 'objects', 'objects', 'toilet')

    try {
      loadGameData(raw)
      expect.unreachable('expected the load to throw')
    } catch (error) {
      const issues = (error as GameDataError).issues
      expect(issues.length).toBeGreaterThan(0)
      for (const issue of issues) {
        expect(issue.file).toMatch(/\.json$/)
        expect(issue.path).not.toBe('')
        expect(issue.message).toContain("'toilet'")
      }
      // Every room that required a toilet reports separately, so the content
      // author fixes them in one pass rather than one run each.
      const rooms: GameDataFileName = 'rooms'
      expect(issues.filter((issue) => issue.file === `${rooms}.json`).length).toBeGreaterThan(1)
    }
  })
})
