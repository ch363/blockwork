/**
 * The top bar (PRD 6.1, mockup screen 1).
 *
 * Speed, time, the numbers that decide whether the prison is working, and the
 * two buttons that are always reachable. It is a pure view: every value
 * arrives as a prop and nothing here reads the simulation, so the bar cannot
 * disagree with the world about the balance.
 *
 * Two details are doing more work than they look.
 *
 * **The moral ledger sits beside the money.** PRD 1.1's fourth pillar asks for
 * re-offending to be visible at all times, next to the bank balance, presented
 * without editorialising. That is why it is a `bw-stat` identical to the
 * balance rather than something smaller or greyer: the design intent is that
 * the player chooses which number to optimise, and a layout that whispers one
 * of them has made the choice for them.
 *
 * **Speed is a five-way segmented control, not a play/pause pair.** Pause is a
 * speed (PRD 3.9's ladder is 0, 1, 2, 5, 20), and modelling it as one means
 * there is exactly one piece of state and no way to be paused at 5x.
 */

import type { JSX } from 'preact'

import { Icon } from '../icons'

/** PRD 3.9. 0 is pause; the rest scale steps per real second. */
export const SPEED_STOPS = [0, 1, 2, 5, 20] as const

export type SpeedStop = (typeof SPEED_STOPS)[number]

/** Everything the bar draws. Numbers, already computed by the host. */
export interface TopBarModel {
  /** `ticksToTimeString` output: "14:20". */
  readonly time: string
  readonly day: number
  /** "Spring", or "Paused" while the clock is stopped. */
  readonly dayNote: string
  readonly balance: number
  /** Net per in-game day. Signed. */
  readonly balancePerDay: number
  readonly population: number
  readonly capacity: number
  /** 0..100. PRD 5.11. */
  readonly danger: number
  /** Percentage, 0..100. The moral ledger (PRD 1.1). */
  readonly reoffending: number
  readonly alerts: number
  /** Any alert at critical severity, which makes the badge pulse (PRD 6.5). */
  readonly critical: boolean
}

export interface TopBarProps {
  readonly model: TopBarModel
  readonly speed: SpeedStop
  readonly onSpeed: (speed: SpeedStop) => void
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onAlerts: () => void
  readonly onMenu: () => void
  readonly canUndo?: boolean
  readonly canRedo?: boolean
}

const MONEY = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

/** "$84,120", or "-$1,240". The sign leads, so the digits stay aligned. */
export function formatMoney(amount: number): string {
  const rounded = Math.round(amount)
  return `${rounded < 0 ? '-' : ''}$${MONEY.format(Math.abs(rounded))}`
}

/** "+$1,840", with the sign always shown: a rate reads as a direction. */
export function formatRate(amount: number): string {
  const rounded = Math.round(amount)
  return `${rounded < 0 ? '-' : '+'}$${MONEY.format(Math.abs(rounded))}`
}

/**
 * The band names of PRD 5.11, so the gauge reads as a state rather than a
 * number the player has to have memorised a scale for.
 */
export function dangerBand(danger: number): string {
  if (danger < 20) return 'Calm'
  if (danger < 40) return 'Settled'
  if (danger < 60) return 'Unsettled'
  if (danger < 80) return 'Elevated'
  return 'Critical'
}

function dangerFill(danger: number): string {
  if (danger < 40) return 'var(--ok)'
  if (danger < 60) return 'var(--warn)'
  return 'linear-gradient(90deg, var(--warn), var(--danger))'
}

function speedLabel(speed: SpeedStop): string {
  return speed === 0 ? 'Pause' : `${String(speed)}x`
}

function reoffendingTone(value: number): string {
  if (value < 25) return 'v pos'
  if (value < 50) return 'v warn'
  return 'v neg'
}

export function TopBar({
  model,
  speed,
  onSpeed,
  onUndo,
  onRedo,
  onAlerts,
  onMenu,
  canUndo = false,
  canRedo = false,
}: TopBarProps): JSX.Element {
  const danger = Math.max(0, Math.min(100, model.danger))
  const dangerState = dangerBand(danger).toLowerCase()

  return (
    <header class="bw-topbar" role="banner" data-danger={dangerState} data-paused={speed === 0}>
      <div class="bw-speed" role="group" aria-label="Simulation speed" data-anchor="topbar:speed">
        {SPEED_STOPS.map((stop) => (
          <button
            key={stop}
            type="button"
            data-on={speed === stop}
            aria-pressed={speed === stop}
            aria-label={speedLabel(stop)}
            title={speedLabel(stop)}
            onClick={() => {
              onSpeed(stop)
            }}
          >
            {stop === 0 ? <Icon name="pause" size={16} /> : `${String(stop)}x`}
          </button>
        ))}
      </div>

      <div class="bw-clock">
        <span class="t">{model.time}</span>
        <span class="d">
          Day {model.day} &middot; {model.dayNote}
        </span>
      </div>

      <div class="bw-stat" data-stat="balance">
        <span class="k">Balance</span>
        <span class={model.balance < 0 ? 'v neg' : 'v pos'}>{formatMoney(model.balance)}</span>
        <span class="sub">{formatRate(model.balancePerDay)} / day</span>
      </div>

      <div class="bw-stat" data-stat="population">
        <span class="k">Population</span>
        <span class="v">
          {model.population}
          <span style="color:var(--text-faint);font-weight:400;font-size:var(--f-cap)">
            {' '}
            / {model.capacity}
          </span>
        </span>
        <span class="sub">{model.capacity - model.population} places free</span>
      </div>

      <div class="bw-stat" data-stat="reoffending">
        <span class="k">Re-offending</span>
        <span class={reoffendingTone(model.reoffending)}>{model.reoffending}%</span>
        <span class="sub">Estimated on release</span>
      </div>

      <div class="bw-spacer" />

      <div class="bw-gauge" data-danger={dangerState}>
        <div class="row">
          <span>Danger</span>
          <b>
            {danger} {dangerBand(danger)}
          </b>
        </div>
        <div
          class="bw-bar"
          role="meter"
          aria-valuenow={danger}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Danger"
        >
          <i style={{ width: `${String(danger)}%`, background: dangerFill(danger) }} />
        </div>
      </div>

      <button
        type="button"
        class="bw-iconbtn"
        data-action="undo"
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo"
        aria-label="Undo"
      >
        <Icon name="undo" size={20} />
      </button>
      <button
        type="button"
        class="bw-iconbtn"
        data-action="redo"
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo"
        aria-label="Redo"
      >
        <Icon name="redo" size={20} />
      </button>

      <button
        type="button"
        class="bw-iconbtn"
        data-action="alerts"
        data-anchor="topbar:alerts"
        onClick={onAlerts}
        title="Alerts"
        aria-label={`Alerts: ${String(model.alerts)}`}
      >
        <Icon name="alerts" size={20} />
        {model.alerts > 0 && (
          <span class="bw-badge" data-pulse={model.critical}>
            {model.alerts > 99 ? '99+' : model.alerts}
          </span>
        )}
      </button>

      <button
        type="button"
        class="bw-iconbtn"
        data-action="menu"
        onClick={onMenu}
        title="Menu"
        aria-label="Menu"
      >
        <Icon name="menu" size={20} />
      </button>
    </header>
  )
}
