/**
 * T6.5 — new-prison configuration: presets, seeds, failure toggles, mutators,
 * and the round trip through `SaveFile.settings`.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import {
  FAILURE_CONDITIONS,
  MAP_SIZE_PRESETS,
  MUTATORS,
  defaultNewPrisonConfig,
  fromMapSettings,
  isNoFailureMode,
  resolveMapSize,
  seedFromInput,
  toMapSettings,
  withoutFailures,
} from '../../src/core/mapSettings'

const DATA: GameData = loadGameData()

describe('map size presets', () => {
  it('resolves every preset to the tile count in balance.json', () => {
    for (const preset of MAP_SIZE_PRESETS) {
      expect(resolveMapSize(DATA, preset), preset).toBe(DATA.balance.map.sizes[preset])
    }
  })

  it('gets bigger with each step up', () => {
    const sizes = MAP_SIZE_PRESETS.map((preset) => resolveMapSize(DATA, preset))
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1] ?? 0)
    }
  })
})

describe('defaults', () => {
  it('arms everything and switches everything on', () => {
    const config = defaultNewPrisonConfig(DATA)
    for (const condition of FAILURE_CONDITIONS) {
      expect(config.failures[condition], condition).toBe(true)
    }
    for (const mutator of MUTATORS) {
      expect(config.mutators[mutator], mutator).toBe(true)
    }
    expect(config.continuousIntake).toBe(true)
    expect(config.randomEvents).toBe(true)
  })

  it('takes the starting funds from balance rather than inventing one', () => {
    expect(defaultNewPrisonConfig(DATA).startingFunds).toBe(DATA.balance.economy.startingFunds)
  })

  it('covers exactly the failure conditions balance.json declares', () => {
    expect([...FAILURE_CONDITIONS].sort()).toEqual(Object.keys(DATA.balance.failure).sort())
  })
})

describe('no-failure mode (PRD 7.9)', () => {
  it('is every condition off, and says so', () => {
    const config = defaultNewPrisonConfig(DATA)
    expect(isNoFailureMode(config)).toBe(false)

    const safe = withoutFailures(config)
    expect(isNoFailureMode(safe)).toBe(true)
    for (const condition of FAILURE_CONDITIONS) {
      expect(safe.failures[condition], condition).toBe(false)
    }
  })

  it('is not triggered by turning off a single condition', () => {
    const config = defaultNewPrisonConfig(DATA)
    const partial = {
      ...config,
      failures: { ...config.failures, escapes: false },
    }
    expect(isNoFailureMode(partial)).toBe(false)
  })

  it('leaves the mutators alone', () => {
    const safe = withoutFailures(defaultNewPrisonConfig(DATA))
    expect(safe.mutators.fires).toBe(true)
  })
})

describe('seeds', () => {
  /** Seeds are chosen before the simulation exists; entropy is the caller's. */
  const entropy = (): number => 0.5

  it('takes a number as itself', () => {
    expect(seedFromInput('12345', entropy)).toBe(12345)
    expect(seedFromInput('  42  ', entropy)).toBe(42)
  })

  it('hashes a word to the same seed every time', () => {
    const first = seedFromInput('Blockwork', entropy)
    const second = seedFromInput('Blockwork', entropy)
    expect(first).toBe(second)
    expect(first).toBeGreaterThan(0)
    expect(Number.isInteger(first)).toBe(true)
  })

  it('gives different words different seeds', () => {
    expect(seedFromInput('Blockwork', entropy)).not.toBe(seedFromInput('blockwork', entropy))
  })

  it('rolls a random seed for a blank box', () => {
    expect(seedFromInput('', () => 0.5)).toBe(Math.floor(0.5 * 0xffff_ffff))
    expect(seedFromInput('   ', () => 0)).toBe(0)
  })

  it('always produces an unsigned 32-bit integer', () => {
    for (const input of ['Alcatraz', 'a', '', '999999999999', 'ζ']) {
      const seed = seedFromInput(input, () => 0.9999)
      expect(Number.isInteger(seed), input).toBe(true)
      expect(seed, input).toBeGreaterThanOrEqual(0)
      expect(seed, input).toBeLessThanOrEqual(0xffff_ffff)
    }
  })
})

describe('round trip through the save', () => {
  it('survives being written and read back', () => {
    const config = {
      ...defaultNewPrisonConfig(DATA, 777),
      sizePreset: 'large' as const,
      mapSize: resolveMapSize(DATA, 'large'),
      startingFunds: 60_000,
      continuousIntake: false,
      randomEvents: false,
    }
    const restored = fromMapSettings(DATA, toMapSettings(config))
    expect(restored).toEqual(config)
  })

  it('defaults every field a save is missing', () => {
    const restored = fromMapSettings(DATA, { sizePreset: 'small' })
    expect(restored.sizePreset).toBe('small')
    // The tile count follows the preset when the file did not say.
    expect(restored.mapSize).toBe(resolveMapSize(DATA, 'small'))
    expect(restored.failures.escapes).toBe(true)
    expect(restored.mutators.fires).toBe(true)
  })

  it('defaults a condition or mutator a newer build added', () => {
    const config = withoutFailures(defaultNewPrisonConfig(DATA))
    const settings = toMapSettings(config) as Record<string, unknown>
    // An older save that predates `paroleRecidivism` entirely.
    delete (settings['failures'] as Record<string, unknown>)['paroleRecidivism']

    const restored = fromMapSettings(DATA, settings as never)
    expect(restored.failures.escapes).toBe(false)
    // The designed default, not the neighbouring value.
    expect(restored.failures.paroleRecidivism).toBe(true)
  })

  it('falls back entirely on nonsense', () => {
    expect(fromMapSettings(DATA, undefined)).toEqual(defaultNewPrisonConfig(DATA))
    expect(fromMapSettings(DATA, 'not an object' as never).sizePreset).toBe('medium')
    expect(fromMapSettings(DATA, { sizePreset: 'enormous' } as never).sizePreset).toBe('medium')
  })
})
