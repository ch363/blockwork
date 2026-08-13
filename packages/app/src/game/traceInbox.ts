/**
 * The notification inbox behind the Trace panel (PRD 3.1, PRD 6.5).
 *
 * Notifications cross the worker boundary as numbers — an id, a severity, a
 * `traceId` — because the snapshot buffer is fixed-width and carries no text.
 * The words come from the chain itself, which means a toast is not something
 * this thread can render on arrival: it has to ask.
 *
 * That asking is all this class does. It is separated from `Session` because
 * `Session` cannot be constructed without a WebGL context, and the rules here
 * — one request per notification, the rail is capped, a chain is pinned for
 * exactly as long as its toast is on screen — are rules worth a test.
 */

import type { NotificationSeverity, SnapshotNotification, Tile } from '@blockwork/sim'
import { NOTIFICATION_SEVERITY } from '@blockwork/sim'
import type { ToastModel, ToastSeverity, TraceModel, TraceNodeModel } from '@blockwork/ui'
import { traceModelFromView } from '@blockwork/ui'

import type { TraceResult } from '../worker/simWorker'

/** PRD 6.5: the rail holds a handful; the alerts panel holds the history. */
export const MAX_TOASTS = 4

/** The half of `SimBridge` this needs, so a test does not need a worker. */
export interface TracePort {
  trace(traceId: number, notificationId: number): Promise<TraceResult | null>
  releaseTrace(notificationId: number): void
}

export interface TraceInboxHandlers {
  /** Called whenever the visible toast list changes. */
  readonly onToasts: (toasts: readonly ToastModel[]) => void
  /** Called with the panel's model, or null when it closes. */
  readonly onTrace: (trace: TraceModel | null) => void
}

export function severityLabel(severity: NotificationSeverity): ToastSeverity {
  if (severity === NOTIFICATION_SEVERITY.CRITICAL) return 'critical'
  if (severity === NOTIFICATION_SEVERITY.WARN) return 'warn'
  return 'info'
}

export class TraceInbox {
  readonly #port: TracePort
  readonly #handlers: TraceInboxHandlers
  /** Notification id → its resolved chain, held while the toast is on screen. */
  readonly #chains = new Map<number, TraceResult>()
  /** Notifications already asked about, so a re-read never double-requests. */
  readonly #requested = new Set<number>()
  #toasts: readonly ToastModel[] = []
  #open: TraceResult | null = null

  constructor(port: TracePort, handlers: TraceInboxHandlers) {
    this.#port = port
    this.#handlers = handlers
  }

  get toasts(): readonly ToastModel[] {
    return this.#toasts
  }

  /**
   * Takes a batch of notifications and raises a toast for each.
   *
   * Returns the in-flight requests so a test can await them; the frame loop
   * ignores the result, because a toast that lands next frame is still a toast
   * that landed.
   */
  receive(notifications: readonly SnapshotNotification[]): Promise<void> {
    const pending: Promise<void>[] = []

    for (const notification of notifications) {
      // PRD 6.5: warn and above always carry a chain. One without is a kind
      // that should never have been promoted, and there is nothing to open.
      if (notification.traceId <= 0) continue
      if (this.#requested.has(notification.id)) continue
      this.#requested.add(notification.id)

      pending.push(
        this.#port
          .trace(notification.traceId, notification.id)
          .then((result) => {
            if (result === null) {
              this.#requested.delete(notification.id)
              return
            }
            this.#chains.set(notification.id, result)
            this.#push({
              id: notification.id,
              severity: severityLabel(notification.severity),
              title: result.nodes[0]?.title ?? 'Something went wrong',
              detail: result.nodes[0]?.detail ?? '',
              count: notification.count,
              traceId: notification.traceId,
            })
          })
          .catch(() => {
            // A disposed bridge rejects whatever was in flight.
            this.#requested.delete(notification.id)
          }),
      )
    }

    return Promise.all(pending).then(() => undefined)
  }

  /** Opens the Trace for a toast. A chain that has aged out opens nothing. */
  async open(toast: ToastModel): Promise<void> {
    const cached = this.#chains.get(toast.id)
    if (cached !== undefined) {
      this.#show(cached)
      return
    }

    const result = await this.#port.trace(toast.traceId, toast.id).catch(() => null)
    if (result === null) return
    this.#chains.set(toast.id, result)
    this.#show(result)
  }

  close(): void {
    this.#open = null
    this.#handlers.onTrace(null)
  }

  /**
   * The tile a node's subject sits on, or null when it is not on the map.
   *
   * PRD 3.1 wants every node tappable to jump the camera there, but a node
   * about a policy or the whole prison has nowhere to jump to.
   */
  focusOf(node: TraceNodeModel): Tile | null {
    return this.#open?.nodes.find((entry) => entry.eventId === node.eventId)?.focus ?? null
  }

  /** Dismisses a toast, closing its Trace and releasing its pin. */
  dismiss(toast: ToastModel): void {
    this.#toasts = this.#toasts.filter((entry) => entry.id !== toast.id)
    this.#handlers.onToasts(this.#toasts)
    if (this.#open?.rootId === toast.traceId) this.close()
    this.#release(toast.id)
  }

  #show(result: TraceResult): void {
    this.#open = result
    this.#handlers.onTrace(traceModelFromView(result, result.subtitle))
  }

  /** Newest first. Anything pushed off the end gives its pin back. */
  #push(toast: ToastModel): void {
    const next = [toast, ...this.#toasts]
    for (const evicted of next.slice(MAX_TOASTS)) this.#release(evicted.id)
    this.#toasts = next.slice(0, MAX_TOASTS)
    this.#handlers.onToasts(this.#toasts)
  }

  #release(notificationId: number): void {
    if (!this.#chains.delete(notificationId)) return
    this.#requested.delete(notificationId)
    this.#port.releaseTrace(notificationId)
  }
}
