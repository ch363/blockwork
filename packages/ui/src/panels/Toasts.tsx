/**
 * Notification toasts (PRD 6.5).
 *
 * Three severities. `info` is log-only and never reaches this component;
 * `warn` and `critical` surface here, and both carry a `traceId` that makes
 * the toast tappable through to the Trace panel. That routing is the host's
 * (T3.1); the affordance ships with every toast that has a real tip.
 *
 * Grouping is the caller's job too: "identical notifications within 60 in-game
 * minutes collapse into one with a count", and only the notification queue
 * knows what identical means. This renders whatever count it is handed.
 */

import type { JSX } from 'preact'

import { Icon } from '../icons'
import type { IconName } from '../icons'

export type ToastSeverity = 'info' | 'warn' | 'critical'

export interface ToastModel {
  readonly id: number
  readonly severity: ToastSeverity
  readonly title: string
  readonly detail: string
  /** Collapsed duplicates. 1 shows nothing. */
  readonly count: number
  /** Non-zero where a Trace chain exists to open (PRD 3.1). */
  readonly traceId: number
}

export interface ToastsProps {
  readonly toasts: readonly ToastModel[]
  readonly onTrace: (toast: ToastModel) => void
  readonly onDismiss: (toast: ToastModel) => void
}

const ICONS: Readonly<Record<ToastSeverity, IconName>> = {
  info: 'alerts',
  warn: 'utilities',
  critical: 'warning',
}

function toastClass(severity: ToastSeverity): string {
  return severity === 'critical' ? 'bw-toast crit' : `bw-toast ${severity}`
}

export function Toasts({ toasts, onTrace, onDismiss }: ToastsProps): JSX.Element | null {
  if (toasts.length === 0) return null

  return (
    <div class="bw-toasts" role="log" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={toastClass(toast.severity)}>
          <div class="ico">
            <Icon name={ICONS[toast.severity]} size={18} />
          </div>
          <div class="txt">
            <b>{toast.title}</b>
            <span>{toast.detail}</span>
          </div>
          {toast.count > 1 && <span class="count">&times;{toast.count}</span>}
          {toast.traceId > 0 && (
            <button
              type="button"
              class="bw-btn"
              onClick={() => {
                onTrace(toast)
              }}
              aria-label={`Show cause: ${toast.title}`}
            >
              Show cause
            </button>
          )}
          <button
            type="button"
            class="bw-iconbtn"
            onClick={() => {
              onDismiss(toast)
            }}
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
