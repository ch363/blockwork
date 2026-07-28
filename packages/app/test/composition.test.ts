import { describe, expect, it } from 'vitest'

import { DATA_SCHEMA_VERSION } from '@blockwork/data'
import { TILE_SIZE } from '@blockwork/render'
import { TICKS_PER_MINUTE } from '@blockwork/sim'
import { MIN_HIT_TARGET_PT } from '@blockwork/ui'

describe('@blockwork/app', () => {
  it('composes every workspace package', () => {
    expect([TICKS_PER_MINUTE, TILE_SIZE, MIN_HIT_TARGET_PT, DATA_SCHEMA_VERSION]).toEqual([
      10, 32, 44, 1,
    ])
  })
})
