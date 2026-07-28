/**
 * @blockwork/data - versioned game content and balance definitions.
 *
 * The definition JSON files live at the package root. They are imported
 * statically so that a bundler inlines them into the simulation worker: the
 * worker has no filesystem, and the content is not optional, so there is
 * nothing to gain from loading it asynchronously.
 *
 * Everything here is deliberately typed as `unknown`. The shapes are owned by
 * the Zod schemas in `@blockwork/sim/data`, and inferring them from the JSON
 * literals instead would let a malformed file typecheck against itself.
 */

import balance from '../balance.json'
import contraband from '../contraband.json'
import contracts from '../contracts.json'
import directorate from '../directorate.json'
import inmates from '../inmates.json'
import materials from '../materials.json'
import needs from '../needs.json'
import objects from '../objects.json'
import programs from '../programs.json'
import rooms from '../rooms.json'
import staff from '../staff.json'
import traceStrings from '../traceStrings.json'

export const DATA_PACKAGE_NAME = '@blockwork/data'

/** Bumped whenever a definition file changes shape in a breaking way. */
export const DATA_SCHEMA_VERSION = 1

/** File names without the `.json` suffix, in load order. */
export const DATA_FILE_NAMES = [
  'balance',
  'materials',
  'needs',
  'rooms',
  'objects',
  'staff',
  'directorate',
  'programs',
  'contraband',
  'contracts',
  'inmates',
] as const

export type DataFileName = (typeof DATA_FILE_NAMES)[number]

/** The unvalidated file contents. `loadGameData()` in the sim package validates them. */
export const RAW_GAME_DATA: Readonly<Record<DataFileName, unknown>> = {
  balance,
  materials,
  needs,
  rooms,
  objects,
  staff,
  directorate,
  programs,
  contraband,
  contracts,
  inmates,
}

/**
 * Trace panel string catalogue (T3.1). Loaded separately from `RAW_GAME_DATA`
 * because it is UI copy, not simulation balance — `parseTraceStrings` validates.
 */
export const RAW_TRACE_STRINGS: unknown = traceStrings
