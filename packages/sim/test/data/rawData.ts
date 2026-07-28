/**
 * Helpers for the data tests.
 *
 * Every cross-reference test starts from the **real** content files and breaks
 * one thing, which is the only way to be sure the checks fire on the data the
 * game actually ships (T1.1 acceptance). A fixture dataset would drift.
 */

import { RAW_GAME_DATA } from '@blockwork/data'

import type { GameDataFileName, RawGameDataFiles } from '../../src/data/schemas'

export type JsonObject = Record<string, unknown>

/** A mutable deep copy. The files are plain JSON, so this round-trips exactly. */
export function cloneRawData(): Record<GameDataFileName, unknown> & RawGameDataFiles {
  return JSON.parse(JSON.stringify(RAW_GAME_DATA)) as Record<GameDataFileName, unknown> &
    RawGameDataFiles
}

export function fileOf(
  data: Record<GameDataFileName, unknown>,
  file: GameDataFileName,
): JsonObject {
  const value = data[file]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file}.json is not an object`)
  }
  return value as JsonObject
}

/** The named array inside a file, for example `listOf(data, 'rooms', 'rooms')`. */
export function listOf(
  data: Record<GameDataFileName, unknown>,
  file: GameDataFileName,
  key: string,
): JsonObject[] {
  const value = fileOf(data, file)[key]
  if (!Array.isArray(value)) {
    throw new Error(`${file}.json has no array at '${key}'`)
  }
  return value as JsonObject[]
}

/** One definition by id. Throws if the test is pointing at something that moved. */
export function defOf(
  data: Record<GameDataFileName, unknown>,
  file: GameDataFileName,
  key: string,
  id: string,
): JsonObject {
  const found = listOf(data, file, key).find((entry) => entry['id'] === id)
  if (found === undefined) {
    throw new Error(`${file}.json ${key} has no entry '${id}'`)
  }
  return found
}

/** Removes a definition entirely, as if someone had deleted it from the file. */
export function removeDef(
  data: Record<GameDataFileName, unknown>,
  file: GameDataFileName,
  key: string,
  id: string,
): void {
  const list = listOf(data, file, key)
  const index = list.findIndex((entry) => entry['id'] === id)
  if (index < 0) {
    throw new Error(`${file}.json ${key} has no entry '${id}'`)
  }
  list.splice(index, 1)
  fileOf(data, file)[key] = list
}

/** A string array field on a definition, for tests that append a dangling id. */
export function stringArray(def: JsonObject, key: string): string[] {
  const value = def[key]
  if (!Array.isArray(value)) {
    throw new Error(`field '${key}' is not an array`)
  }
  return value as string[]
}

export function objectArray(def: JsonObject, key: string): JsonObject[] {
  const value = def[key]
  if (!Array.isArray(value)) {
    throw new Error(`field '${key}' is not an array`)
  }
  return value as JsonObject[]
}
