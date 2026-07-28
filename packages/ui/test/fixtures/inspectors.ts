/**
 * Fixture inspector models for snapshot / layout tests (T2.9).
 *
 * Shaped like the mockup's Screen 1 inmate and PRD 6.2's other variants —
 * display-ready only, no GameData.
 */

import type {
  InmateInspectorModel,
  ObjectInspectorModel,
  RoomInspectorModel,
  StaffInspectorModel,
} from '../../src/panels/inspectorTypes'

export const FIXTURE_INMATE: InmateInspectorModel = {
  kind: 'inmate',
  entityId: 4471,
  name: 'Delroy Ashworth',
  subtitle: 'Inmate 4471 · intake day 11',
  categoryId: 'maximum',
  categoryName: 'Maximum',
  categoryToken: 'cat-max',
  criticalNeedCount: 3,
  sentenceServedLabel: '2y 4m',
  sentenceTotalLabel: '18y',
  sentenceProgress: 13,
  paroleLabel: 'day 341',
  needs: [
    { id: 'food', name: 'Food', value: 97, severity: 'critical' },
    { id: 'safety', name: 'Safety', value: 91, severity: 'critical' },
    { id: 'hygiene', name: 'Hygiene', value: 89, severity: 'critical' },
    { id: 'freedom', name: 'Freedom', value: 72, severity: 'high' },
    { id: 'recreation', name: 'Recreation', value: 54, severity: 'medium' },
    { id: 'sleep', name: 'Sleep', value: 41, severity: 'medium' },
    { id: 'comfort', name: 'Comfort', value: 38, severity: 'ok' },
    { id: 'bladder', name: 'Bladder', value: 22, severity: 'active' },
  ],
  traits: [],
  reputations: [
    { id: 'very_deadly', name: 'Very deadly', tone: 'bad' },
    { id: 'agitator', name: 'Agitator', tone: 'bad' },
    { id: 'unstable', name: 'Unstable', tone: 'warn' },
  ],
  unknownReputationCount: 2,
  activity: 'Queueing · West Hall',
  cellLabel: 'A-14 · grade 3 / 6',
  entitlement: 6,
  suppression: 44,
  workLabel: 'Unassigned',
  programmeLabel: 'None',
  grades: [
    { id: 'punishment', label: 'Punishment', letter: 'C', score: 48, tone: 'warn' },
    { id: 'reform', label: 'Reform', letter: 'E', score: 18, tone: 'danger' },
    { id: 'security', label: 'Security', letter: 'D', score: 32, tone: 'danger' },
    { id: 'health', label: 'Health', letter: 'D', score: 35, tone: 'warn' },
  ],
  reoffendPercent: 74,
  misconduct: [
    { day: 26, label: 'Contraband (shank)', outcome: 'Isolation 6h' },
    { day: 24, label: 'Attacked inmate', outcome: 'Isolation 12h' },
    { day: 19, label: 'Destruction', outcome: 'Lockdown 4h' },
  ],
}

export const FIXTURE_STAFF: StaffInspectorModel = {
  kind: 'staff',
  entityId: 12,
  name: 'Officer 3',
  roleName: 'Officer',
  wagePerHour: 22,
  needs: [
    { id: 'bladder', name: 'Bladder', value: 30, severity: 'ok' },
    { id: 'food', name: 'Food', value: 45, severity: 'medium' },
  ],
  moraleContribution: 4,
  currentTask: 'Patrolling',
  postAssignment: 'Post 2',
  equipment: ['Baton', 'Keys'],
}

export const FIXTURE_ROOM: RoomInspectorModel = {
  kind: 'room',
  roomId: 3,
  name: 'Cell 3',
  typeName: 'Cell',
  width: 6,
  height: 5,
  tiles: 30,
  functional: false,
  requirements: [
    {
      kind: 'object',
      subject: 'bed',
      required: 1,
      actual: 1,
      met: true,
    },
    {
      kind: 'object',
      subject: 'toilet',
      required: 1,
      actual: 0,
      met: false,
    },
    {
      kind: 'property',
      subject: 'enclosed',
      required: 1,
      actual: 1,
      met: true,
    },
  ],
  properties: ['enclosed', 'indoors'],
  occupants: 1,
  gradeLines: [],
  throughputLabel: null,
}

export const FIXTURE_OBJECT: ObjectInspectorModel = {
  kind: 'object',
  entityId: 88,
  name: 'Bed',
  cost: 120,
  hasPower: true,
  hasWater: true,
  needsPower: false,
  needsWater: false,
  roomName: 'Cell 3',
  condition: 60,
  conditionMax: 60,
  needsServed: ['Sleep'],
  contrabandRisk: 0,
}
