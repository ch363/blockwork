/**
 * Compact world-overlay legend (PRD 6.4 / mockup screen 1).
 *
 * Swatches carry a pattern as well as a colour and every row exposes its text
 * to assistive technology, so the legend never asks hue to carry meaning on
 * its own.
 */

import type { JSX } from 'preact'

export type OverlayLegendPattern = 'solid' | 'diagonal' | 'dots' | 'crosshatch'

export interface OverlayLegendEntry {
  readonly label: string
  /** CSS colour emitted by the renderer's selected accessible palette. */
  readonly colour: string
  readonly pattern: OverlayLegendPattern
}

export interface OverlayLegendModel {
  readonly title: string
  readonly paletteLabel: string
  readonly entries: readonly OverlayLegendEntry[]
}

export interface OverlayLegendProps {
  readonly model: OverlayLegendModel | null
  readonly trayOpen?: boolean
}

export function OverlayLegend({ model, trayOpen = false }: OverlayLegendProps): JSX.Element {
  return (
    <aside
      class="bw-overlay-legend"
      data-open={model !== null}
      data-tray-open={trayOpen}
      data-many={model !== null && model.entries.length > 8}
      aria-hidden={model === null}
      aria-label={model === null ? 'Map overlay legend' : `${model.title} overlay legend`}
    >
      {model !== null && (
        <>
          <header>
            <h4>Overlay · {model.title}</h4>
            <span>{model.paletteLabel}</span>
          </header>
          <ul>
            {model.entries.map((entry) => (
              <li key={`${entry.label}:${entry.pattern}`}>
                <i
                  class="bw-overlay-swatch"
                  data-pattern={entry.pattern}
                  style={{ '--overlay-colour': entry.colour }}
                  aria-hidden="true"
                />
                <span>{entry.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
