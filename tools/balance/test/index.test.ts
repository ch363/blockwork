import { describe, expect, it } from 'vitest'

import { BALANCE_TOOL_NAME } from '../src/index'

describe('@blockwork/balance', () => {
  it('exposes its tool name', () => {
    expect(BALANCE_TOOL_NAME).toBe('@blockwork/balance')
  })
})
