/**
 * Standing Orders panel (T4.3, PRD 5.10 / 6.x, mockup screen 9).
 *
 * Misconduct → punishment matrix, search triggers, cell reassignment
 * strictness, and meal quantity / variety. Presentational only: the host
 * hands a resolved {@link StandingOrdersModel} and gestures leave as callbacks.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type StandingOrdersTab = 'punishment' | 'search' | 'housing' | 'meals'

export type StandingPunishment = 'ignore' | 'lockdown' | 'isolation'

export type StandingStrictness = 'off' | 'lenient' | 'strict'

export type StandingMealQuantity = 'low' | 'normal' | 'high'

export interface StandingOrdersRowModel {
  readonly misconduct: string
  readonly label: string
  readonly punishment: StandingPunishment
  /** Hours; null means n/a; -1 means indefinite. */
  readonly durationHours: number | null
  readonly search: boolean
}

export interface StandingOrdersProjection {
  readonly meanSuppressionFrom: number
  readonly meanSuppressionTo: number
  readonly misconductPerDayFrom: number
  readonly misconductPerDayTo: number
  readonly programmeParticipationFrom: number
  readonly programmeParticipationTo: number
  readonly reoffendFrom: number
  readonly reoffendTo: number
  readonly isolationCells: number
  readonly isolationOccupied: number
  readonly isolationProjectedPeak: number
}

export interface StandingOrdersModel {
  readonly rows: readonly StandingOrdersRowModel[]
  readonly strictness: StandingStrictness
  readonly mealQuantity: StandingMealQuantity
  readonly mealVariety: number
  readonly maxMealVariety: number
  readonly projection: StandingOrdersProjection | null
}

export interface StandingOrdersProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: StandingOrdersModel | null
  readonly tab: StandingOrdersTab
  readonly onTab: (tab: StandingOrdersTab) => void
  readonly onClose: () => void
  readonly onPunishment?: (misconduct: string, punishment: StandingPunishment) => void
  readonly onDuration?: (misconduct: string, durationHours: number) => void
  readonly onSearchTrigger?: (misconduct: string, search: boolean) => void
  readonly onStrictness?: (strictness: StandingStrictness) => void
  readonly onMealQuantity?: (quantity: StandingMealQuantity) => void
  readonly onMealVariety?: (variety: number) => void
}

const TABS: readonly { readonly id: StandingOrdersTab; readonly label: string }[] = [
  { id: 'punishment', label: 'Punishment' },
  { id: 'search', label: 'Search' },
  { id: 'housing', label: 'Housing' },
  { id: 'meals', label: 'Meals' },
]

const PUNISHMENTS: readonly StandingPunishment[] = ['ignore', 'lockdown', 'isolation']

const STRICTNESS: readonly {
  readonly id: StandingStrictness
  readonly label: string
}[] = [
  { id: 'off', label: 'Off' },
  { id: 'lenient', label: 'Lenient · within 2' },
  { id: 'strict', label: 'Strict · exact' },
]

const MEAL_QUANTITIES: readonly StandingMealQuantity[] = ['low', 'normal', 'high']

export function StandingOrders({
  model,
  tab,
  onTab,
  onClose,
  onPunishment,
  onDuration,
  onSearchTrigger,
  onStrictness,
  onMealQuantity,
  onMealVariety,
}: StandingOrdersProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })
  const showSide =
    model !== null && model.projection !== null && (tab === 'punishment' || tab === 'search')

  return (
    <div
      ref={trapRef}
      class="bw-orders-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Standing Orders"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-orders-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Standing Orders</h2>
              <div class="sub">Punishment, search and welfare policy</div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-seg" role="tablist" aria-label="Standing Orders views">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id ? 'true' : 'false'}
                  data-on={tab === entry.id ? 'true' : 'false'}
                  onClick={() => {
                    onTab(entry.id)
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-orders-body" data-side={showSide ? 'true' : 'false'}>
            {(tab === 'punishment' || tab === 'search') && (
              <div class="bw-orders-main">
                <div class="bw-orders-card">
                  <header>
                    <h3>{tab === 'punishment' ? 'Misconduct response' : 'Search triggers'}</h3>
                    <span class="bw-orders-pill">Autosaved</span>
                  </header>
                  <div class="bw-orders-card-body">
                    <table class="bw-orders-matrix">
                      <thead>
                        <tr>
                          <th>Misconduct</th>
                          {tab === 'punishment' && (
                            <>
                              <th>Response</th>
                              <th>Duration</th>
                            </>
                          )}
                          <th>Search</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.rows.map((row) => (
                          <tr key={row.misconduct}>
                            <td>{row.label}</td>
                            {tab === 'punishment' && (
                              <>
                                <td>
                                  <div class="bw-radio-seg" role="group" aria-label={row.label}>
                                    {PUNISHMENTS.map((punishment) => (
                                      <button
                                        key={punishment}
                                        type="button"
                                        data-on={row.punishment === punishment ? 'true' : 'false'}
                                        data-tone={
                                          punishment === 'isolation'
                                            ? 'bad'
                                            : punishment === 'lockdown'
                                              ? 'warn'
                                              : undefined
                                        }
                                        onClick={() => {
                                          onPunishment?.(row.misconduct, punishment)
                                        }}
                                      >
                                        {labelPunishment(punishment)}
                                      </button>
                                    ))}
                                  </div>
                                </td>
                                <td class="bw-orders-duration">
                                  {formatDuration(row.durationHours, row.punishment)}
                                  {row.punishment !== 'ignore' && row.durationHours !== -1 && (
                                    <button
                                      type="button"
                                      class="bw-orders-duration-btn"
                                      aria-label={`Increase duration for ${row.label}`}
                                      onClick={() => {
                                        const next =
                                          (row.durationHours === null || row.durationHours <= 0
                                            ? 4
                                            : row.durationHours) + 2
                                        onDuration?.(row.misconduct, next)
                                      }}
                                    >
                                      +
                                    </button>
                                  )}
                                </td>
                              </>
                            )}
                            <td class="bw-orders-search">
                              <button
                                type="button"
                                class="bw-orders-check"
                                data-on={row.search ? 'true' : 'false'}
                                aria-pressed={row.search ? 'true' : 'false'}
                                aria-label={`Search on ${row.label}`}
                                onClick={() => {
                                  onSearchTrigger?.(row.misconduct, !row.search)
                                }}
                              >
                                {row.search ? '▣' : '□'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {tab === 'punishment' && (
                      <div class="bw-orders-strictness">
                        <h4>Cell reassignment strictness</h4>
                        <div
                          class="bw-radio-seg bw-radio-seg-wide"
                          role="group"
                          aria-label="Strictness"
                        >
                          {STRICTNESS.map((entry) => (
                            <button
                              key={entry.id}
                              type="button"
                              data-on={model.strictness === entry.id ? 'true' : 'false'}
                              onClick={() => {
                                onStrictness?.(entry.id)
                              }}
                            >
                              {entry.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === 'housing' && (
              <div class="bw-orders-main">
                <div class="bw-orders-card">
                  <header>
                    <h3>Cell reassignment</h3>
                  </header>
                  <div class="bw-orders-card-body">
                    <p class="bw-orders-copy">
                      Hourly pass matching entitlement to cell grade. Strictness controls how exact
                      the match must be.
                    </p>
                    <div
                      class="bw-radio-seg bw-radio-seg-wide"
                      role="group"
                      aria-label="Strictness"
                    >
                      {STRICTNESS.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          data-on={model.strictness === entry.id ? 'true' : 'false'}
                          onClick={() => {
                            onStrictness?.(entry.id)
                          }}
                        >
                          {entry.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'meals' && (
              <div class="bw-orders-main">
                <div class="bw-orders-card">
                  <header>
                    <h3>Meal policy</h3>
                  </header>
                  <div class="bw-orders-card-body">
                    <h4>Quantity</h4>
                    <div class="bw-radio-seg" role="group" aria-label="Meal quantity">
                      {MEAL_QUANTITIES.map((quantity) => (
                        <button
                          key={quantity}
                          type="button"
                          data-on={model.mealQuantity === quantity ? 'true' : 'false'}
                          onClick={() => {
                            onMealQuantity?.(quantity)
                          }}
                        >
                          {labelQuantity(quantity)}
                        </button>
                      ))}
                    </div>
                    <h4>Variety</h4>
                    <div class="bw-orders-variety">
                      <button
                        type="button"
                        disabled={model.mealVariety <= 1}
                        aria-label="Decrease variety"
                        onClick={() => {
                          onMealVariety?.(model.mealVariety - 1)
                        }}
                      >
                        −
                      </button>
                      <span>
                        {model.mealVariety} ingredient
                        {model.mealVariety === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        disabled={model.mealVariety >= model.maxMealVariety}
                        aria-label="Increase variety"
                        onClick={() => {
                          onMealVariety?.(model.mealVariety + 1)
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {model.projection !== null && (tab === 'punishment' || tab === 'search') && (
              <div class="bw-orders-side">
                <ProjectionCard projection={model.projection} />
                <IsolationCard projection={model.projection} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ProjectionCard({
  projection,
}: {
  readonly projection: StandingOrdersProjection
}): JSX.Element {
  return (
    <div class="bw-orders-card">
      <header>
        <h3>Projected effect</h3>
      </header>
      <div class="bw-orders-card-body bw-orders-proj">
        <ProjRow
          label="Mean suppression"
          from={projection.meanSuppressionFrom}
          to={projection.meanSuppressionTo}
          tone="warn"
        />
        <ProjRow
          label="Misconduct rate"
          from={projection.misconductPerDayFrom}
          to={projection.misconductPerDayTo}
          suffix="/day"
          tone="ok"
        />
        <ProjRow
          label="Programme participation"
          from={projection.programmeParticipationFrom}
          to={projection.programmeParticipationTo}
          suffix="%"
          tone="danger"
        />
        <ProjRow
          label="Re-offending estimate"
          from={projection.reoffendFrom}
          to={projection.reoffendTo}
          suffix="%"
          tone="danger"
        />
        <p class="bw-orders-copy">
          Harsher standing orders buy control now and cost reform later. The projection uses your
          current population mix and updates as you change the matrix.
        </p>
      </div>
    </div>
  )
}

function IsolationCard({
  projection,
}: {
  readonly projection: StandingOrdersProjection
}): JSX.Element {
  const pct =
    projection.isolationCells === 0
      ? 0
      : Math.round((projection.isolationOccupied / projection.isolationCells) * 100)
  return (
    <div class="bw-orders-card">
      <header>
        <h3>Isolation capacity</h3>
        <span class={`bw-orders-pill${pct >= 90 ? ' warn' : ''}`}>At {pct}%</span>
      </header>
      <div class="bw-orders-card-body">
        <div class="bw-orders-kv">
          <span>Isolation cells</span>
          <b>{projection.isolationCells}</b>
        </div>
        <div class="bw-orders-kv">
          <span>Currently occupied</span>
          <b>{projection.isolationOccupied}</b>
        </div>
        <div class="bw-orders-kv">
          <span>Projected peak under this policy</span>
          <b data-tone="danger">{projection.isolationProjectedPeak}</b>
        </div>
        <p class="bw-orders-copy">
          Overflow falls back to cell lockdown, which is less effective and will raise your
          misconduct rate above the projection.
        </p>
      </div>
    </div>
  )
}

function ProjRow(props: {
  readonly label: string
  readonly from: number
  readonly to: number
  readonly suffix?: string
  readonly tone: 'ok' | 'warn' | 'danger'
}): JSX.Element {
  const suffix = props.suffix ?? ''
  const width = Math.max(0, Math.min(100, props.to))
  return (
    <div>
      <div class="bw-orders-proj-label">
        <span>{props.label}</span>
        <b data-tone={props.tone}>
          {props.from}
          {suffix} → {props.to}
          {suffix}
        </b>
      </div>
      <div class="bw-orders-bar">
        <i style={`width:${width}%`} data-tone={props.tone} />
      </div>
    </div>
  )
}

function labelPunishment(punishment: StandingPunishment): string {
  if (punishment === 'ignore') return 'Ignore'
  if (punishment === 'lockdown') return 'Lockdown'
  return 'Isolation'
}

function labelQuantity(quantity: StandingMealQuantity): string {
  if (quantity === 'low') return 'Low'
  if (quantity === 'normal') return 'Normal'
  return 'High'
}

export function formatDuration(hours: number | null, punishment: StandingPunishment): string {
  if (punishment === 'ignore' || hours === null || hours === 0) return 'n/a'
  if (hours < 0) return 'Indefinite'
  return `${hours} hours`
}

/** Default misconduct labels for hosts that have not localised yet. */
export const MISCONDUCT_LABELS: Readonly<Record<string, string>> = {
  complaint: 'Complaint',
  contraband: 'Contraband found',
  intoxication: 'Intoxication',
  destruction: 'Destruction',
  attackInmate: 'Attacked inmate',
  attackStaff: 'Attacked staff',
  seriousInjury: 'Serious injury',
  homicide: 'Homicide',
  escapeAttempt: 'Escape attempt',
}
