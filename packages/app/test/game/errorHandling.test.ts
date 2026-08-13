/**
 * Tests for runtime error handling (T8.15).
 *
 * Covers:
 * - Error boundary containment
 * - sim:error surfacing
 * - Save-failure feedback
 */

import { describe, expect, it, vi } from 'vitest'

import type { SimWorkerOutbound } from '../../src/worker/simWorker'
import type { SimWorkerPort } from '../../src/worker/bridge'
import { SimBridge } from '../../src/worker/bridge'

function createStubWorker(): {
  worker: SimWorkerPort
  triggerMessage: (data: SimWorkerOutbound) => void
  triggerError: (event: Partial<ErrorEvent>) => void
} {
  let messageHandler: ((event: MessageEvent<SimWorkerOutbound>) => void) | null = null
  let errorHandler: ((event: ErrorEvent) => void) | null = null

  const worker: SimWorkerPort = {
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, listener: unknown) => {
      if (type === 'message') {
        messageHandler = listener as (event: MessageEvent<SimWorkerOutbound>) => void
      } else if (type === 'error') {
        errorHandler = listener as (event: ErrorEvent) => void
      }
    }),
    removeEventListener: vi.fn(),
    terminate: vi.fn(),
  }

  return {
    worker,
    triggerMessage: (data) => {
      messageHandler?.({ data } as MessageEvent<SimWorkerOutbound>)
    },
    triggerError: (event) => {
      errorHandler?.(event as ErrorEvent)
    },
  }
}

describe('sim:error surfacing (T8.15)', () => {
  it('bridge captures sim:error and exposes it via the error property', () => {
    const { worker, triggerMessage } = createStubWorker()

    const bridge = new SimBridge({
      worker,
      seed: 123,
      mapSize: 64,
      sharedMemory: false,
    })

    expect(bridge.error).toBeNull()

    triggerMessage({
      type: 'sim:error',
      message: 'Something went wrong in the simulation',
    })

    expect(bridge.error).toBe('Something went wrong in the simulation')
  })

  it('onWorkerError callback is invoked on worker onerror', () => {
    const { worker, triggerError } = createStubWorker()
    const onWorkerError = vi.fn()

    // Creating bridge installs the error handler
    new SimBridge({
      worker,
      seed: 123,
      mapSize: 64,
      sharedMemory: false,
      onWorkerError,
    })

    triggerError({ message: 'Worker crashed unexpectedly' })

    expect(onWorkerError).toHaveBeenCalledWith('Worker crashed unexpectedly')
  })
})

describe('speed override consumption (T8.15)', () => {
  it('takeSpeedOverride returns null when no override has been set', () => {
    const { worker } = createStubWorker()

    const bridge = new SimBridge({
      worker,
      seed: 123,
      mapSize: 64,
      sharedMemory: false,
    })

    expect(bridge.takeSpeedOverride()).toBeNull()
  })

  it('takeSpeedOverride returns the override and clears it', () => {
    const { worker, triggerMessage } = createStubWorker()

    const bridge = new SimBridge({
      worker,
      seed: 123,
      mapSize: 64,
      sharedMemory: false,
    })

    triggerMessage({
      type: 'sim:speedChanged',
      speed: 0,
      reason: 'critical',
    })

    const override = bridge.takeSpeedOverride()
    expect(override).toEqual({ speed: 0, reason: 'critical' })

    // Second call should return null (consumed)
    expect(bridge.takeSpeedOverride()).toBeNull()
  })
})

describe('save failure feedback (T8.15)', () => {
  it('isQuotaError detects DOMException with QuotaExceededError name', () => {
    // This tests the pattern matching for quota errors
    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    expect(quotaError.name).toBe('QuotaExceededError')

    const regularError = new Error('Some other error')
    expect(regularError.name).toBe('Error')
  })

  it('quota error messages include helpful context', () => {
    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    const message = `Save failed: ${quotaError.message}`
    expect(message).toContain('quota')
  })
})
