import { describe, expect, it } from 'vitest'

import {
  DATA_FILE_NAMES,
  DATA_PACKAGE_NAME,
  DATA_SCHEMA_VERSION,
  RAW_GAME_DATA,
} from '../src/index'

describe('@blockwork/data', () => {
  it('exposes its package name', () => {
    expect(DATA_PACKAGE_NAME).toBe('@blockwork/data')
  })

  it('starts at schema version 1', () => {
    expect(DATA_SCHEMA_VERSION).toBe(1)
  })

  it('exports one parsed document per definition file', () => {
    expect(Object.keys(RAW_GAME_DATA).sort()).toEqual([...DATA_FILE_NAMES].sort())
    for (const file of DATA_FILE_NAMES) {
      expect(RAW_GAME_DATA[file], `${file}.json`).toBeTypeOf('object')
    }
  })
})
