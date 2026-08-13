/**
 * The migration chain (PRD 7.4: "Migrations are mandatory... Never break a
 * save silently").
 *
 * One function per version step. `MIGRATIONS[n]` takes a save at version `n`
 * and returns the same save at version `n + 1`. Loading runs every step from
 * the file's version up to `CURRENT_SAVE_VERSION`, so a v1 file opened by a
 * v7 build passes through six functions and arrives as a v7 save. No step may
 * be skipped and no step may be edited after it ships: once a build has
 * written v4 files, the v4 to v5 function is the only description anyone has
 * of what v4 meant.
 *
 * **Writing one.** A migration receives plain JSON, not a `SaveFile`, because
 * a save mid-chain is by definition not the current shape. Read defensively —
 * the input came off disk and may be missing anything — set the new fields,
 * and always set `version`. Never throw for a field you can default; throw
 * only when the save genuinely cannot be brought forward, and the loader will
 * turn it into a `SaveError` with the version that failed.
 */

import type { JsonObject, JsonValue } from '../../core/commands'
import { isSectorAccessMode } from '../../world/sectors'

import {
  defaultStandingOrdersState,
  emptyCellGradesState,
  emptyCleaningState,
  emptyCombatState,
  emptyConstructionState,
  emptyContrabandState,
  emptyContractState,
  emptyDeliveriesState,
  emptyDirectorateState,
  emptyDoorsState,
  emptyGradingState,
  emptyProgramsState,
  emptyGradesState,
  emptyParoleState,
  emptyReleaseState,
  emptyIntelligenceState,
  emptyEconomyState,
  emptyEmergencyState,
  emptyEntityRegistryState,
  emptyEscapesState,
  emptyEscortsState,
  emptyFireState,
  emptyFogState,
  emptyIntakeState,
  emptyJobsState,
  emptyLabourState,
  emptyLaundryState,
  emptyMealsState,
  emptyMoraleState,
  emptyNeedsRuntimeState,
  emptyOfficesState,
  emptyPostsState,
  emptyPunishmentsState,
  emptyRiotState,
  emptyRoutineRuntimeState,
  emptySectorsState,
  emptySupplyState,
  emptyUtilitiesState,
} from '../defaults'

/** Transforms a save from version `n` to version `n + 1`. */
export type Migration = (save: JsonObject) => JsonObject

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * v1 to v2: no change to the data.
 *
 * v2 is the first version written by a build that has a migration chain, and
 * the version bump is the whole point: it proves the chain runs, in CI, on
 * every load of an old file.
 */
const migrateV1ToV2: Migration = (save) => ({ ...save, version: 2 })

function normaliseSectors(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value) && Array.isArray(value['sectors'])) {
    const nextSectorId =
      typeof value['nextSectorId'] === 'number' && Number.isInteger(value['nextSectorId'])
        ? value['nextSectorId']
        : 1
    const sectors = value['sectors'].flatMap((entry) => {
      if (!isJsonObject(entry) || typeof entry['id'] !== 'number') return []
      const access = typeof entry['access'] === 'string' ? entry['access'] : 'shared'
      return [
        {
          id: entry['id'],
          name: typeof entry['name'] === 'string' ? entry['name'] : `Sector ${entry['id']}`,
          colour: typeof entry['colour'] === 'string' ? entry['colour'] : '',
          access: isSectorAccessMode(access) ? access : 'shared',
          categories: Array.isArray(entry['categories'])
            ? entry['categories'].filter((c): c is string => typeof c === 'string')
            : [],
        },
      ]
    })
    return { nextSectorId, sectors }
  }
  // v2 stub arrays are not real sector defs — drop them.
  return emptySectorsState()
}

function normalisePosts(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value) && Array.isArray(value['posts']) && Array.isArray(value['routes'])) {
    return {
      nextPostId:
        typeof value['nextPostId'] === 'number' && Number.isInteger(value['nextPostId'])
          ? value['nextPostId']
          : 1,
      nextRouteId:
        typeof value['nextRouteId'] === 'number' && Number.isInteger(value['nextRouteId'])
          ? value['nextRouteId']
          : 1,
      posts: value['posts'],
      routes: value['routes'],
    }
  }
  return emptyPostsState()
}

function normaliseStandingOrders(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value) && isJsonObject(value['misconduct'])) {
    return value
  }
  return defaultStandingOrdersState()
}

function normaliseEconomy(value: JsonValue | undefined): JsonObject {
  if (
    isJsonObject(value) &&
    typeof value['balance'] === 'number' &&
    Array.isArray(value['entries'])
  ) {
    return {
      balance: value['balance'],
      loanPrincipal: typeof value['loanPrincipal'] === 'number' ? value['loanPrincipal'] : 0,
      insolvencyDeadlineTick:
        typeof value['insolvencyDeadlineTick'] === 'number' ||
        value['insolvencyDeadlineTick'] === null
          ? value['insolvencyDeadlineTick']
          : null,
      insolvencyStartedTick:
        typeof value['insolvencyStartedTick'] === 'number' ||
        value['insolvencyStartedTick'] === null
          ? value['insolvencyStartedTick']
          : null,
      entries: value['entries'],
    }
  }
  return emptyEconomyState()
}

function normaliseContracts(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value) && Array.isArray(value['active']) && Array.isArray(value['finished'])) {
    return {
      active: value['active'],
      finished: value['finished'],
      revealed: Array.isArray(value['revealed']) ? value['revealed'] : [],
    }
  }
  // v2 stored an opaque array.
  return emptyContractState()
}

function mapSizeOf(save: JsonObject): number {
  return typeof save['mapSize'] === 'number' && Number.isInteger(save['mapSize'])
    ? save['mapSize']
    : 0
}

function normaliseUtilities(value: JsonValue | undefined): JsonObject {
  if (
    isJsonObject(value) &&
    Array.isArray(value['cableTiles']) &&
    Array.isArray(value['pipeTiles'])
  ) {
    return {
      cableTiles: value['cableTiles'],
      pipeTiles: value['pipeTiles'],
      shedBranches: Array.isArray(value['shedBranches']) ? value['shedBranches'] : [],
      waterMultipliers: Array.isArray(value['waterMultipliers']) ? value['waterMultipliers'] : [],
    }
  }
  return emptyUtilitiesState()
}

/**
 * v2 to v3: Phase 4 live snapshots + concrete economy / contracts / posts /
 * sectors / standing orders shapes. Missing fields default; already-v3-shaped
 * fields (e.g. a current save stamped back to v1 for migration tests) are kept.
 */
const migrateV2ToV3: Migration = (save) => {
  const size = mapSizeOf(save)
  return {
    ...save,
    version: 3,
    nextRoomId: typeof save['nextRoomId'] === 'number' ? save['nextRoomId'] : 1,
    sectors: normaliseSectors(save['sectors']),
    posts: normalisePosts(save['posts']),
    standingOrders: normaliseStandingOrders(save['standingOrders']),
    economy: normaliseEconomy(save['economy']),
    contracts: normaliseContracts(save['contracts']),
    contraband: isJsonObject(save['contraband']) ? save['contraband'] : emptyContrabandState(),
    fire: isJsonObject(save['fire']) ? save['fire'] : emptyFireState(size),
    riot: isJsonObject(save['riot']) ? save['riot'] : emptyRiotState(),
    emergency: isJsonObject(save['emergency']) ? save['emergency'] : emptyEmergencyState(),
    escapes: isJsonObject(save['escapes']) ? save['escapes'] : emptyEscapesState(),
    combat: isJsonObject(save['combat']) ? save['combat'] : emptyCombatState(),
    punishments: isJsonObject(save['punishments']) ? save['punishments'] : emptyPunishmentsState(),
    utilities: normaliseUtilities(save['utilities']),
    dangerLevel: typeof save['dangerLevel'] === 'number' ? save['dangerLevel'] : 0,
    riotActive: save['riotActive'] === true,
    lockdownActive: save['lockdownActive'] === true,
    misconductWindowTicks: Array.isArray(save['misconductWindowTicks'])
      ? save['misconductWindowTicks']
      : [],
  }
}

function normaliseDirectorate(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value) && Array.isArray(value['completed']) && Array.isArray(value['active'])) {
    return {
      completed: value['completed'].filter((id): id is string => typeof id === 'string'),
      active: value['active'].flatMap((entry) => {
        if (!isJsonObject(entry) || typeof entry['nodeId'] !== 'string') return []
        return [
          {
            nodeId: entry['nodeId'],
            startedTick: typeof entry['startedTick'] === 'number' ? entry['startedTick'] : 0,
            elapsedTicks: typeof entry['elapsedTicks'] === 'number' ? entry['elapsedTicks'] : 0,
            pausedReason: typeof entry['pausedReason'] === 'string' ? entry['pausedReason'] : null,
          },
        ]
      }),
    }
  }
  // v3 stored an opaque placeholder object.
  return emptyDirectorateState()
}

function normaliseGrading(value: JsonValue | undefined): JsonObject {
  if (
    isJsonObject(value) &&
    Array.isArray(value['roomGrades']) &&
    Array.isArray(value['lastEntitlementTick'])
  ) {
    return {
      roomGrades: value['roomGrades'],
      lastEntitlementTick: value['lastEntitlementTick'],
      averageCellGrade:
        typeof value['averageCellGrade'] === 'number' ? value['averageCellGrade'] : 0,
    }
  }
  return emptyGradingState()
}

function normalisePrograms(value: JsonValue | undefined): JsonObject {
  if (
    isJsonObject(value) &&
    Array.isArray(value['enrolments']) &&
    Array.isArray(value['completions']) &&
    Array.isArray(value['pins'])
  ) {
    return {
      enrolments: value['enrolments'],
      completions: value['completions'],
      pins: value['pins'],
    }
  }
  return emptyProgramsState()
}

/**
 * v3 to v4: Phase 5 state.
 *
 * A v3 save was written before any of this existed, so every field defaults to
 * "nothing has happened yet" — no research bought, no grades computed, no
 * programmes scheduled. The grading and grade passes recompute on their next
 * hourly tick regardless, so defaulting them costs the player one in-game hour
 * of stale numbers rather than a wrong prison.
 */
const migrateV3ToV4: Migration = (save) => ({
  ...save,
  version: 4,
  directorate: normaliseDirectorate(save['directorate']),
  grading: normaliseGrading(save['grading']),
  programs: normalisePrograms(save['programs']),
  grades:
    isJsonObject(save['grades']) && Array.isArray(save['grades']['confinement'])
      ? save['grades']
      : emptyGradesState(),
  parole:
    isJsonObject(save['parole']) && Array.isArray(save['parole']['queue'])
      ? save['parole']
      : emptyParoleState(),
  release:
    isJsonObject(save['release']) && Array.isArray(save['release']['released'])
      ? save['release']
      : emptyReleaseState(),
  intelligence:
    isJsonObject(save['intelligence']) && Array.isArray(save['intelligence']['informants'])
      ? save['intelligence']
      : emptyIntelligenceState(),
})

/**
 * v4 to v5: live-world runtimes that `InmateWorld.hashInto` treats as
 * authoritative. A v4 save predates these fields, so every one defaults to
 * "nothing has happened yet" — empty labour, full morale, no logistics stock,
 * no fog, continuous intake with no pending bus requests.
 */
const migrateV4ToV5: Migration = (save) => ({
  ...save,
  version: 5,
  utilities: normaliseUtilities(save['utilities']),
  entityRegistry: isJsonObject(save['entityRegistry'])
    ? save['entityRegistry']
    : emptyEntityRegistryState(),
  doors: isJsonObject(save['doors']) && Array.isArray(save['doors']['doors'])
    ? save['doors']
    : emptyDoorsState(),
  construction: isJsonObject(save['construction']) && Array.isArray(save['construction']['sites'])
    ? save['construction']
    : emptyConstructionState(),
  intake: isJsonObject(save['intake']) ? save['intake'] : emptyIntakeState(),
  cellGrades: isJsonObject(save['cellGrades']) && Array.isArray(save['cellGrades']['grades'])
    ? save['cellGrades']
    : emptyCellGradesState(),
  incomeOwed: typeof save['incomeOwed'] === 'number' ? save['incomeOwed'] : 0,
  staffOnlyRoomIds: Array.isArray(save['staffOnlyRoomIds']) ? save['staffOnlyRoomIds'] : [],
  intakeSearchedInmateIds: Array.isArray(save['intakeSearchedInmateIds'])
    ? save['intakeSearchedInmateIds']
    : [],
  staffNeedsEnabled: typeof save['staffNeedsEnabled'] === 'boolean' ? save['staffNeedsEnabled'] : true,
  fog: isJsonObject(save['fog']) && Array.isArray(save['fog']['revealedTiles'])
    ? save['fog']
    : emptyFogState(),
  offices: isJsonObject(save['offices']) && Array.isArray(save['offices']['claims'])
    ? save['offices']
    : emptyOfficesState(),
  escorts: isJsonObject(save['escorts']) && Array.isArray(save['escorts']['jobs'])
    ? save['escorts']
    : emptyEscortsState(),
  jobs: isJsonObject(save['jobs']) && Array.isArray(save['jobs']['jobs'])
    ? save['jobs']
    : emptyJobsState(),
  labour: isJsonObject(save['labour']) && Array.isArray(save['labour']['assignments'])
    ? save['labour']
    : emptyLabourState(),
  morale: isJsonObject(save['morale']) ? save['morale'] : emptyMoraleState(),
  needsRuntime: isJsonObject(save['needsRuntime']) && Array.isArray(save['needsRuntime']['inmates'])
    ? save['needsRuntime']
    : emptyNeedsRuntimeState(),
  routineRuntime:
    isJsonObject(save['routineRuntime']) && Array.isArray(save['routineRuntime']['inmates'])
      ? save['routineRuntime']
      : emptyRoutineRuntimeState(),
  meals: isJsonObject(save['meals']) ? save['meals'] : emptyMealsState(),
  supply: isJsonObject(save['supply']) && Array.isArray(save['supply']['orders'])
    ? save['supply']
    : emptySupplyState(),
  deliveries: isJsonObject(save['deliveries']) && Array.isArray(save['deliveries']['pending'])
    ? save['deliveries']
    : emptyDeliveriesState(),
  cleaning: isJsonObject(save['cleaning']) ? save['cleaning'] : emptyCleaningState(),
  laundry: isJsonObject(save['laundry']) ? save['laundry'] : emptyLaundryState(),
})

/** Keyed by the version each function migrates *from*. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
}

/** The version each step in the chain starts from, ascending. */
export function migrationSteps(): readonly number[] {
  return Object.keys(MIGRATIONS)
    .map(Number)
    .sort((a, b) => a - b)
}
