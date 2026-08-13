/**
 * Settings (T6.5, PRD 3.10 / 7.9).
 *
 * Preferences, not prison configuration: everything here follows the player
 * between saves and none of it changes what the simulation does. The panel is
 * split accordingly — audio, accessibility, autosave — with the accessibility
 * group carrying the four requirements PRD 7.9 is explicit about: a
 * colour-blind palette, Reduce Motion, dynamic type to 130%, and a no-failure
 * preference for new prisons.
 *
 * Presentational only.
 */

import type { JSX } from 'preact'

import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type SettingsTab = 'audio' | 'accessibility' | 'game'

export type ColourBlindPalette = 'default' | 'deuteranopia' | 'protanopia' | 'tritanopia'

export interface SettingsModel {
  readonly music: number
  readonly sfx: number
  readonly muted: boolean
  readonly palette: ColourBlindPalette
  readonly paletteOptions: readonly { readonly id: ColourBlindPalette; readonly label: string }[]
  readonly reduceMotion: boolean
  /** 1.0 to 1.3. */
  readonly typeScale: number
  readonly preferNoFailure: boolean
  readonly autosaveHours: number
  readonly autosaveOptions: readonly number[]
}

export interface SettingsProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: SettingsModel | null
  readonly tab: SettingsTab
  readonly onTab: (tab: SettingsTab) => void
  readonly onClose: () => void
  readonly onVolume?: (channel: 'music' | 'sfx', value: number) => void
  readonly onMute?: (muted: boolean) => void
  readonly onPalette?: (palette: ColourBlindPalette) => void
  readonly onReduceMotion?: (enabled: boolean) => void
  readonly onTypeScale?: (scale: number) => void
  readonly onPreferNoFailure?: (enabled: boolean) => void
  readonly onAutosaveHours?: (hours: number) => void
}

const TABS: readonly { readonly id: SettingsTab; readonly label: string }[] = [
  { id: 'audio', label: 'Audio' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'game', label: 'Game' },
]

/** `0.62` → `"62%"`. */
export function percentLabel(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/** `1.15` → `"115%"`, the scale as the player reads it. */
export function typeScaleLabel(scale: number): string {
  return `${String(Math.round(scale * 100))}%`
}

export function Settings({
  model,
  tab,
  onTab,
  onClose,
  onVolume,
  onMute,
  onPalette,
  onReduceMotion,
  onTypeScale,
  onPreferNoFailure,
  onAutosaveHours,
}: SettingsProps): JSX.Element {
  const open = model !== null

  return (
    <div
      class="bw-settings-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Settings"
    >
      {model !== null && (
        <>
          <div class="bw-settings-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Settings</h2>
              <div class="sub">These follow you between prisons.</div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-settings-tabs" role="tablist" aria-label="Settings section">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  data-on={tab === entry.id ? 'true' : 'false'}
                  onClick={() => onTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-settings-body">
            {tab === 'audio' && (
              <section>
                <label class="bw-settings-toggle">
                  <input
                    type="checkbox"
                    checked={model.muted}
                    aria-label="Mute everything"
                    onChange={(event) =>
                      onMute?.((event.currentTarget as HTMLInputElement).checked)
                    }
                  />
                  <span>Mute everything</span>
                </label>

                <Slider
                  label="Music"
                  value={model.music}
                  disabled={model.muted}
                  onChange={(value) => onVolume?.('music', value)}
                />
                <Slider
                  label="Effects"
                  value={model.sfx}
                  disabled={model.muted}
                  onChange={(value) => onVolume?.('sfx', value)}
                />
              </section>
            )}

            {tab === 'accessibility' && (
              <section>
                <h4>Colour-blind palette</h4>
                <p class="bw-settings-hint">
                  Every overlay pairs its colour with a shape or a value, so none of them rely on
                  hue alone.
                </p>
                <div
                  class="bw-settings-choices"
                  role="radiogroup"
                  aria-label="Colour-blind palette"
                >
                  {model.paletteOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={model.palette === option.id}
                      data-on={model.palette === option.id ? 'true' : 'false'}
                      onClick={() => onPalette?.(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <label class="bw-settings-toggle">
                  <input
                    type="checkbox"
                    checked={model.reduceMotion}
                    aria-label="Reduce motion"
                    onChange={(event) =>
                      onReduceMotion?.((event.currentTarget as HTMLInputElement).checked)
                    }
                  />
                  <span>Reduce motion — no camera easing, no panel slides</span>
                </label>

                <h4>Text size</h4>
                <Slider
                  label={`Text size · ${typeScaleLabel(model.typeScale)}`}
                  value={(model.typeScale - 1) / 0.3}
                  onChange={(value) => onTypeScale?.(1 + value * 0.3)}
                />

                <label class="bw-settings-toggle">
                  <input
                    type="checkbox"
                    checked={model.preferNoFailure}
                    aria-label="Prefer no-failure mode"
                    onChange={(event) =>
                      onPreferNoFailure?.((event.currentTarget as HTMLInputElement).checked)
                    }
                  />
                  <span>Start new prisons with every failure condition off</span>
                </label>
              </section>
            )}

            {tab === 'game' && (
              <section>
                <h4>Autosave</h4>
                <p class="bw-settings-hint">
                  Five rotating slots, plus one whenever the app goes to the background.
                </p>
                <div class="bw-settings-choices" role="radiogroup" aria-label="Autosave frequency">
                  {model.autosaveOptions.map((hours) => (
                    <button
                      key={hours}
                      type="button"
                      role="radio"
                      aria-checked={model.autosaveHours === hours}
                      data-on={model.autosaveHours === hours ? 'true' : 'false'}
                      onClick={() => onAutosaveHours?.(hours)}
                    >
                      {hours}h
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Slider({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly value: number
  readonly disabled?: boolean
  readonly onChange: (value: number) => void
}): JSX.Element {
  return (
    <label class="bw-settings-slider" data-disabled={disabled === true ? 'true' : 'false'}>
      <span class="k">{label}</span>
      <input
        type="range"
        min="0"
        max="100"
        value={String(Math.round(value * 100))}
        disabled={disabled === true}
        aria-label={label}
        onInput={(event) => onChange(Number((event.currentTarget as HTMLInputElement).value) / 100)}
      />
      <span class="v">{percentLabel(value)}</span>
    </label>
  )
}
