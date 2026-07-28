import { describe, expect, it } from 'vitest'

import { REPLAY_TOOL_NAME } from '../src/index'

describe('@blockwork/replay', () => {
  it('exposes its tool name', () => {
    expect(REPLAY_TOOL_NAME).toBe('@blockwork/replay')
  })
})
