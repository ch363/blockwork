/**
 * Turns a simulation `RoomGrade` into inspector copy (T5.2 acceptance).
 *
 * The acceptance criterion is that the cell inspector shows *exactly which
 * objects contributed which points*, so the translation from rule to sentence
 * happens here, on the app side, where the object names live and where
 * `packages/sim`'s no-strings rule does not apply. The simulation supplies the
 * arithmetic — subject, points, found, needed — and this decides how to say it.
 */

import { gradeRoom } from '@blockwork/sim'
import type { GameData, InmateWorld, Room, RoomDef } from '@blockwork/sim'

export interface RoomGradeView {
  readonly grade: number | null
  readonly gradeMax: number
  readonly gradeLines: readonly {
    readonly label: string
    readonly points: number
    readonly detail: string | null
  }[]
}

const UNGRADED: RoomGradeView = { grade: null, gradeMax: 0, gradeLines: [] }

export function describeRoomGrade(
  world: InmateWorld,
  data: GameData,
  room: Room,
  def: RoomDef | undefined,
): RoomGradeView {
  if (def === undefined) return UNGRADED
  const grade = gradeRoom(world, data, room, def)
  if (grade === undefined) return UNGRADED

  return {
    grade: grade.score,
    gradeMax: grade.max,
    gradeLines: grade.lines.map((line) => {
      switch (line.rule) {
        case 'object':
          return {
            label: objectNames(data, line.subject),
            points: line.points,
            detail:
              line.needed > 1
                ? `${line.found} present, 1 per ${line.needed}`
                : `${line.found} present`,
          }
        case 'size':
          return {
            label: 'Room size',
            points: line.points,
            detail: `${line.found} tiles, threshold ${line.needed}`,
          }
        case 'window':
          return {
            label: line.points < 0 ? 'No window' : 'Outdoor-facing window',
            points: line.points,
            detail: line.points < 0 ? null : `${line.found} of ${line.needed} needed`,
          }
        case 'material':
          return {
            label: `Depressing surfaces: ${materialNames(data, line.subject)}`,
            points: line.points,
            detail: `${line.found} tiles`,
          }
        case 'custom':
          return {
            label: customLabel(line.subject),
            points: line.points,
            detail: customDetail(line.subject, line.found, line.needed),
          }
      }
    }),
  }
}

/** `"sink/mirror"` → `"Sink / Mirror"`, using the object definitions' names. */
function objectNames(data: GameData, subject: string): string {
  return subject
    .split('/')
    .map((id) => data.objects.find(id)?.name ?? id)
    .join(' / ')
}

function materialNames(data: GameData, subject: string): string {
  const ids = subject.split('/')
  const names = ids.map((id) => data.materials.find(id)?.name ?? id)
  // The penalty lists four or five surfaces; naming them all buries the point.
  return names.length <= 2 ? names.join(' / ') : `${names[0] ?? ''} and ${names.length - 1} more`
}

function customLabel(ruleId: string): string {
  switch (ruleId) {
    case 'meal_quality':
      return 'Meal quantity policy'
    case 'meal_variety':
      return 'Meal variety policy'
    case 'running_track_length':
      return 'Room is big enough to run a lap'
    default:
      return ruleId
  }
}

function customDetail(ruleId: string, found: number, needed: number): string | null {
  switch (ruleId) {
    case 'meal_variety':
      return `${found} ingredients, 1 point per ${needed}`
    case 'running_track_length':
      return `${found} tile perimeter, needs ${needed}`
    default:
      return null
  }
}
