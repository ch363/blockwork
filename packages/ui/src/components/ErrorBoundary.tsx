/**
 * Error boundary for Preact panels (T8.15).
 *
 * A render error in any panel previously blanked the whole app because there
 * was no boundary to catch it. This component catches errors in its children
 * and displays a contained fallback, keeping the canvas and other panels
 * functional.
 */

import type { ComponentChildren, JSX } from 'preact'
import { Component } from 'preact'

export interface ErrorBoundaryProps {
  /** The component tree to protect. */
  readonly children: ComponentChildren
  /** Identifier for error reports; helps locate which panel threw. */
  readonly name?: string
  /** Called when an error is caught. */
  readonly onError?: (error: Error, name: string) => void
}

interface ErrorBoundaryState {
  readonly error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static override getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    const name = this.props.name ?? 'unknown'
    console.error(`Blockwork error in ${name}:`, error)
    this.props.onError?.(error, name)
  }

  override render(): ComponentChildren {
    const { error } = this.state
    if (error === null) return this.props.children

    const name = this.props.name ?? 'component'
    return (
      <div class="bw-error-boundary" role="alert" aria-live="assertive">
        <div class="bw-error-boundary-content">
          <div class="bw-error-boundary-title">Something went wrong</div>
          <div class="bw-error-boundary-subtitle">
            The {name} encountered an error. The rest of the game should still work.
          </div>
          <pre class="bw-error-boundary-message">{error.message}</pre>
          <button
            class="bw-error-boundary-retry"
            type="button"
            onClick={() => {
              this.setState({ error: null })
            }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}

/**
 * Lightweight wrapper for catching panel errors.
 *
 * Use around any panel that could throw during render. The name helps identify
 * which panel failed in error reports.
 */
export function PanelBoundary(props: {
  readonly name: string
  readonly children: ComponentChildren
  readonly onError?: ((error: Error, name: string) => void) | undefined
}): JSX.Element {
  const errorProps: ErrorBoundaryProps =
    props.onError === undefined
      ? { name: props.name, children: props.children }
      : { name: props.name, children: props.children, onError: props.onError }

  return <ErrorBoundary {...errorProps}>{props.children}</ErrorBoundary>
}
