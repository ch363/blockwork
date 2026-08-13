import { describe, expect, it } from 'vitest'

import { SAVE_FILE_EXTENSION } from '@blockwork/sim'

import { exportSaveToFile, importSaveFromFile, readSaveFile, saveFileName } from '../../src/save/file'

/**
 * The browser plumbing in `file.ts` — pickers, object URLs, hidden inputs —
 * needs a real webview to mean anything, and T6.8 covers it on device. What is
 * testable here is the part that has to be right regardless of platform: the
 * name a file gets, the bytes that go into it, and the seam the Capacitor
 * build will use to deliver it.
 */

const SAVED_AT = new Date(2031, 2, 12, 14, 5)

describe('saveFileName', () => {
  it('uses the save name, a readable stamp and the .blockwork extension', () => {
    expect(saveFileName('Wing C', SAVED_AT)).toBe(`Wing C 20310312-1405${SAVE_FILE_EXTENSION}`)
  })

  it('pads every part of the stamp so names sort chronologically', () => {
    expect(saveFileName('a', new Date(2031, 0, 2, 3, 4))).toBe(
      `a 20310102-0304${SAVE_FILE_EXTENSION}`,
    )
  })

  it('strips characters a file system would object to', () => {
    expect(saveFileName('../../etc/passwd', SAVED_AT)).toBe(
      `etc passwd 20310312-1405${SAVE_FILE_EXTENSION}`,
    )
    expect(saveFileName('a/b\\c:d*e?f', SAVED_AT)).toBe(
      `a b c d e f 20310312-1405${SAVE_FILE_EXTENSION}`,
    )
  })

  it('keeps letters and digits from any language', () => {
    expect(saveFileName('監獄 2', SAVED_AT)).toBe(`監獄 2 20310312-1405${SAVE_FILE_EXTENSION}`)
  })

  it('falls back to a default when nothing usable is left', () => {
    expect(saveFileName('***', SAVED_AT)).toBe(`prison 20310312-1405${SAVE_FILE_EXTENSION}`)
    expect(saveFileName('   ', SAVED_AT)).toBe(`prison 20310312-1405${SAVE_FILE_EXTENSION}`)
  })
})

describe('readSaveFile', () => {
  it('reads a picked file into bytes without interpreting them', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251])
    const file = new File([bytes], `x${SAVE_FILE_EXTENSION}`)

    expect([...(await readSaveFile(file))]).toEqual([...bytes])
  })
})

describe('exportSaveToFile', () => {
  it('hands the bytes and the file name to the supplied delivery', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const delivered: { bytes: Uint8Array; fileName: string }[] = []

    const ok = await exportSaveToFile(bytes, {
      name: 'Wing C',
      savedAt: SAVED_AT,
      deliver: async (data, fileName) => {
        delivered.push({ bytes: data, fileName })
        return true
      },
    })

    expect(ok).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.fileName).toBe(`Wing C 20310312-1405${SAVE_FILE_EXTENSION}`)
    expect([...(delivered[0]?.bytes ?? [])]).toEqual([...bytes])
  })

  it('reports a cancelled export rather than throwing', async () => {
    const cancelled = await exportSaveToFile(new Uint8Array(1), {
      name: 'Wing C',
      savedAt: SAVED_AT,
      deliver: async () => false,
    })

    expect(cancelled).toBe(false)
  })

  it('reports failure where the host offers no way to deliver a file', async () => {
    expect(await exportSaveToFile(new Uint8Array(1), { name: 'x', savedAt: SAVED_AT })).toBe(false)
  })
})

describe('importSaveFromFile', () => {
  it('returns the bytes the supplied pickup produced', async () => {
    const bytes = new Uint8Array([4, 5, 6])
    expect([...((await importSaveFromFile(async () => bytes)) ?? [])]).toEqual([...bytes])
  })

  it('returns null when the player cancels', async () => {
    expect(await importSaveFromFile(async () => null)).toBeNull()
  })

  it('returns null where the host offers no picker at all', async () => {
    expect(await importSaveFromFile()).toBeNull()
  })
})
