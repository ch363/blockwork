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
 *
 * The v1 to v2 step below is a no-op and exists to be that pattern. A chain
 * whose first real use is also its first execution is a chain nobody has
 * tested.
 */

import type { JsonObject } from '../../core/commands'

/** Transforms a save from version `n` to version `n + 1`. */
export type Migration = (save: JsonObject) => JsonObject

/**
 * v1 to v2: no change to the data.
 *
 * v2 is the first version written by a build that has a migration chain, and
 * the version bump is the whole point: it proves the chain runs, in CI, on
 * every load of an old file. A real migration would look the same but do
 * something between the spread and the version, for example:
 *
 * ```ts
 * const economy = isJsonObject(save['economy']) ? save['economy'] : {}
 * return { ...save, version: 3, economy: { ...economy, wages: economy['wages'] ?? 0 } }
 * ```
 */
const migrateV1ToV2: Migration = (save) => ({ ...save, version: 2 })

/** Keyed by the version each function migrates *from*. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: migrateV1ToV2,
}

/** The version each step in the chain starts from, ascending. */
export function migrationSteps(): readonly number[] {
  return Object.keys(MIGRATIONS)
    .map(Number)
    .sort((a, b) => a - b)
}
