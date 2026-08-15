/**
 * The tool dock (PRD 6.1, mockup screens 1 and 2).
 *
 * Ten destinations along the bottom edge, one of which is selected at a time.
 * Selecting one opens the secondary tray above it with that tool's palette.
 *
 * The dock is deliberately a dumb list over a `DOCK_TOOLS` table rather than
 * ten hand-written buttons: the tools that exist grow ticket by ticket, and a
 * table means adding Utilities in Phase 4 is a row, not a layout edit. Tools
 * whose systems do not exist yet are rendered `disabled` rather than hidden,
 * because a dock that changes shape as the game unlocks things is a dock the
 * player has to re-learn.
 */

import type { JSX } from 'preact'

import { Icon } from '../icons'
import type { IconName } from '../icons'

export const DOCK_TOOL_IDS = [
  'build',
  'rooms',
  'objects',
  'utilities',
  'staff',
  'posts',
  'flow',
  'plan',
  'reports',
  'overlay',
  'emergency',
] as const

export type DockToolId = (typeof DOCK_TOOL_IDS)[number]

export interface DockTool {
  readonly id: DockToolId
  readonly label: string
  readonly icon: IconName
  /** Pushed to the right of the spacer, away from the build tools. */
  readonly trailing?: boolean
  readonly danger?: boolean
}

export const DOCK_TOOLS: readonly DockTool[] = [
  { id: 'build', label: 'Build', icon: 'build' },
  { id: 'rooms', label: 'Rooms', icon: 'rooms' },
  { id: 'objects', label: 'Objects', icon: 'objects' },
  { id: 'utilities', label: 'Utilities', icon: 'utilities' },
  { id: 'staff', label: 'Staff', icon: 'staff' },
  { id: 'posts', label: 'Posts', icon: 'posts' },
  { id: 'flow', label: 'Flow', icon: 'flow' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
  { id: 'overlay', label: 'Overlay', icon: 'overlay', trailing: true },
  { id: 'emergency', label: 'Emergency', icon: 'emergency', trailing: true, danger: true },
]

export interface ToolDockProps {
  /** The open tool, or null when the world is in select mode. */
  readonly active: DockToolId | null
  /** Tapping the open tool closes it; that is the host's call, not the dock's. */
  readonly onSelect: (tool: DockToolId) => void
  /** Tools with no system behind them yet. */
  readonly disabled?: readonly DockToolId[]
}

export function ToolDock({ active, onSelect, disabled = [] }: ToolDockProps): JSX.Element {
  const leading = DOCK_TOOLS.filter((tool) => tool.trailing !== true)
  const trailing = DOCK_TOOLS.filter((tool) => tool.trailing === true)

  const button = (tool: DockTool): JSX.Element => {
    const off = disabled.includes(tool.id)
    return (
      <button
        key={tool.id}
        type="button"
        class={tool.danger === true ? 'bw-tool danger' : 'bw-tool'}
        data-tool={tool.id}
        data-on={active === tool.id}
        aria-pressed={active === tool.id}
        aria-label={off ? `${tool.label}, not available yet` : tool.label}
        disabled={off}
        title={off ? `${tool.label} — not built yet` : tool.label}
        onClick={() => {
          onSelect(tool.id)
        }}
      >
        <Icon name={tool.icon} size={22} />
        <span class="lb">{tool.label}</span>
      </button>
    )
  }

  return (
    <nav class="bw-dock" aria-label="Tools">
      {leading.map(button)}
      <div class="bw-spacer" />
      {trailing.map(button)}
    </nav>
  )
}
