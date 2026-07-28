import { describe, expect, it } from 'vitest'

import { Simulation } from '../../src/core/simulation'
import {
  base64ToBytes,
  bytesToBase64,
  orientBytes,
  utf8Decode,
  utf8Encode,
} from '../../src/save/bytes'
import {
  decodeSaveFile,
  deserialiseSave,
  loadFromBytes,
  readSaveHeader,
} from '../../src/save/deserialise'
import {
  CURRENT_SAVE_VERSION,
  SAVE_CONTAINER_VERSION,
  SAVE_HEADER_BYTES,
} from '../../src/save/format'
import { encodeSaveFile, saveToBytes, toSaveFile } from '../../src/save/serialise'
import { hashSaveState, saveStateWorld } from '../../src/save/state'
import type { SaveState } from '../../src/save/state'
import { TILE_FIELDS } from '../../src/world/tileGrid'

import { LARGE_MAP, POPULATION, makeSaveState } from './fixture'

const CREATED_AT = '2031-03-12T14:05:00.000Z'

function simulationHash(state: SaveState): number {
  return new Simulation({ seed: state.seed, world: saveStateWorld(state) }).hash()
}

describe('base64 (PRD 7.4)', () => {
  it('round-trips every byte value and every remainder length', () => {
    for (let length = 0; length < 260; length += 1) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + length) & 0xff

      const encoded = bytesToBase64(bytes)
      expect(encoded.length % 4, `length ${length} must pad to a multiple of 4`).toBe(0)
      expect([...base64ToBytes(encoded)]).toEqual([...bytes])
    }
  })

  it('agrees with the platform encoder', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 65, 66])
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('UTF-8 (PRD 7.4)', () => {
  it('round-trips ASCII, accents, CJK and astral characters', () => {
    const text = 'Wing C — 監獄 — \u{1f9f1} — plain ascii'
    expect(utf8Decode(utf8Encode(text))).toBe(text)
  })

  it('agrees with the platform encoder', () => {
    const text = 'Directorate — Routine — Standing Orders'
    expect([...utf8Encode(text)]).toEqual([...Buffer.from(text, 'utf8')])
  })
})

describe('byte order (PRD 7.4)', () => {
  it('is its own inverse, so one function serves read and write', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    expect([...orientBytes(orientBytes(bytes.slice(), 2), 2)]).toEqual([...bytes])
  })
})

describe('save round trip (PRD 7.4)', () => {
  it('carries a full 220x220 grid and 400 entities to an identical hash', async () => {
    const before = makeSaveState()
    expect(before.grid.size).toBe(LARGE_MAP)
    expect(before.entities).toHaveLength(POPULATION)

    const bytes = await saveToBytes(before, { createdAt: CREATED_AT })
    const after = await loadFromBytes(bytes)

    expect(hashSaveState(after)).toBe(hashSaveState(before))
    expect(simulationHash(after)).toBe(simulationHash(before))
  })

  it('restores every field of the grid byte for byte', async () => {
    const before = makeSaveState({ size: 64, population: 8 })
    const after = await loadFromBytes(await saveToBytes(before, { createdAt: CREATED_AT }))

    expect(after.grid.size).toBe(before.grid.size)
    for (const field of TILE_FIELDS) {
      expect([...after.grid.array(field)], field).toEqual([...before.grid.array(field)])
    }
  })

  it('restores the scalars, the opaque state and the rng streams', async () => {
    const before = makeSaveState({ size: 32, population: 4 })
    const after = await loadFromBytes(await saveToBytes(before, { createdAt: CREATED_AT }))

    expect(after.seed).toBe(before.seed)
    expect(after.playedTicks).toBe(before.playedTicks)
    expect(after.settings).toEqual(before.settings)
    expect(after.entities).toEqual(before.entities)
    expect(after.rooms).toEqual(before.rooms)
    expect(after.sectors).toEqual(before.sectors)
    expect(after.economy).toEqual(before.economy)
    expect(after.directorate).toEqual(before.directorate)
    expect(after.contracts).toEqual(before.contracts)
    expect(after.routines).toEqual(before.routines)
    expect(after.standingOrders).toEqual(before.standingOrders)
    expect(after.posts).toEqual(before.posts)
    expect(after.log).toEqual(before.log)
    expect(after.rngState).toEqual(before.rngState)
  })

  it('is byte-for-byte reproducible: saving the same state twice gives the same file', async () => {
    const state = makeSaveState({ size: 48, population: 16 })
    const first = await saveToBytes(state, { createdAt: CREATED_AT })
    const second = await saveToBytes(state, { createdAt: CREATED_AT })

    expect([...second]).toEqual([...first])
  })

  it('survives a reload of a reload', async () => {
    const first = makeSaveState({ size: 48, population: 16 })
    const second = await loadFromBytes(await saveToBytes(first, { createdAt: CREATED_AT }))
    const third = await loadFromBytes(await saveToBytes(second, { createdAt: CREATED_AT }))

    expect(hashSaveState(third)).toBe(hashSaveState(first))
  })

  it('notices a single flipped bit anywhere in the grid', async () => {
    const before = makeSaveState({ size: 32, population: 4 })
    const after = await loadFromBytes(await saveToBytes(before, { createdAt: CREATED_AT }))

    after.grid.setAt('dirt', 500, (after.grid.getAt('dirt', 500) + 1) & 0xff)
    expect(hashSaveState(after)).not.toBe(hashSaveState(before))
  })

  it('hashes independently of the key order JSON round-tripping produces', () => {
    const state = makeSaveState({ size: 8, population: 2 })
    const reordered: SaveState = {
      ...state,
      economy: { dailyExpenditure: 3_100, balance: 42_000 },
    }

    expect(hashSaveState(reordered)).toBe(hashSaveState(state))
  })
})

describe('the container header (PRD 7.4)', () => {
  it('states the container and schema versions in plaintext', async () => {
    const bytes = await saveToBytes(makeSaveState({ size: 16, population: 2 }), {
      createdAt: CREATED_AT,
    })
    const header = readSaveHeader(bytes)

    expect(header.containerVersion).toBe(SAVE_CONTAINER_VERSION)
    expect(header.schemaVersion).toBe(CURRENT_SAVE_VERSION)
    expect(header.payloadBytes).toBeGreaterThan(0)
  })

  it('gzips: a grid of one repeated value compresses far below its base64 size', async () => {
    const state = makeSaveState({ size: 128, population: 0 })
    state.grid.fill('floorMaterial', 3)
    for (const field of TILE_FIELDS) {
      if (field !== 'floorMaterial') state.grid.fill(field, 0)
    }

    const bytes = await saveToBytes(state, { createdAt: CREATED_AT })
    const header = readSaveHeader(bytes)
    const compressed = bytes.length - SAVE_HEADER_BYTES

    expect(compressed).toBeLessThan(header.payloadBytes / 20)
  })

  it('keeps a 220x220 prison with 400 inmates under the PRD 3MB budget', async () => {
    const bytes = await saveToBytes(makeSaveState(), { createdAt: CREATED_AT })
    expect(bytes.length).toBeLessThan(3 * 1024 * 1024)
  })
})

describe('toSaveFile', () => {
  it('takes createdAt from the caller, because sim may not read the clock', () => {
    const file = toSaveFile(makeSaveState({ size: 8, population: 1 }), { createdAt: CREATED_AT })
    expect(file.createdAt).toBe(CREATED_AT)
    expect(file.version).toBe(CURRENT_SAVE_VERSION)
    expect(file.mapSize).toBe(8)
  })

  it('caps the log at 2000 entries and emits a CausalEvent for the ones it drops', () => {
    const state = makeSaveState({ size: 8, population: 1 })
    const overflowing: SaveState = {
      ...state,
      log: Array.from({ length: 2_050 }, (_unused, index) => ({ tick: index })),
    }

    const emitted: { kind: string; data: unknown }[] = []
    const file = toSaveFile(overflowing, {
      createdAt: CREATED_AT,
      events: {
        emit(event): void {
          emitted.push({ kind: event.kind, data: event.data })
        },
      },
    })

    expect(file.log).toHaveLength(2_000)
    expect(file.log[0]).toEqual({ tick: 50 })
    expect(emitted).toEqual([{ kind: 'save.log.truncated', data: { dropped: 50, kept: 2_000 } }])
  })

  it('copies the rng state rather than aliasing the live one', async () => {
    const state = makeSaveState({ size: 8, population: 1 })
    const file = toSaveFile(state, { createdAt: CREATED_AT })
    const decoded = await decodeSaveFile(await encodeSaveFile(file))

    expect(decoded.rngState).toEqual(state.rngState)
    expect(decoded.rngState.streams).not.toBe(state.rngState.streams)
  })
})

describe('deserialiseSave', () => {
  it('marks the whole grid dirty, so every consumer rebuilds from the save', async () => {
    const file = toSaveFile(makeSaveState({ size: 32, population: 1 }), { createdAt: CREATED_AT })
    const state = deserialiseSave(await decodeSaveFile(await encodeSaveFile(file)))

    expect(state.grid.dirtyChunkCount).toBe(state.grid.chunkCount)
  })
})
