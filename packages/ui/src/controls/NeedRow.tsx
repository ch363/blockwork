/**
 * One need meter row, matching the mockup's `.need` grid.
 *
 * Interactive (tap-to-trace later); sized so the whole row clears `--hit-min`.
 */

import type { JSX } from 'preact'

export type NeedSeverity = 'ok' | 'medium' | 'high' | 'critical' | 'active'

export interface NeedRowModel {
  readonly id: string
  readonly name: string
  /** 0..100. */
  readonly value: number
  readonly severity: NeedSeverity
}

export interface NeedRowProps {
  readonly need: NeedRowModel
  readonly onSelect?: ((needId: string) => void) | undefined
}

const FILL: Readonly<Record<NeedSeverity, string>> = {
  ok: 'var(--need-ok)',
  medium: 'var(--need-medium)',
  high: 'var(--need-high)',
  critical: 'var(--need-critical)',
  active: 'var(--need-active)',
}

export function NeedRow({ need, onSelect }: NeedRowProps): JSX.Element {
  const crit = need.severity === 'critical'
  const value = Math.max(0, Math.min(100, Math.round(need.value)))

  return (
    <button
      type="button"
      class={crit ? 'bw-need crit' : 'bw-need'}
      onClick={() => {
        onSelect?.(need.id)
      }}
      aria-label={`${need.name} need ${String(value)}, ${need.severity}`}
    >
      <span class="nm">{need.name}</span>
      <span class="bw-need-bar" aria-hidden="true">
        <i style={{ width: `${String(value)}%`, background: FILL[need.severity] }} />
      </span>
      <span class="vv">{value}</span>
    </button>
  )
}
