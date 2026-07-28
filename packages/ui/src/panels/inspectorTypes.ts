/**
 * Inspector view models (PRD 6.2).
 *
 * Display strings and pre-resolved numbers only — the UI package holds no
 * `GameData`. The host (session / worker) fills these from the simulation.
 */

import type { RoomRequirement } from '@blockwork/sim'

import type { NeedRowModel } from '../controls/NeedRow'

/** Security-category token name (`cat-max`, …) for the avatar stripe. */
export type CategoryToken =
  | 'cat-min'
  | 'cat-med'
  | 'cat-max'
  | 'cat-supermax'
  | 'cat-protective'
  | 'cat-condemned'

export type InspectorNeed = NeedRowModel

export interface InspectorReputation {
  readonly id: string
  readonly name: string
  readonly tone: 'bad' | 'warn' | 'info' | 'ghost'
}

export interface InspectorMisconduct {
  readonly day: number
  readonly label: string
  readonly outcome: string
}

export interface InspectorGrade {
  readonly id: string
  readonly label: string
  /** Letter grade shown in the mockup (A–F). */
  readonly letter: string
  /** 0..100 fill. */
  readonly score: number
  readonly tone: 'ok' | 'warn' | 'danger'
}

export interface InmateInspectorModel {
  readonly kind: 'inmate'
  readonly entityId: number
  readonly name: string
  /** "Inmate 4471 · 34 · intake day 11" */
  readonly subtitle: string
  readonly categoryId: string
  readonly categoryName: string
  readonly categoryToken: CategoryToken
  readonly criticalNeedCount: number
  readonly sentenceServedLabel: string
  readonly sentenceTotalLabel: string
  /** 0..100. */
  readonly sentenceProgress: number
  readonly paroleLabel: string | null
  readonly needs: readonly InspectorNeed[]
  readonly traits: readonly string[]
  readonly reputations: readonly InspectorReputation[]
  readonly unknownReputationCount: number
  readonly activity: string
  readonly cellLabel: string
  readonly entitlement: number
  readonly suppression: number
  readonly workLabel: string
  readonly programmeLabel: string
  readonly grades: readonly InspectorGrade[]
  readonly reoffendPercent: number
  readonly misconduct: readonly InspectorMisconduct[]
}

export interface StaffInspectorModel {
  readonly kind: 'staff'
  readonly entityId: number
  readonly name: string
  readonly roleName: string
  readonly wagePerHour: number
  readonly needs: readonly InspectorNeed[]
  readonly moraleContribution: number
  readonly currentTask: string
  readonly postAssignment: string
  readonly equipment: readonly string[]
}

export interface RoomInspectorModel {
  readonly kind: 'room'
  readonly roomId: number
  readonly name: string
  readonly typeName: string
  readonly width: number
  readonly height: number
  readonly tiles: number
  readonly functional: boolean
  readonly requirements: readonly RoomRequirement[]
  readonly properties: readonly string[]
  readonly occupants: number
  /** Line-by-line grade breakdown; empty until grading lands (T5.2). */
  readonly gradeLines: readonly { readonly label: string; readonly points: number }[]
  readonly throughputLabel: string | null
}

export interface ObjectInspectorModel {
  readonly kind: 'object'
  readonly entityId: number
  readonly name: string
  readonly cost: number
  readonly hasPower: boolean
  readonly hasWater: boolean
  readonly needsPower: boolean
  readonly needsWater: boolean
  readonly roomName: string | null
  /** Current / max hit points. */
  readonly condition: number
  readonly conditionMax: number
  readonly needsServed: readonly string[]
  /** 0..100 risk, or 0 when the object is not a source. */
  readonly contrabandRisk: number
}

/** An empty tile: still worth a panel, because it says what is there. */
export interface TileInspectorModel {
  readonly kind: 'tile'
  readonly x: number
  readonly y: number
  readonly floorName: string
  readonly wallName: string | null
  readonly roomName: string | null
  readonly walkable: boolean
}

export type InspectorModel =
  | InmateInspectorModel
  | StaffInspectorModel
  | RoomInspectorModel
  | ObjectInspectorModel
  | TileInspectorModel

/** Maps a security category id onto a colour token. */
export function categoryToken(categoryId: string): CategoryToken {
  switch (categoryId) {
    case 'minimum':
      return 'cat-min'
    case 'medium':
      return 'cat-med'
    case 'maximum':
      return 'cat-max'
    case 'supermax':
      return 'cat-supermax'
    case 'protective':
      return 'cat-protective'
    case 'condemned':
      return 'cat-condemned'
    default:
      return 'cat-med'
  }
}
