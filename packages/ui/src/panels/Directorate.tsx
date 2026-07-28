/**
 * The Directorate panel (T5.1, PRD 5.8, mockup screen 7).
 *
 * A node graph, not a nested list. The reference game's research screen is a
 * tree of disclosure triangles, which hides the one thing the player actually
 * wants to see — how far away a capability is, and what stands between here
 * and there. Laying the branches out in space and drawing the prerequisite
 * edges makes that a glance instead of six taps.
 *
 * Two things carry the weight:
 *
 * **The detail sheet leads with "why you want this."** A node that says
 * "unlocks the Intelligence panel" tells a player who already knows the game
 * what it does. The `why` copy names the problem the node solves, and the host
 * is expected to fill it with the prison's own numbers where it can.
 *
 * **A locked node still shows its blocker.** Greying a node out and saying
 * nothing is how a player ends up believing the tree is broken. Every
 * unavailable node carries the sentence that would make it available.
 *
 * Presentational only. The host resolves simulation state into a
 * {@link DirectorateModel}, positions the nodes, and turns gestures back into
 * commands. Zoom and pan are view state and live here.
 */

import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'

import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type DirectorateBranchId = 'root' | 'security' | 'legal' | 'works' | 'finance'

export type DirectorateNodeStatus = 'complete' | 'active' | 'available' | 'locked'

/** Why an unavailable node cannot be started, in the player's words. */
export interface DirectorateBlocker {
  readonly kind:
    | 'prerequisite'
    | 'branch'
    | 'administrator'
    | 'office'
    | 'funds'
  readonly sentence: string
}

export interface DirectorateNodeModel {
  readonly id: string
  readonly name: string
  readonly branch: DirectorateBranchId
  readonly status: DirectorateNodeStatus
  readonly cost: number
  readonly durationHours: number
  /** Graph position in layout units. The host lays the tree out. */
  readonly x: number
  readonly y: number
  /** Ids this node depends on; drawn as edges into this node. */
  readonly prerequisites: readonly string[]
  /** 0..1 while `active`; ignored otherwise. */
  readonly progress: number
  /** Remaining time while `active`, already formatted (e.g. "4h 10m"). */
  readonly remainingLabel: string | null
  /** Set while `active` and stalled — the panel says so on the node itself. */
  readonly pausedReason: string | null
  readonly summary: string
  /** PRD 5.8's "why do I want this" copy. */
  readonly why: string
  readonly unlocks: readonly string[]
  /** Administrator display name, e.g. "Security Director". */
  readonly administrator: string
  readonly administratorReady: boolean
  /** Empty when the node can be started. */
  readonly blockers: readonly DirectorateBlocker[]
}

export interface DirectorateModel {
  readonly nodes: readonly DirectorateNodeModel[]
  readonly completeCount: number
  readonly totalCount: number
  readonly activeCount: number
  readonly balance: number
  /** Node the detail sheet is showing, or null. */
  readonly selectedId: string | null
}

export interface DirectorateProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: DirectorateModel | null
  readonly branch: DirectorateBranchId | 'all'
  readonly onBranch: (branch: DirectorateBranchId | 'all') => void
  readonly onSelect: (nodeId: string | null) => void
  readonly onClose: () => void
  readonly onStart?: (nodeId: string) => void
}

const BRANCHES: readonly { readonly id: DirectorateBranchId | 'all'; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'security', label: 'Security' },
  { id: 'legal', label: 'Legal' },
  { id: 'works', label: 'Works' },
  { id: 'finance', label: 'Finance' },
]

/** Pinch / wheel zoom bounds (PRD 5.8 asks for a zoomable graph). */
export const DIRECTORATE_MIN_ZOOM = 0.5
export const DIRECTORATE_MAX_ZOOM = 2

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  if (zoom < DIRECTORATE_MIN_ZOOM) return DIRECTORATE_MIN_ZOOM
  if (zoom > DIRECTORATE_MAX_ZOOM) return DIRECTORATE_MAX_ZOOM
  return zoom
}

/** Node width in layout units. Edges anchor to the node's mid-right / mid-left. */
export const DIRECTORATE_NODE_WIDTH = 168
export const DIRECTORATE_NODE_HEIGHT = 56

/**
 * The cubic that joins two nodes, in layout units.
 *
 * Exported because the edge shape is the graph's readability: a straight line
 * between staggered rows crosses its neighbours, and a right-angle elbow makes
 * the tree look like a circuit diagram. The horizontal-tangent cubic keeps
 * parallel siblings visually parallel.
 */
export function edgePath(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): string {
  const x1 = from.x + DIRECTORATE_NODE_WIDTH
  const y1 = from.y + DIRECTORATE_NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + DIRECTORATE_NODE_HEIGHT / 2
  const mid = x1 + (x2 - x1) / 2
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`
}

export function formatDurationHours(hours: number): string {
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`
}

export function formatCost(amount: number): string {
  return `$${amount.toLocaleString('en-GB')}`
}

export function Directorate({
  model,
  branch,
  onBranch,
  onSelect,
  onClose,
  onStart,
}: DirectorateProps): JSX.Element {
  const open = model !== null
  const [zoom, setZoom] = useState(1)
  const pinch = useRef<{ readonly distance: number; readonly zoom: number } | null>(null)

  const visible = useMemo(() => {
    if (model === null) return []
    if (branch === 'all') return model.nodes
    // Root nodes stay on screen when a branch is filtered: the branch's own
    // root is what unlocked it, and hiding it hides the answer to "why is this
    // whole column locked".
    return model.nodes.filter((node) => node.branch === branch || node.branch === 'root')
  }, [model, branch])

  const byId = useMemo(() => {
    const map = new Map<string, DirectorateNodeModel>()
    for (const node of visible) map.set(node.id, node)
    return map
  }, [visible])

  const selected =
    model === null || model.selectedId === null
      ? null
      : (model.nodes.find((node) => node.id === model.selectedId) ?? null)

  const onWheel = useCallback((event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setZoom((current) => clampZoom(current * (event.deltaY > 0 ? 0.92 : 1.08)))
  }, [])

  const onTouchStart = useCallback((event: JSX.TargetedTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2) return
    const distance = touchDistance(event)
    if (distance === null) return
    pinch.current = { distance, zoom }
  }, [zoom])

  const onTouchMove = useCallback((event: JSX.TargetedTouchEvent<HTMLDivElement>) => {
    const start = pinch.current
    if (start === null || event.touches.length !== 2) return
    const distance = touchDistance(event)
    if (distance === null || start.distance <= 0) return
    setZoom(clampZoom((start.zoom * distance) / start.distance))
  }, [])

  const onTouchEnd = useCallback(() => {
    pinch.current = null
  }, [])

  const extent = useMemo(() => graphExtent(visible), [visible])

  return (
    <div
      class="bw-directorate-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Directorate"
    >
      {model !== null && (
        <>
          <div class="bw-directorate-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Directorate</h2>
              <div class="sub">
                {model.completeCount} of {model.totalCount} complete
                {model.activeCount > 0 ? ` · ${model.activeCount} in progress` : ''}
              </div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-directorate-branches" role="tablist" aria-label="Branch">
              {BRANCHES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={branch === entry.id}
                  data-on={branch === entry.id ? 'true' : 'false'}
                  onClick={() => onBranch(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-directorate-body">
            <div
              class="bw-directorate-graph"
              onWheel={onWheel}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              data-zoom={zoom.toFixed(2)}
            >
              <div
                class="bw-directorate-canvas"
                style={{
                  transform: `scale(${zoom})`,
                  width: `${extent.width}px`,
                  height: `${extent.height}px`,
                }}
              >
                <svg
                  class="bw-directorate-edges"
                  viewBox={`0 0 ${extent.width} ${extent.height}`}
                  width={extent.width}
                  height={extent.height}
                  aria-hidden="true"
                >
                  {visible.flatMap((node) =>
                    node.prerequisites.flatMap((id) => {
                      const from = byId.get(id)
                      if (from === undefined) return []
                      return [
                        <path
                          key={`${id}->${node.id}`}
                          d={edgePath(from, node)}
                          class="edge"
                          data-active={node.status === 'active' ? 'true' : 'false'}
                        />,
                      ]
                    }),
                  )}
                </svg>

                {visible.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    class="bw-directorate-node"
                    data-status={node.status}
                    data-selected={node.id === model.selectedId ? 'true' : 'false'}
                    style={{ left: `${node.x}px`, top: `${node.y}px` }}
                    aria-label={`${node.name}, ${node.status}`}
                    onClick={() => onSelect(node.id)}
                  >
                    {node.status === 'complete' && <span class="tick" aria-hidden="true">✓</span>}
                    <span class="nt">{node.name}</span>
                    <span class="nc">
                      {node.status === 'active' && node.remainingLabel !== null
                        ? `${formatCost(node.cost)} · ${node.remainingLabel} left`
                        : `${formatCost(node.cost)} · ${formatDurationHours(node.durationHours)}`}
                    </span>
                    {node.status === 'active' && (
                      <span class="np">
                        <i style={{ width: `${Math.round(node.progress * 100)}%` }} />
                      </span>
                    )}
                    {node.pausedReason !== null && (
                      <span class="paused">{node.pausedReason}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <aside class="bw-directorate-detail">
              {selected === null ? (
                <p class="bw-directorate-empty">
                  Select a node to see what it costs, what it unlocks, and why you would want it.
                </p>
              ) : (
                <NodeDetail
                  node={selected}
                  balance={model.balance}
                  {...(onStart === undefined ? {} : { onStart })}
                />
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

function NodeDetail({
  node,
  balance,
  onStart,
}: {
  readonly node: DirectorateNodeModel
  readonly balance: number
  readonly onStart?: (nodeId: string) => void
}): JSX.Element {
  return (
    <div class="bw-directorate-card">
      <header>
        <h3>{node.name}</h3>
        <span class="bw-pill" data-status={node.status}>
          {statusLabel(node.status)}
        </span>
      </header>

      {node.status === 'active' && (
        <div class="bw-directorate-progress">
          <div class="track">
            <i style={{ width: `${Math.round(node.progress * 100)}%` }} />
          </div>
          <div class="row">
            <span>{Math.round(node.progress * 100)}% complete</span>
            <span>{node.remainingLabel ?? '—'} remaining</span>
          </div>
          {node.pausedReason !== null && (
            <p class="bw-directorate-paused">{node.pausedReason}</p>
          )}
        </div>
      )}

      <section>
        <h4>Why you want this</h4>
        <p class="why">{node.why}</p>
      </section>

      <section>
        <h4>Unlocks</h4>
        {node.unlocks.length === 0 ? (
          <p class="why">{node.summary}</p>
        ) : (
          <div class="bw-directorate-pills">
            {node.unlocks.map((label) => (
              <span key={label} class="bw-pill">
                {label}
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4>Requires</h4>
        <div class="bw-directorate-kv">
          <span class="k">{node.administrator}</span>
          <span class="v" data-ok={node.administratorReady ? 'true' : 'false'}>
            {node.administratorReady ? 'In post · office OK' : 'Not available'}
          </span>
        </div>
        <div class="bw-directorate-kv">
          <span class="k">Cost</span>
          <span class="v" data-ok={balance >= node.cost ? 'true' : 'false'}>
            {formatCost(node.cost)} · {formatDurationHours(node.durationHours)}
          </span>
        </div>
      </section>

      {node.blockers.length > 0 && (
        <ul class="bw-directorate-blockers">
          {node.blockers.map((blocker) => (
            <li key={`${blocker.kind}:${blocker.sentence}`}>{blocker.sentence}</li>
          ))}
        </ul>
      )}

      {node.status === 'available' && (
        <Button
          variant="primary"
          disabled={node.blockers.length > 0}
          onClick={() => onStart?.(node.id)}
        >
          Begin research · {formatCost(node.cost)}
        </Button>
      )}
    </div>
  )
}

function statusLabel(status: DirectorateNodeStatus): string {
  switch (status) {
    case 'complete':
      return 'Complete'
    case 'active':
      return 'In progress'
    case 'available':
      return 'Available'
    case 'locked':
      return 'Locked'
  }
}

function graphExtent(nodes: readonly DirectorateNodeModel[]): {
  readonly width: number
  readonly height: number
} {
  let width = 0
  let height = 0
  for (const node of nodes) {
    width = Math.max(width, node.x + DIRECTORATE_NODE_WIDTH)
    height = Math.max(height, node.y + DIRECTORATE_NODE_HEIGHT)
  }
  // A little slack so the last node is not flush against the scroll edge.
  return { width: width + 32, height: height + 32 }
}

function touchDistance(event: JSX.TargetedTouchEvent<HTMLDivElement>): number | null {
  const a = event.touches[0]
  const b = event.touches[1]
  if (a === undefined || b === undefined) return null
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}
