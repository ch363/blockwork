import { describe, expect, it } from 'vitest'

import { MIN_HIT_TARGET_PT, UI_PACKAGE_NAME } from '../src/index'

describe('@blockwork/ui', () => {
  it('exposes its package name', () => {
    expect(UI_PACKAGE_NAME).toBe('@blockwork/ui')
  })

  it('holds the 44pt minimum hit target', () => {
    expect(MIN_HIT_TARGET_PT).toBe(44)
  })
})
