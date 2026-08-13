/**
 * Pause menu (T8.6, PRD 3.10).
 *
 * The menu that opens when the player taps the hamburger: Resume, Save, Load
 * (listing the store's descriptors), Export, Import, Settings, New Prison, Quit.
 *
 * Presentational only — all save/load operations are callbacks.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

/** Summary of a save slot, as returned by SaveStore.list(). */
export interface SaveSlotModel {
  readonly key: string
  readonly name: string
  readonly savedAt: string
  readonly playedTicks: number
  readonly mapSize: number
}

export interface PauseMenuModel {
  readonly saves: readonly SaveSlotModel[]
  readonly canSave: boolean
  readonly canExport: boolean
}

export interface PauseMenuProps {
  /** Null closes the panel. */
  readonly model: PauseMenuModel | null
  readonly onClose: () => void
  readonly onResume: () => void
  readonly onSave?: () => void
  readonly onLoad?: (key: string) => void
  readonly onExport?: () => void
  readonly onImport?: () => void
  readonly onSettings?: () => void
  readonly onNewPrison?: () => void
  readonly onQuit?: () => void
}

function formatPlayedTime(ticks: number): string {
  const totalMinutes = Math.floor(ticks / 10)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m`
  }
  return `${String(minutes)}m`
}

function formatSavedAt(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    if (diffDays === 1) {
      return 'Yesterday'
    }
    if (diffDays < 7) {
      return `${String(diffDays)} days ago`
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return isoString
  }
}

export function PauseMenu({
  model,
  onClose,
  onResume,
  onSave,
  onLoad,
  onExport,
  onImport,
  onSettings,
  onNewPrison,
  onQuit,
}: PauseMenuProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  return (
    <div
      ref={trapRef}
      class="bw-pause-menu"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Pause menu"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-pause-head">
            <IconButton ariaLabel="Close menu" onClick={onClose}>
              <Icon name="close" size={16} />
            </IconButton>
            <h2>Paused</h2>
            <div class="bw-spacer" />
          </div>

          <div class="bw-pause-body">
            <section class="bw-pause-actions">
              <button type="button" class="bw-pause-action primary" onClick={onResume}>
                <Icon name="play" size={20} />
                <span>Resume</span>
              </button>

              <button
                type="button"
                class="bw-pause-action"
                onClick={onSave}
                disabled={!model.canSave}
              >
                <Icon name="save" size={20} />
                <span>Save</span>
              </button>

              <div class="bw-pause-row">
                <button type="button" class="bw-pause-action" onClick={onExport}>
                  <Icon name="export" size={20} />
                  <span>Export</span>
                </button>

                <button type="button" class="bw-pause-action" onClick={onImport}>
                  <Icon name="import" size={20} />
                  <span>Import</span>
                </button>
              </div>
            </section>

            {model.saves.length > 0 && (
              <section class="bw-pause-saves">
                <h3>Load</h3>
                <ul>
                  {model.saves.map((slot) => (
                    <li key={slot.key}>
                      <button type="button" onClick={() => onLoad?.(slot.key)}>
                        <span class="name">{slot.name}</span>
                        <span class="meta">
                          {formatSavedAt(slot.savedAt)} · {formatPlayedTime(slot.playedTicks)} ·{' '}
                          {String(slot.mapSize)}×{String(slot.mapSize)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section class="bw-pause-nav">
              <button type="button" class="bw-pause-nav-item" onClick={onSettings}>
                <Icon name="settings" size={18} />
                <span>Settings</span>
              </button>

              <button type="button" class="bw-pause-nav-item" onClick={onNewPrison}>
                <Icon name="plus" size={18} />
                <span>New Prison</span>
              </button>

              <button type="button" class="bw-pause-nav-item danger" onClick={onQuit}>
                <Icon name="exit" size={18} />
                <span>Quit</span>
              </button>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
