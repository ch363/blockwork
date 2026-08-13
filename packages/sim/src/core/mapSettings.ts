/**
 * New-prison configuration and the map settings a save carries (T6.5).
 *
 * Everything the player chooses before the first tick lives here: how big the
 * map is, how much money they start with, whether inmates keep arriving, which
 * failure conditions are armed, and which subsystems are switched on at all.
 *
 * The distinction that matters is between this and *preferences*. Audio,
 * accessibility, autosave cadence and the colour-blind palette are properties
 * of the player and belong to the app; they follow someone between prisons and
 * must never change what the simulation does. Everything in this module is the
 * opposite: it is a property of the prison, it is written into the save, and
 * two prisons with different settings are legitimately different games.
 *
 * PRD 7.9's "no failure mode" is not a separate switch — it is every failure
 * condition turned off, which is the same thing said once instead of twice.
 */

import type { JsonObject, JsonValue } from './commands'
import type { GameData } from '../data/loader'

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** Map size presets. The tile counts themselves are balance (PRD 4.3). */
export const MAP_SIZE_PRESETS = ['small', 'medium', 'large', 'huge'] as const
export type MapSizePreset = (typeof MAP_SIZE_PRESETS)[number]

/**
 * The failure conditions of PRD 5.15, each individually armable.
 *
 * Exactly the keys of `balance.failure`, so a condition cannot be offered in
 * the UI that no system knows how to check.
 */
export const FAILURE_CONDITIONS = [
  'uncontainedRiot',
  'insolvency',
  'deaths',
  'escapes',
  'wardenDeaths',
  'paroleRecidivism',
  'wrongfulExecutions',
] as const
export type FailureCondition = (typeof FAILURE_CONDITIONS)[number]

/**
 * Sandbox mutators: whole subsystems the player can switch off.
 *
 * Each one is a thing that can go wrong. Turning them off is how a player who
 * wants to build rather than firefight gets to do that, and it is also how a
 * scenario test isolates one subsystem from the rest.
 */
export const MUTATORS = ['staffNeeds', 'contraband', 'fires', 'tunnels', 'utilities'] as const
export type Mutator = (typeof MUTATORS)[number]

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

export interface NewPrisonConfig {
  readonly sizePreset: MapSizePreset
  /** Tiles per axis, resolved from the preset. */
  readonly mapSize: number
  /** Unsigned 32-bit. The same seed and the same commands are the same game. */
  readonly seed: number
  readonly startingFunds: number
  readonly continuousIntake: boolean
  readonly failures: Readonly<Record<FailureCondition, boolean>>
  /** Random events (PRD 6.x). Off disables the event system entirely. */
  readonly randomEvents: boolean
  readonly mutators: Readonly<Record<Mutator, boolean>>
  /**
   * First-order material grace (T8.4): construction bills fill themselves
   * until the player designates a Store. The opening dock is always placed.
   */
  readonly firstOrderGrace: boolean
}

export function resolveMapSize(data: GameData, preset: MapSizePreset): number {
  return data.balance.map.sizes[preset]
}

/** Everything armed, everything on — the game as designed. */
export function defaultNewPrisonConfig(data: GameData, seed = 1): NewPrisonConfig {
  return {
    sizePreset: 'medium',
    mapSize: resolveMapSize(data, 'medium'),
    seed,
    startingFunds: data.balance.economy.startingFunds,
    continuousIntake: true,
    failures: allFailures(true),
    randomEvents: true,
    mutators: allMutators(true),
    firstOrderGrace: data.balance.construction.firstOrderGraceDefault,
  }
}

/** PRD 7.9's no-failure mode, stated as what it actually is. */
export function withoutFailures(config: NewPrisonConfig): NewPrisonConfig {
  return { ...config, failures: allFailures(false) }
}

export function isNoFailureMode(config: NewPrisonConfig): boolean {
  return FAILURE_CONDITIONS.every((condition) => !config.failures[condition])
}

function allFailures(value: boolean): Record<FailureCondition, boolean> {
  return Object.fromEntries(FAILURE_CONDITIONS.map((condition) => [condition, value])) as Record<
    FailureCondition,
    boolean
  >
}

function allMutators(value: boolean): Record<Mutator, boolean> {
  return Object.fromEntries(MUTATORS.map((mutator) => [mutator, value])) as Record<Mutator, boolean>
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The config as it is written into `SaveFile.settings`.
 *
 * Flat and explicit rather than nested, because a save read by a future build
 * has to be able to pick out the fields it recognises without understanding
 * the shape, and because `fromMapSettings` has to be able to default anything
 * that is missing.
 */
export function toMapSettings(config: NewPrisonConfig): JsonObject {
  return {
    sizePreset: config.sizePreset,
    mapSize: config.mapSize,
    seed: config.seed,
    startingFunds: config.startingFunds,
    continuousIntake: config.continuousIntake,
    randomEvents: config.randomEvents,
    failures: { ...config.failures },
    mutators: { ...config.mutators },
    firstOrderGrace: config.firstOrderGrace,
  }
}

/**
 * Reads a config back, defaulting anything the file does not have.
 *
 * Defensive because the input came off disk: a save written by an older build
 * predates whichever condition or mutator was added since, and the honest
 * default for a switch nobody has ever seen is the designed one.
 */
export function fromMapSettings(data: GameData, settings: JsonValue | undefined): NewPrisonConfig {
  const defaults = defaultNewPrisonConfig(data)
  if (!isJsonObject(settings)) return defaults

  const preset = readPreset(settings['sizePreset'], defaults.sizePreset)
  return {
    sizePreset: preset,
    mapSize: readInt(settings['mapSize'], resolveMapSize(data, preset)),
    seed: readInt(settings['seed'], defaults.seed),
    startingFunds: readInt(settings['startingFunds'], defaults.startingFunds),
    continuousIntake: readBoolean(settings['continuousIntake'], defaults.continuousIntake),
    randomEvents: readBoolean(settings['randomEvents'], defaults.randomEvents),
    failures: readFlags(settings['failures'], FAILURE_CONDITIONS, defaults.failures),
    mutators: readFlags(settings['mutators'], MUTATORS, defaults.mutators),
    firstOrderGrace: readBoolean(settings['firstOrderGrace'], defaults.firstOrderGrace),
  }
}

function readFlags<K extends string>(
  value: JsonValue | undefined,
  keys: readonly K[],
  defaults: Readonly<Record<K, boolean>>,
): Record<K, boolean> {
  const source = isJsonObject(value) ? value : {}
  return Object.fromEntries(
    keys.map((key) => [key, readBoolean(source[key], defaults[key])]),
  ) as Record<K, boolean>
}

export function isMapSizePreset(value: string): value is MapSizePreset {
  return (MAP_SIZE_PRESETS as readonly string[]).includes(value)
}

export function isFailureCondition(value: string): value is FailureCondition {
  return (FAILURE_CONDITIONS as readonly string[]).includes(value)
}

export function isMutator(value: string): value is Mutator {
  return (MUTATORS as readonly string[]).includes(value)
}

function readPreset(value: JsonValue | undefined, fallback: MapSizePreset): MapSizePreset {
  return typeof value === 'string' && isMapSizePreset(value) ? value : fallback
}

function readInt(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

function readBoolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* Seeds                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Turns whatever the player typed into a seed.
 *
 * A blank box is a random prison; a number is that number; anything else is
 * hashed, so "Alcatraz" is a seed and is the *same* seed every time — which is
 * the only reason to let someone type a word rather than a number.
 *
 * `random` is required rather than defaulted to `Math.random`. Picking a seed
 * is the one legitimate moment for entropy in the whole game, and it happens
 * *before* the simulation exists — so the entropy is the caller's to supply
 * and `packages/sim` stays free of it (CLAUDE.md rule 3).
 */
export function seedFromInput(input: string, random: () => number): number {
  const trimmed = input.trim()
  if (trimmed === '') return Math.floor(random() * 0xffff_ffff) >>> 0

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 0) {
    return numeric >>> 0
  }

  // FNV-1a over the characters. Stable across runs and platforms, which a
  // string hash used as a seed absolutely has to be.
  let hash = 0x811c_9dc5
  for (let i = 0; i < trimmed.length; i += 1) {
    hash ^= trimmed.charCodeAt(i)
    hash = Math.imul(hash, 0x0100_0193) >>> 0
  }
  return hash >>> 0
}
