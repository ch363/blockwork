/**
 * @vitest-environment happy-dom
 */

/**
 * Tests for the ErrorBoundary component (T8.15).
 *
 * Note: Testing error boundaries in Preact with happy-dom is limited because
 * `getDerivedStateFromError` behavior varies across environments. These tests
 * focus on what can be reliably verified: callback invocation and correct
 * component structure.
 */

import { describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import type { JSX } from 'preact'

import { ErrorBoundary, PanelBoundary } from '../../src/components/ErrorBoundary'

function ThrowingComponent(): JSX.Element {
  throw new Error('Intentional test error')
}

function WorkingComponent(): JSX.Element {
  return <div data-testid="working">All good!</div>
}

describe('ErrorBoundary (T8.15)', () => {
  it('renders children when no error occurs', () => {
    const container = document.createElement('div')
    render(
      <ErrorBoundary>
        <WorkingComponent />
      </ErrorBoundary>,
      container,
    )

    expect(container.innerHTML).toContain('All good!')
  })

  it('calls onError callback when error is caught', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()

    const container = document.createElement('div')
    render(
      <ErrorBoundary name="my-panel" onError={onError}>
        <ThrowingComponent />
      </ErrorBoundary>,
      container,
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'my-panel')

    consoleError.mockRestore()
  })

  it('uses default name when calling onError without explicit name', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()

    const container = document.createElement('div')
    render(
      <ErrorBoundary onError={onError}>
        <ThrowingComponent />
      </ErrorBoundary>,
      container,
    )

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'unknown')

    consoleError.mockRestore()
  })
})

describe('PanelBoundary (T8.15)', () => {
  it('wraps content in an ErrorBoundary and invokes callback', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()

    const container = document.createElement('div')
    render(
      <PanelBoundary name="inspector" onError={onError}>
        <ThrowingComponent />
      </PanelBoundary>,
      container,
    )

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'inspector')

    consoleError.mockRestore()
  })

  it('passes through children when no error', () => {
    const container = document.createElement('div')
    render(
      <PanelBoundary name="inspector">
        <WorkingComponent />
      </PanelBoundary>,
      container,
    )

    expect(container.innerHTML).toContain('All good!')
  })
})
