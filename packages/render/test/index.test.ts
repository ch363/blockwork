import { describe, expect, it } from 'vitest'

import { RENDER_PACKAGE_NAME, TILE_SIZE } from '../src/index'

describe('@blockwork/render', () => {
  it('exposes its package name', () => {
    expect(RENDER_PACKAGE_NAME).toBe('@blockwork/render')
  })

  it('renders 32 world units per tile', () => {
    expect(TILE_SIZE).toBe(32)
  })
})
