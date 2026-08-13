/**
 * The Trace panel (PRD 3.1, T3.1).
 *
 * Opened from any warn or critical notification that carries a `traceId`.
 * Renders the causal chain as a vertical timeline: each node pans the camera
 * to its subject, and suggested fixes sit as buttons under the chain.
 *
 * The panel owns no simulation state. The host hands it a resolved
 * {@link TraceModel} (already stringified by `buildTrace`) and receives
 * focus / fix / dismiss gestures as callbacks.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export interface TraceFixModel {
  readonly id: string
  readonly label: string
}

export interface TraceNodeModel {
  readonly eventId: number
  readonly subjectId: number
  readonly title: string
  readonly detail: string
  readonly meta: string
  readonly isRootCause: boolean
  readonly isFirst: boolean
}

export interface TraceModel {
  readonly rootId: number
  /** Headline under "Why did this happen?" — the root event's title. */
  readonly headline: string
  /** Day / time line under the headline. */
  readonly subtitle: string
  readonly nodes: readonly TraceNodeModel[]
  readonly fixes: readonly TraceFixModel[]
  readonly reportText: string
}

export interface TraceProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: TraceModel | null
  readonly onClose: () => void
  /** Pan the camera to the node's subject. */
  readonly onNodeFocus: (node: TraceNodeModel) => void
  readonly onFix: (fix: TraceFixModel) => void
  readonly onCopyReport?: (reportText: string) => void
}

export function Trace({
  model,
  onClose,
  onNodeFocus,
  onFix,
  onCopyReport,
}: TraceProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  return (
    <div
      ref={trapRef}
      class="bw-trace-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Trace"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-trace-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Why did this happen?</h2>
              <div class="sub">
                {model.headline} · {model.subtitle}
              </div>
            </div>
            <div class="bw-spacer" />
            <Button
              variant="ghost"
              onClick={() => {
                onCopyReport?.(model.reportText)
              }}
              ariaLabel="Copy report"
            >
              Copy report
            </Button>
          </div>

          <div class="bw-trace-body">
            <div class="bw-trace">
              {model.nodes.map((node) => (
                <button
                  key={node.eventId}
                  type="button"
                  class={`bw-tnode${node.isFirst ? ' first' : ''}${node.isRootCause ? ' root' : ''}`}
                  onClick={() => {
                    onNodeFocus(node)
                  }}
                  aria-label={`Show ${node.title}`}
                >
                  <div class="rail" aria-hidden="true">
                    <div class="knob">{node.isFirst ? '!' : '↑'}</div>
                    <div class="line" />
                  </div>
                  <div class={`tcard${node.isRootCause ? ' danger' : ''}`}>
                    <div class="th">{node.title}</div>
                    <div class="tm">{node.detail}</div>
                    <div class="tt">{node.meta}</div>
                  </div>
                </button>
              ))}
            </div>

            {model.fixes.length > 0 && (
              <div class="bw-fixes">
                {model.fixes.map((fix, index) => (
                  <Button
                    key={fix.id}
                    variant={index === 0 ? 'primary' : 'default'}
                    onClick={() => {
                      onFix(fix)
                    }}
                  >
                    {fix.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Maps a sim `TraceView` into the props model the panel renders. */
export function traceModelFromView(
  view: {
    readonly rootId: number
    readonly nodes: readonly {
      readonly eventId: number
      readonly subjectId: number
      readonly title: string
      readonly detail: string
      readonly meta: string
      readonly isRootCause: boolean
      readonly tick: number
    }[]
    readonly fixes: readonly { readonly id: string; readonly label: string }[]
    readonly reportText: string
  },
  subtitle: string,
): TraceModel {
  const root = view.nodes[0]
  return {
    rootId: view.rootId,
    headline: root?.title ?? 'Unknown event',
    subtitle,
    nodes: view.nodes.map((node, index) => ({
      eventId: node.eventId,
      subjectId: node.subjectId,
      title: node.title,
      detail: node.detail,
      meta: node.meta,
      isRootCause: node.isRootCause,
      isFirst: index === 0,
    })),
    fixes: view.fixes.map((fix) => ({ id: fix.id, label: fix.label })),
    reportText: view.reportText,
  }
}
