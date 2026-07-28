/**
 * Corruption handling.
 *
 * The contract under test is narrow and absolute: every damaged input produces
 * a `SaveError` with a code, and nothing produces a `TypeError`, a
 * `RangeError`, a hang or a half-built world. Each case below damages a
 * different stage of the read path, because a check that only ever runs on the
 * header would let a flipped bit in the payload through.
 */

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { base64ToBytes, checksumBytes, utf8Decode, utf8Encode } from '../../src/save/bytes'
import { decodeSaveFile, loadFromBytes, readSaveHeader } from '../../src/save/deserialise'
import { SAVE_HEADER, SAVE_HEADER_BYTES, SaveError } from '../../src/save/format'
import type { SaveErrorCode, SaveFile } from '../../src/save/format'
import { gzipBytes } from '../../src/save/gzip'
import { encodeSaveFile, toSaveFile } from '../../src/save/serialise'

import { makeSaveState } from './fixture'

const CREATED_AT = '2031-03-12T14:05:00.000Z'

function sampleFile(): SaveFile {
  return toSaveFile(makeSaveState({ size: 16, population: 4 }), { createdAt: CREATED_AT })
}

async function sampleBytes(): Promise<Uint8Array> {
  return encodeSaveFile(sampleFile())
}

/** Re-wraps an arbitrary payload in a valid, self-consistent container. */
async function containerOf(payload: Uint8Array, schemaVersion = 2): Promise<Uint8Array> {
  const compressed = await gzipBytes(payload)
  const bytes = new Uint8Array(SAVE_HEADER_BYTES + compressed.length)
  const header = new DataView(bytes.buffer, 0, SAVE_HEADER_BYTES)
  header.setUint32(SAVE_HEADER.MAGIC, 0x42575356, true)
  header.setUint32(SAVE_HEADER.CONTAINER_VERSION, 1, true)
  header.setUint32(SAVE_HEADER.SCHEMA_VERSION, schemaVersion, true)
  header.setUint32(SAVE_HEADER.PAYLOAD_BYTES, payload.length, true)
  header.setUint32(SAVE_HEADER.PAYLOAD_CHECKSUM, checksumBytes(payload), true)
  bytes.set(compressed, SAVE_HEADER_BYTES)
  return bytes
}

/** A container holding an arbitrary JSON object, so the shape checks can be reached. */
async function containerOfJson(save: JsonObject): Promise<Uint8Array> {
  const version = save['version']
  return containerOf(utf8Encode(JSON.stringify(save)), typeof version === 'number' ? version : 2)
}

async function expectSaveError(
  bytes: Uint8Array,
  code: SaveErrorCode,
  message?: RegExp,
): Promise<SaveError> {
  let thrown: unknown = null
  try {
    await loadFromBytes(bytes)
  } catch (error) {
    thrown = error
  }

  expect(thrown, 'a damaged save must be rejected').toBeInstanceOf(SaveError)
  const failure = thrown as SaveError
  expect(failure.code).toBe(code)
  expect(failure.name).toBe('SaveError')
  if (message !== undefined) expect(failure.message).toMatch(message)
  return failure
}

describe('a damaged container', () => {
  it('rejects an empty file', async () => {
    await expectSaveError(new Uint8Array(0), 'truncated')
  })

  it('rejects a file shorter than the header', async () => {
    await expectSaveError(new Uint8Array(SAVE_HEADER_BYTES - 1), 'truncated')
  })

  it('rejects a file that is not a save at all', async () => {
    const notASave = utf8Encode('this is a photograph, not a prison'.repeat(4))
    await expectSaveError(notASave, 'not-a-save', /not a Blockwork save/)
  })

  it('rejects a container version this build does not know', async () => {
    const bytes = await sampleBytes()
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.CONTAINER_VERSION, 99, true)

    await expectSaveError(bytes, 'unsupported-container', /container version 99/)
  })

  it('rejects a header with no payload behind it', async () => {
    const bytes = (await sampleBytes()).slice(0, SAVE_HEADER_BYTES)
    await expectSaveError(bytes, 'decompression-failed')
  })

  it('rejects a truncated gzip stream', async () => {
    const bytes = await sampleBytes()
    await expectSaveError(bytes.slice(0, bytes.length - 40), 'decompression-failed')
  })

  it('rejects a flipped bit inside the compressed payload', async () => {
    const bytes = await sampleBytes()
    const at = SAVE_HEADER_BYTES + Math.floor((bytes.length - SAVE_HEADER_BYTES) / 2)
    bytes[at] = (bytes[at] ?? 0) ^ 0b0100_0000

    // Either gzip's own CRC catches it or ours does; both are clean errors.
    const failure = await expectSaveError(bytes, 'decompression-failed').catch(async () =>
      expectSaveError(bytes, 'corrupt-payload'),
    )
    expect(failure).toBeInstanceOf(SaveError)
  })

  it('rejects a payload whose length disagrees with the header', async () => {
    const bytes = await sampleBytes()
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.PAYLOAD_BYTES, 12, true)

    await expectSaveError(bytes, 'truncated', /declares 12/)
  })

  it('rejects a payload whose checksum disagrees with the header', async () => {
    const bytes = await sampleBytes()
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.PAYLOAD_CHECKSUM, 0xdead_beef, true)

    await expectSaveError(bytes, 'corrupt-payload', /failed its checksum/)
  })

  it('reads the header of a file whose payload is beyond saving', () => {
    const bytes = new Uint8Array(SAVE_HEADER_BYTES + 3)
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.MAGIC, 0x42575356, true)
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.CONTAINER_VERSION, 1, true)
    new DataView(bytes.buffer).setUint32(SAVE_HEADER.SCHEMA_VERSION, 7, true)

    expect(readSaveHeader(bytes).schemaVersion).toBe(7)
  })
})

describe('a damaged payload', () => {
  it('rejects plaintext that is not JSON', async () => {
    await expectSaveError(await containerOf(utf8Encode('{ not json')), 'malformed-json')
  })

  it('rejects plaintext that is not valid UTF-8', async () => {
    // A lead byte promising three continuations that never arrive.
    await expectSaveError(await containerOf(new Uint8Array([0xe2, 0x28, 0xa1])), 'malformed-json')
  })

  it('rejects JSON that is not an object', async () => {
    await expectSaveError(await containerOf(utf8Encode('[1, 2, 3]')), 'invalid-save')
  })

  it('rejects a save with no version', async () => {
    await expectSaveError(await containerOfJson({ seed: 1 }), 'invalid-save', /'version'/)
  })
})

describe('a save of the right version but the wrong shape', () => {
  const cases: readonly {
    readonly name: string
    readonly mutate: (file: SaveFile) => JsonObject
  }[] = [
    { name: 'a missing seed', mutate: ({ seed: _seed, ...rest }) => rest },
    { name: 'a fractional seed', mutate: (file) => ({ ...file, seed: 1.5 }) },
    { name: 'a negative tick count', mutate: (file) => ({ ...file, playedTicks: -1 }) },
    { name: 'a map size of zero', mutate: (file) => ({ ...file, mapSize: 0 }) },
    { name: 'an absurd map size', mutate: (file) => ({ ...file, mapSize: 1_000_000 }) },
    { name: 'a null settings block', mutate: (file) => ({ ...file, settings: null }) },
    { name: 'entities that are not an array', mutate: (file) => ({ ...file, entities: {} }) },
    {
      name: 'an entity with no id',
      mutate: (file) => ({ ...file, entities: [{ kind: 1 }] }),
    },
    {
      name: 'a log entry with no tick',
      mutate: (file) => ({ ...file, log: [{ kind: 'noted' }] }),
    },
    {
      name: 'a grid missing one of its arrays',
      mutate: (file) => {
        const { dirt: _dirt, ...grid } = file.grid
        return { ...file, grid }
      },
    },
    {
      name: 'an rng stream state outside uint32',
      mutate: (file) => ({
        ...file,
        rngState: { seed: file.rngState.seed, streams: [{ name: 'intake', state: -1 }] },
      }),
    },
    {
      name: 'an rng stream with no name',
      mutate: (file) => ({
        ...file,
        rngState: { seed: file.rngState.seed, streams: [{ state: 1 }] },
      }),
    },
  ]

  for (const { name, mutate } of cases) {
    it(`rejects ${name}`, async () => {
      await expectSaveError(await containerOfJson(mutate(sampleFile())), 'invalid-save')
    })
  }

  it('names the field that was wrong', async () => {
    const failure = await expectSaveError(
      await containerOfJson({ ...sampleFile(), mapSize: 0 }),
      'invalid-save',
    )
    expect(failure.message).toMatch(/'mapSize'/)
  })
})

describe('a damaged grid', () => {
  it('rejects an array that is not base64', async () => {
    const file = sampleFile()
    const damaged = { ...file, grid: { ...file.grid, dirt: 'not base64!!' } }

    await expectSaveError(await containerOfJson(damaged), 'corrupt-payload', /grid\.dirt/)
  })

  it('rejects an array of the wrong length for the map size', async () => {
    const file = sampleFile()
    const damaged = { ...file, grid: { ...file.grid, roomId: 'AAAA' } }

    await expectSaveError(await containerOfJson(damaged), 'corrupt-payload', /grid\.roomId/)
  })

  it('rejects base64 that is not a multiple of four characters', () => {
    expect(() => base64ToBytes('AAA', 'grid.dirt')).toThrow(SaveError)
    expect(() => base64ToBytes('AAA', 'grid.dirt')).toThrow(/grid\.dirt/)
  })

  it('rejects a padding character in the middle of a group', () => {
    expect(() => base64ToBytes('AB=C')).toThrow(SaveError)
  })
})

describe('strict UTF-8 decoding', () => {
  const rejected: readonly { readonly name: string; readonly bytes: readonly number[] }[] = [
    { name: 'a truncated two-byte sequence', bytes: [0xc3] },
    { name: 'an overlong encoding of a space', bytes: [0xe0, 0x80, 0xa0] },
    { name: 'an encoded surrogate half', bytes: [0xed, 0xa0, 0x80] },
    { name: 'a code point above U+10FFFF', bytes: [0xf5, 0x80, 0x80, 0x80] },
    { name: 'a stray continuation byte', bytes: [0x80] },
  ]

  for (const { name, bytes } of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => utf8Decode(new Uint8Array(bytes))).toThrow(SaveError)
    })
  }
})

describe('reporting a failed load', () => {
  function collector(): { readonly events: SimulationEvent[]; emit: (e: SimulationEvent) => void } {
    const events: SimulationEvent[] = []
    return {
      events,
      emit(event: SimulationEvent): void {
        events.push(event)
      },
    }
  }

  it('emits a CausalEvent before it throws (CLAUDE.md rule 5)', async () => {
    const sink = collector()

    await expect(decodeSaveFile(new Uint8Array(4), { events: sink })).rejects.toThrow(SaveError)

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.kind).toBe('save.load.failed')
    expect(sink.events[0]?.data).toMatchObject({ code: 'truncated' })
  })

  it('reports a failure that only surfaces while the grid is rebuilt', async () => {
    const file = sampleFile()
    const bytes = await containerOfJson({
      ...file,
      grid: { ...file.grid, powerGridId: 'AAAA' },
    })
    const sink = collector()

    await expect(loadFromBytes(bytes, { events: sink })).rejects.toThrow(SaveError)

    expect(sink.events.map((event) => event.kind)).toEqual(['save.load.failed'])
    expect(sink.events[0]?.data).toMatchObject({ code: 'corrupt-payload' })
  })
})
