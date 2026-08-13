/**
 * Alerts panel (T6.3, PRD 6.5).
 *
 * The toast rail is the interruption; this is the record. It holds the history
 * the rail could not, and the two controls PRD 6.5 asks for:
 *
 *   - **Mute per category**, so a player fighting a fire can silence the fire
 *     without silencing the riot.
 *   - **Auto-pause on critical**, off unless asked for, because taking the
 *     clock away from someone who did not request it is worse than a missed
 *     death.
 *
 * Grouped notifications arrive already collapsed with a count — the collapsing
 * happens in the worker, where the tick is known. This renders the count.
 *
 * Presentational only.
 */

import type { JSX } from 'preact'

import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type AlertSeverity = 'info' | 'warn' | 'critical'

export interface AlertRowModel {
  readonly id: number
  readonly severity: AlertSeverity
  readonly category: string
  readonly categoryLabel: string
  readonly title: string
  readonly detail: string
  /** Collapsed duplicates. 1 renders nothing. */
  readonly count: number
  /** Non-zero where a Trace chain exists to open. */
  readonly traceId: number
  readonly timeLabel: string
}

export interface AlertCategoryModel {
  readonly id: string
  readonly label: string
  readonly muted: boolean
  /** Notifications in this category since the prison opened. */
  readonly total: number
}

export interface AlertsModel {
  readonly rows: readonly AlertRowModel[]
  readonly categories: readonly AlertCategoryModel[]
  readonly autoPauseOnCritical: boolean
  /** Filter, or null for everything. */
  readonly filter: AlertSeverity | null
}

export interface AlertsProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: AlertsModel | null
  readonly onClose: () => void
  readonly onFilter: (severity: AlertSeverity | null) => void
  readonly onMute?: (category: string, muted: boolean) => void
  readonly onAutoPause?: (enabled: boolean) => void
  readonly onOpenTrace?: (row: AlertRowModel) => void
}

const FILTERS: readonly { readonly id: AlertSeverity | null; readonly label: string }[] = [
  { id: null, label: 'All' },
  { id: 'critical', label: 'Critical' },
  { id: 'warn', label: 'Warnings' },
  { id: 'info', label: 'Info' },
]

/** `3` → `"×3"`; `1` → `""`, because a count of one is not a count. */
export function countLabel(count: number): string {
  return count > 1 ? `×${String(count)}` : ''
}

export function Alerts({
  model,
  onClose,
  onFilter,
  onMute,
  onAutoPause,
  onOpenTrace,
}: AlertsProps): JSX.Element {
  const open = model !== null
  const rows =
    model === null
      ? []
      : model.filter === null
        ? model.rows
        : model.rows.filter((row) => row.severity === model.filter)

  return (
    <div
      class="bw-alerts-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Alerts"
    >
      {model !== null && (
        <>
          <div class="bw-alerts-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Alerts</h2>
              <div class="sub">
                {rows.length} shown
                {model.categories.some((entry) => entry.muted)
                  ? ` · ${String(model.categories.filter((entry) => entry.muted).length)} muted`
                  : ''}
              </div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-alerts-filters" role="tablist" aria-label="Severity filter">
              {FILTERS.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  role="tab"
                  aria-selected={model.filter === entry.id}
                  data-on={model.filter === entry.id ? 'true' : 'false'}
                  onClick={() => onFilter(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-alerts-body">
            <ul class="bw-alerts-list">
              {rows.length === 0 && <li class="bw-alerts-empty">Nothing to report.</li>}
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    class="bw-alerts-row"
                    data-severity={row.severity}
                    disabled={row.traceId === 0}
                    aria-label={`${row.title}, ${row.severity}`}
                    onClick={() => onOpenTrace?.(row)}
                  >
                    <span class="ico">
                      <Icon name={row.severity === 'critical' ? 'warning' : 'alerts'} size={16} />
                    </span>
                    <span class="txt">
                      <b>
                        {row.title}
                        {row.count > 1 && <span class="count">{countLabel(row.count)}</span>}
                      </b>
                      <span class="detail">{row.detail}</span>
                    </span>
                    <span class="meta">{row.timeLabel}</span>
                  </button>
                </li>
              ))}
            </ul>

            <aside class="bw-alerts-side">
              <h4>Auto-pause</h4>
              <label class="bw-alerts-toggle">
                <input
                  type="checkbox"
                  checked={model.autoPauseOnCritical}
                  onChange={(event) =>
                    onAutoPause?.((event.currentTarget as HTMLInputElement).checked)
                  }
                />
                <span>Pause the game on a critical alert</span>
              </label>

              <h4>Mute a category</h4>
              <ul class="bw-alerts-categories">
                {model.categories.map((category) => (
                  <li key={category.id}>
                    <label class="bw-alerts-toggle">
                      <input
                        type="checkbox"
                        checked={category.muted}
                        aria-label={`Mute ${category.label}`}
                        onChange={(event) =>
                          onMute?.(category.id, (event.currentTarget as HTMLInputElement).checked)
                        }
                      />
                      <span>{category.label}</span>
                      <span class="bw-alerts-total">{category.total}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
