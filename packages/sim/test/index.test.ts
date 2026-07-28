import { describe, expect, it } from 'vitest'

import { SIM_PACKAGE_NAME, TICKS_PER_MINUTE } from '../src/index'

describe('@blockwork/sim', () => {
  it('exposes its package name', () => {
    expect(SIM_PACKAGE_NAME).toBe('@blockwork/sim')
  })

  it('runs at 10 ticks per in-game minute', () => {
    expect(TICKS_PER_MINUTE).toBe(10)
  })
})
