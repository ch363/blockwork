import { describe, expect, it } from 'vitest'

import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import {
  decodeSaveFile,
  deserialiseSave,
  migrateSave,
  readSaveHeader,
} from '../../src/save/deserialise'
import {
  CURRENT_SAVE_VERSION,
  FIRST_SUPPORTED_SAVE_VERSION,
  SaveError,
} from '../../src/save/format'
import { MIGRATIONS, migrationSteps } from '../../src/save/migrations'
import type { Migration } from '../../src/save/migrations'
import { encodeSaveFile, toSaveFile } from '../../src/save/serialise'
import { hashSaveState } from '../../src/save/state'

import { makeSaveState } from './fixture'

const CREATED_AT = '2031-03-12T14:05:00.000Z'

function collector(): { readonly events: SimulationEvent[]; emit: (e: SimulationEvent) => void } {
  const events: SimulationEvent[] = []
  return {
    events,
    emit(event: SimulationEvent): void {
      events.push(event)
    },
  }
}

/** The current shape with its version wound back, which is what a v1 file is. */
async function encodeAsVersion(version: number): Promise<Uint8Array> {
  const file = toSaveFile(makeSaveState({ size: 32, population: 8 }), { createdAt: CREATED_AT })
  return encodeSaveFile({ ...file, version })
}

describe('the migration chain (PRD 7.4)', () => {
  it('has one step for every version below the current one, with no gaps', () => {
    const expected: number[] = []
    for (let v = FIRST_SUPPORTED_SAVE_VERSION; v < CURRENT_SAVE_VERSION; v += 1) expected.push(v)

    expect(migrationSteps()).toEqual(expected)
  })

  it('keys each step by the version it migrates from, and stamps the next one', () => {
    for (const from of migrationSteps()) {
      const step = MIGRATIONS[from]
      expect(step, `a migration must exist for v${from}`).toBeDefined()
      expect(step?.({ version: from })['version']).toBe(from + 1)
    }
  })

  it('walks a v1 save up to the current version, reporting each step', () => {
    const sink = collector()
    const migrated = migrateSave({ version: 1, marker: 'kept' }, 1, { events: sink })

    expect(migrated['version']).toBe(CURRENT_SAVE_VERSION)
    expect(sink.events.map((event) => event.kind)).toEqual(sink.events.map(() => 'save.migrated'))
    expect(sink.events).toHaveLength(CURRENT_SAVE_VERSION - 1)
    expect(sink.events.map((event) => event.data)).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ])
  })

  it('defaults Phase 4 fields when migrating a bare v2 save', () => {
    const migrated = migrateSave({ version: 2, mapSize: 16 }, 2)

    expect(migrated['version']).toBe(CURRENT_SAVE_VERSION)
    expect(migrated['sectors']).toEqual({ nextSectorId: 1, sectors: [] })
    expect(migrated['posts']).toEqual({
      nextPostId: 1,
      nextRouteId: 1,
      posts: [],
      routes: [],
    })
    expect(migrated['contraband']).toMatchObject({ nextStashId: 1, stashes: [] })
    expect(migrated['dangerLevel']).toBe(0)
    expect(migrated['riotActive']).toBe(false)
    expect(migrated['lockdownActive']).toBe(false)
    expect(migrated['misconductWindowTicks']).toEqual([])
    expect(migrated['standingOrders']).toMatchObject({ mealQuantity: 'normal' })
    expect(migrated['directorate']).toEqual({ completed: [], active: [] })
  })

  it('carries fields it does not know about straight through', () => {
    const migrated = migrateSave({ version: 1, marker: 'kept', nested: { deep: [1, 2] } }, 1)

    expect(migrated['marker']).toBe('kept')
    expect(migrated['nested']).toEqual({ deep: [1, 2] })
  })

  it('does nothing to a save already at the current version', () => {
    const sink = collector()
    const save: JsonObject = { version: CURRENT_SAVE_VERSION, marker: 'kept' }

    expect(migrateSave(save, CURRENT_SAVE_VERSION, { events: sink })).toBe(save)
    expect(sink.events).toEqual([])
  })

  it('refuses a save from a newer build rather than guessing at its shape', () => {
    const newer = CURRENT_SAVE_VERSION + 1
    const attempt = (): JsonObject => migrateSave({ version: newer }, newer)

    expect(attempt).toThrow(SaveError)
    expect(attempt).toThrow(/newer build/)
  })

  it('refuses a save older than the first supported version', () => {
    const attempt = (): JsonObject => migrateSave({ version: 0 }, 0)

    expect(attempt).toThrow(SaveError)
    expect(attempt).toThrow(/older than the oldest supported version/)
  })

  it('reports a broken chain rather than loading a half-migrated save', () => {
    const attempt = (): JsonObject => migrateSave({ version: 1 }, 1, { migrations: {} })

    expect(attempt).toThrow(SaveError)
    expect(attempt).toThrow(/no migration from save version 1 to 2/)
  })

  it('rejects a step that forgets to stamp the version it produced', () => {
    const forgetful: Record<number, Migration> = { 1: (save) => ({ ...save }) }
    const attempt = (): JsonObject => migrateSave({ version: 1 }, 1, { migrations: forgetful })

    expect(attempt).toThrow(SaveError)
    expect(attempt).toThrow(/stamped 1 instead of 2/)
  })

  it('wraps a step that throws, naming the version that failed', () => {
    const exploding: Record<number, Migration> = {
      1: () => {
        throw new TypeError('cannot read properties of undefined')
      },
    }

    try {
      migrateSave({ version: 1 }, 1, { migrations: exploding })
      expect.unreachable('the migration should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError)
      expect((error as SaveError).code).toBe('migration-failed')
      expect((error as SaveError).message).toMatch(/from version 1 to 2/)
      expect((error as SaveError).cause).toBeInstanceOf(TypeError)
    }
  })
})

describe('loading an older file (PRD 7.4 acceptance)', () => {
  it('opens a v1 file under the current schema', async () => {
    const sink = collector()
    const file = await decodeSaveFile(await encodeAsVersion(1), { events: sink })

    expect(file.version).toBe(CURRENT_SAVE_VERSION)
    expect(sink.events.map((event) => event.kind)).toContain('save.migrated')
  })

  it('gives a v1 file the same state the current version of the same prison has', async () => {
    const state = makeSaveState({ size: 32, population: 8 })
    const current = toSaveFile(state, { createdAt: CREATED_AT })

    const fromV1 = deserialiseSave(
      await decodeSaveFile(await encodeSaveFile({ ...current, version: 1 })),
    )
    const fromCurrent = deserialiseSave(await decodeSaveFile(await encodeSaveFile(current)))

    expect(hashSaveState(fromV1)).toBe(hashSaveState(fromCurrent))
    expect(hashSaveState(fromV1)).toBe(hashSaveState(state))
  })

  it('states the pre-migration version in the header, readable without inflating', async () => {
    expect(readSaveHeader(await encodeAsVersion(1)).schemaVersion).toBe(1)
  })

  it('refuses a file from a future schema with a message a player can act on', async () => {
    await expect(decodeSaveFile(await encodeAsVersion(CURRENT_SAVE_VERSION + 1))).rejects.toThrow(
      /Update Blockwork/,
    )
  })
})
