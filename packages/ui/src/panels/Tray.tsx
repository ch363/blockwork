/**
 * The secondary tray: the open tool's palette (PRD 6.1, mockup screen 2).
 *
 * "Selecting a tool expands a secondary tray above the dock with that tool's
 * palette, scrollable horizontally." Every palette in the game has the same
 * shape — grouped chips with a name and a one-line qualifier — so there is one
 * component rather than one per tool, and a tool contributes groups rather
 * than markup.
 *
 * The tray slides rather than appearing, and stays mounted while closed, so
 * the horizontal scroll position survives closing and reopening a palette.
 * A player who has scrolled to Production and taps away to check a room does
 * not want to scroll back.
 */

import type { JSX } from 'preact'

import { Icon } from '../icons'
import type { IconName } from '../icons'

export interface TrayItem {
  readonly id: string
  readonly name: string
  /** The qualifier under the name: "2x3 min", "needs water", "locked". */
  readonly note?: string
  readonly icon: IconName
  /** Not yet unlocked by the Directorate (PRD 5.8). */
  readonly locked?: boolean
}

export interface TrayGroup {
  readonly id: string
  /** Rotated label down the group's left edge. */
  readonly label: string
  readonly items: readonly TrayItem[]
}

export interface TrayProps {
  readonly groups: readonly TrayGroup[]
  readonly selected: string | null
  readonly onSelect: (itemId: string) => void
  readonly open: boolean
  /** Shortens the tray so it does not run under an open inspector. */
  readonly inspectorOpen?: boolean
}

export function Tray({
  groups,
  selected,
  onSelect,
  open,
  inspectorOpen = false,
}: TrayProps): JSX.Element {
  return (
    <div
      class="bw-tray"
      data-open={open}
      data-inspector={inspectorOpen}
      role="group"
      aria-label="Palette"
      aria-hidden={!open}
    >
      {groups.map((group) => (
        <div key={group.id} class="bw-tray-group">
          <span class="bw-tray-group-label">{group.label}</span>
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              class="bw-chip"
              data-on={selected === item.id}
              aria-pressed={selected === item.id}
              disabled={item.locked === true}
              // The chip's text is split across three spans with the note in a
              // faint colour, which reads as one label but does not compute as
              // an accessible name.
              aria-label={item.note === undefined ? item.name : `${item.name}, ${item.note}`}
              // Not reachable by tab while the tray is shut, or the focus ring
              // lands on something nobody can see.
              tabIndex={open ? 0 : -1}
              onClick={() => {
                onSelect(item.id)
              }}
            >
              <span class="g">
                <Icon name={item.icon} size={20} />
              </span>
              <span class="n">{item.name}</span>
              {item.note !== undefined && <span class="c">{item.note}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
