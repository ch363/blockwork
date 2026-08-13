/**
 * Reports hub (T6.2, PRD 6.2).
 *
 * The worker sends one immutable snapshot containing every report. This
 * component only chooses how to present and filter it: no totals, thresholds
 * or projections are recomputed on the main thread.
 */

import type { JSX } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

import type { IntelligenceModel } from './Intelligence'

export type ReportsTab = 'needs' | 'finance' | 'population' | 'intelligence' | 'log' | 'statistics'

export type ReportSeverity = 'info' | 'warn' | 'critical'

export interface ReportDayCashflow {
  readonly day: number
  readonly income: number
  readonly expense: number
  readonly net: number
}

export interface ReportCategoryAmount {
  readonly id: string
  readonly label: string
  readonly amount: number
}

export interface FinanceReportModel {
  readonly balance: number
  readonly loanPrincipal: number
  readonly cashFlow24h: number
  readonly projectedDailyNet: number
  readonly last7Days: readonly ReportDayCashflow[]
  readonly income: readonly ReportCategoryAmount[]
  readonly expenses: readonly ReportCategoryAmount[]
}

export interface NeedSeverityBands {
  readonly satisfied: number
  readonly medium: number
  readonly high: number
  readonly critical: number
}

export interface NeedFacilityModel {
  readonly roomId: number
  readonly roomName: string
  readonly capacity: number
  readonly operationalCapacity: number
}

export interface NeedLocationModel {
  readonly roomId: number
  readonly roomName: string
  readonly count: number
}

export interface NeedBottleneckModel {
  readonly title: string
  readonly detail: string
}

export interface NeedReportRowModel {
  readonly id: string
  readonly name: string
  readonly bands: NeedSeverityBands
  readonly demand: number
  readonly capacity: number
  readonly facilities: readonly NeedFacilityModel[]
  readonly criticalLocations: readonly NeedLocationModel[]
  readonly bottleneck: NeedBottleneckModel | null
}

export interface NeedsReportModel {
  readonly population: number
  readonly inmatesWithCriticalNeed: number
  readonly meanMood: number
  readonly misconduct24h: number
  readonly rows: readonly NeedReportRowModel[]
}

export interface PopulationCategoryModel {
  readonly id: string
  readonly name: string
  readonly count: number
}

export interface SentenceBandModel {
  readonly id: string
  readonly label: string
  readonly count: number
}

export interface ArrivalCategoryModel {
  readonly id: string
  readonly name: string
  readonly requested: number
}

export interface PopulationReportModel {
  readonly total: number
  readonly capacity: number
  readonly categories: readonly PopulationCategoryModel[]
  readonly sentenceBands: readonly SentenceBandModel[]
  readonly arrivals: {
    readonly continuous: boolean
    readonly nextBusLabel: string
    readonly requested: readonly ArrivalCategoryModel[]
  }
  readonly releases: {
    readonly next7Days: number
    readonly last7Days: number
    readonly lifetime: number
    readonly parole: number
    readonly sentenceServed: number
  }
}

export interface ReportLogRowModel {
  readonly id: number
  readonly tick: number
  readonly timeLabel: string
  readonly severity: ReportSeverity
  readonly category: string
  readonly entityId: number
  /** Registry-qualified key; numeric ids overlap between entity kinds. */
  readonly entityKey: string
  readonly entityName: string
  readonly title: string
  readonly detail: string
  /** Set only for warn-or-above entries that can open Trace. */
  readonly traceId: number | null
}

export interface StatisticMetricModel {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly tone: 'neutral' | 'ok' | 'warn' | 'danger'
}

export interface StatisticsReportModel {
  readonly metrics: readonly StatisticMetricModel[]
}

export interface ReportsModel {
  readonly tick: number
  readonly day: number
  readonly population: number
  readonly finance: FinanceReportModel | null
  readonly needs: NeedsReportModel | null
  readonly access: {
    readonly finance: { readonly unlocked: boolean; readonly requirement: string | null }
    readonly needs: { readonly unlocked: boolean; readonly requirement: string | null }
    readonly intelligence: { readonly unlocked: boolean; readonly requirement: string | null }
  }
  readonly populationReport: PopulationReportModel
  readonly intelligence: IntelligenceModel | null
  readonly log: readonly ReportLogRowModel[]
  readonly statistics: StatisticsReportModel
}

export interface ReportsProps {
  readonly model: ReportsModel | null
  readonly tab: ReportsTab
  readonly onTab: (tab: ReportsTab) => void
  readonly onClose: () => void
  readonly onShowNeedHeatmap?: (needId: string) => void
  readonly onTrace?: (traceId: number) => void
}

const TABS: readonly { readonly id: ReportsTab; readonly label: string }[] = [
  { id: 'needs', label: 'Needs' },
  { id: 'finance', label: 'Finance' },
  { id: 'population', label: 'Population' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'log', label: 'Log' },
  { id: 'statistics', label: 'Statistics' },
]

export interface ReportLogFilters {
  readonly query: string
  readonly severity: ReportSeverity | 'all'
  readonly category: string
  readonly entity: string
}

/** Pure filter used by the persistent Log panel and its focused tests. */
export function filterReportLog(
  rows: readonly ReportLogRowModel[],
  filters: ReportLogFilters,
): ReportLogRowModel[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (filters.severity !== 'all' && row.severity !== filters.severity) return false
    if (filters.category !== 'all' && row.category !== filters.category) return false
    if (filters.entity !== 'all' && row.entityKey !== filters.entity) return false
    if (query.length === 0) return true
    return [row.title, row.detail, row.category, row.entityName, String(row.entityId)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query)
  })
}

export interface ChartSeries {
  readonly label: string
  readonly colour: string
  readonly values: readonly number[]
}

export interface SeriesChartOptions {
  readonly labels: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly textColour: string
  readonly gridColour: string
}

/**
 * Minimal line-chart renderer used by Finance.
 *
 * It deliberately accepts only a canvas context and plain values. There is no
 * hidden state, animation clock or chart dependency, so drawing the same
 * report snapshot always paints the same pixels.
 */
export function drawSeriesChart(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: SeriesChartOptions,
): void {
  context.clearRect(0, 0, width, height)
  if (width <= 0 || height <= 0 || options.labels.length === 0) return

  const left = 42
  const right = 12
  const top = 14
  const bottom = 28
  const plotWidth = Math.max(1, width - left - right)
  const plotHeight = Math.max(1, height - top - bottom)
  let maximum = 1
  for (const series of options.series) {
    for (const value of series.values) maximum = Math.max(maximum, value)
  }

  context.lineWidth = 1
  context.strokeStyle = options.gridColour
  context.fillStyle = options.textColour
  context.font = '11px system-ui, sans-serif'
  context.textAlign = 'right'
  context.textBaseline = 'middle'
  for (let step = 0; step <= 4; step += 1) {
    const ratio = step / 4
    const y = top + plotHeight * ratio
    context.beginPath()
    context.moveTo(left, y)
    context.lineTo(left + plotWidth, y)
    context.stroke()
    context.fillText(formatCompactMoney(maximum * (1 - ratio)), left - 6, y)
  }

  context.textAlign = 'center'
  context.textBaseline = 'top'
  const denominator = Math.max(1, options.labels.length - 1)
  options.labels.forEach((label, index) => {
    const x = left + (plotWidth * index) / denominator
    context.fillText(label, x, top + plotHeight + 7)
  })

  for (const series of options.series) {
    if (series.values.length === 0) continue
    context.beginPath()
    context.lineWidth = 2
    context.strokeStyle = series.colour
    series.values.forEach((value, index) => {
      const x = left + (plotWidth * index) / denominator
      const y = top + plotHeight - (Math.max(0, value) / maximum) * plotHeight
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.stroke()

    context.fillStyle = series.colour
    series.values.forEach((value, index) => {
      const x = left + (plotWidth * index) / denominator
      const y = top + plotHeight - (Math.max(0, value) / maximum) * plotHeight
      context.beginPath()
      context.arc(x, y, 3, 0, Math.PI * 2)
      context.fill()
    })
  }
}

function formatCompactMoney(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`
  return `$${Math.round(value)}`
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-GB')}`
}

export function Reports({
  model,
  tab,
  onTab,
  onClose,
  onShowNeedHeatmap,
  onTrace,
}: ReportsProps): JSX.Element {
  const open = model !== null

  return (
    <div
      class="bw-reports-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Reports"
    >
      {model !== null && (
        <>
          <div class="bw-reports-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Reports</h2>
              <div class="sub">
                Day {model.day} · population {model.population}
              </div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-reports-tabs" role="tablist" aria-label="Report">
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

          <div class="bw-reports-body">
            {tab === 'needs' &&
              (model.needs === null ? (
                <LockedReport name="Needs report" requirement={model.access.needs.requirement} />
              ) : (
                <NeedsReport
                  model={model.needs}
                  {...(onShowNeedHeatmap === undefined ? {} : { onShowHeatmap: onShowNeedHeatmap })}
                />
              ))}
            {tab === 'finance' &&
              (model.finance === null ? (
                <LockedReport
                  name="Finance report"
                  requirement={model.access.finance.requirement}
                />
              ) : (
                <FinanceReport model={model.finance} />
              ))}
            {tab === 'population' && <PopulationReport model={model.populationReport} />}
            {tab === 'intelligence' &&
              (model.intelligence === null ? (
                <LockedReport
                  name="Intelligence report"
                  requirement={model.access.intelligence.requirement}
                />
              ) : (
                <IntelligenceReport model={model.intelligence} />
              ))}
            {tab === 'log' && (
              <LogReport rows={model.log} {...(onTrace === undefined ? {} : { onTrace })} />
            )}
            {tab === 'statistics' && <StatisticsReport model={model.statistics} />}
          </div>
        </>
      )}
    </div>
  )
}

function LockedReport({
  name,
  requirement,
}: {
  readonly name: string
  readonly requirement: string | null
}): JSX.Element {
  return (
    <section class="bw-report-card bw-report-locked" role="status">
      <Icon name="reports" size={28} />
      <h3>{name} locked</h3>
      <p>Complete {requirement ?? 'the required Directorate research'} to open this report.</p>
    </section>
  )
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly tone?: 'neutral' | 'ok' | 'warn' | 'danger'
}): JSX.Element {
  return (
    <div class="bw-report-metric" data-tone={tone}>
      <span class="k">{label}</span>
      <span class="v">{value}</span>
      <span class="d">{detail}</span>
    </div>
  )
}

function NeedsReport({
  model,
  onShowHeatmap,
}: {
  readonly model: NeedsReportModel
  readonly onShowHeatmap?: (needId: string) => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState(model.rows[0]?.id ?? '')
  const selected = model.rows.find((row) => row.id === selectedId) ?? model.rows[0] ?? null

  return (
    <>
      <div class="bw-report-metrics">
        <Metric
          label="Inmates with a critical need"
          value={String(model.inmatesWithCriticalNeed)}
          detail={`${model.population === 0 ? 0 : Math.round((model.inmatesWithCriticalNeed / model.population) * 100)}% of population`}
          tone={model.inmatesWithCriticalNeed > 0 ? 'danger' : 'ok'}
        />
        <Metric
          label="Mean mood"
          value={String(model.meanMood)}
          detail="100 means needs are fully met"
          tone={model.meanMood < 50 ? 'warn' : 'ok'}
        />
        <Metric
          label="Misconduct last 24h"
          value={String(model.misconduct24h)}
          detail="All recorded categories"
          tone={model.misconduct24h > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div class="bw-report-two-col">
        <section class="bw-report-card">
          <header>
            <h3>Needs across the population</h3>
            <div class="bw-need-legend" aria-label="Need severity legend">
              <span data-band="satisfied">Satisfied</span>
              <span data-band="medium">Medium</span>
              <span data-band="high">High</span>
              <span data-band="critical">Critical</span>
            </div>
          </header>
          <div class="bw-report-card-body bw-need-list">
            {model.rows.map((row) => (
              <button
                type="button"
                class="bw-need-report-row"
                key={row.id}
                data-selected={selected?.id === row.id ? 'true' : 'false'}
                onClick={() => setSelectedId(row.id)}
                aria-label={`${row.name}, ${String(row.bands.critical)} critical`}
              >
                <span class="nm">{row.name}</span>
                <NeedStack bands={row.bands} />
                <span class="count">{row.bands.critical}</span>
              </button>
            ))}
          </div>
        </section>

        <NeedDetail row={selected} {...(onShowHeatmap === undefined ? {} : { onShowHeatmap })} />
      </div>
    </>
  )
}

function NeedStack({ bands }: { readonly bands: NeedSeverityBands }): JSX.Element {
  const total = bands.satisfied + bands.medium + bands.high + bands.critical
  const width = (value: number): string => `${total === 0 ? 0 : (value / total) * 100}%`
  return (
    <span class="bw-need-stack" aria-hidden="true">
      <i data-band="satisfied" style={{ width: width(bands.satisfied) }} />
      <i data-band="medium" style={{ width: width(bands.medium) }} />
      <i data-band="high" style={{ width: width(bands.high) }} />
      <i data-band="critical" style={{ width: width(bands.critical) }} />
    </span>
  )
}

function NeedDetail({
  row,
  onShowHeatmap,
}: {
  readonly row: NeedReportRowModel | null
  readonly onShowHeatmap?: (needId: string) => void
}): JSX.Element {
  if (row === null) {
    return <section class="bw-report-card bw-report-empty">No inmate needs to report.</section>
  }
  return (
    <section class="bw-report-card bw-need-detail">
      <header>
        <h3>{row.name}</h3>
        <span class="bw-report-pill danger">{row.bands.critical} critical</span>
      </header>
      <div class="bw-report-card-body">
        <h4>Capacity vs demand</h4>
        <ReportKeyValue label="Inmates needing service" value={String(row.demand)} />
        <ReportKeyValue label="Operational capacity" value={String(row.capacity)} />
        <ReportKeyValue label="Facilities" value={String(row.facilities.length)} />

        {row.bottleneck !== null && (
          <div class="bw-report-bottleneck" role="status">
            <strong>{row.bottleneck.title}</strong>
            <span>{row.bottleneck.detail}</span>
          </div>
        )}

        <h4>Facilities serving this need</h4>
        {row.facilities.length === 0 ? (
          <p class="bw-report-empty">No serving facilities.</p>
        ) : (
          <ul class="bw-report-compact-list">
            {row.facilities.map((facility) => (
              <li key={facility.roomId}>
                <span>{facility.roomName}</span>
                <span class="bw-num">
                  {facility.operationalCapacity}/{facility.capacity} available
                </span>
              </li>
            ))}
          </ul>
        )}

        <h4>Where critical cases are</h4>
        {row.criticalLocations.length === 0 ? (
          <p class="bw-report-empty">No critical cases.</p>
        ) : (
          <ul class="bw-report-compact-list">
            {row.criticalLocations.map((location) => (
              <li key={location.roomId}>
                <span>{location.roomName}</span>
                <span class="bw-num">{location.count}</span>
              </li>
            ))}
          </ul>
        )}
        <Button wide onClick={() => onShowHeatmap?.(row.id)}>
          Show heatmap on the map
        </Button>
      </div>
    </section>
  )
}

function ReportKeyValue({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): JSX.Element {
  return (
    <div class="bw-report-kv">
      <span class="k">{label}</span>
      <span class="v">{value}</span>
    </div>
  )
}

function FinanceReport({ model }: { readonly model: FinanceReportModel }): JSX.Element {
  return (
    <>
      <div class="bw-report-metrics">
        <Metric label="Balance" value={formatMoney(model.balance)} detail="Available cash" />
        <Metric
          label="Last 24 hours"
          value={formatMoney(model.cashFlow24h)}
          detail="Income less expenses"
          tone={model.cashFlow24h < 0 ? 'danger' : 'ok'}
        />
        <Metric
          label="Projected daily net"
          value={formatMoney(model.projectedDailyNet)}
          detail={`Loans: ${formatMoney(model.loanPrincipal)}`}
          tone={model.projectedDailyNet < 0 ? 'warn' : 'ok'}
        />
      </div>
      <div class="bw-report-two-col finance">
        <section class="bw-report-card">
          <header>
            <h3>Seven-day cashflow</h3>
            <div class="bw-chart-legend">
              <span data-series="income">Income</span>
              <span data-series="expense">Expenses</span>
            </div>
          </header>
          <div class="bw-report-card-body">
            <FinanceCanvas rows={model.last7Days} />
          </div>
        </section>
        <section class="bw-report-card">
          <header>
            <h3>Breakdown by category</h3>
          </header>
          <div class="bw-report-card-body bw-finance-breakdown">
            <CategoryTable title="Income" rows={model.income} />
            <CategoryTable title="Expenses" rows={model.expenses} />
          </div>
        </section>
      </div>
    </>
  )
}

function FinanceCanvas({ rows }: { readonly rows: readonly ReportDayCashflow[] }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const logicalWidth = canvas.clientWidth > 0 ? canvas.clientWidth : 640
    const logicalHeight = canvas.clientHeight > 0 ? canvas.clientHeight : 250
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2)
    canvas.width = Math.round(logicalWidth * ratio)
    canvas.height = Math.round(logicalHeight * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const style = getComputedStyle(canvas)
    drawSeriesChart(context, logicalWidth, logicalHeight, {
      labels: rows.map((row) => `D${row.day}`),
      series: [
        {
          label: 'Income',
          colour: style.getPropertyValue('--ok').trim(),
          values: rows.map((row) => row.income),
        },
        {
          label: 'Expenses',
          colour: style.getPropertyValue('--danger').trim(),
          values: rows.map((row) => row.expense),
        },
      ],
      textColour: style.getPropertyValue('--text-dim').trim(),
      gridColour: style.getPropertyValue('--border').trim(),
    })
  }, [rows])

  return (
    <>
      <canvas
        ref={ref}
        class="bw-finance-chart"
        role="img"
        aria-label="Income and expenses for the last seven in-game days"
      />
      <table class="bw-sr-only">
        <caption>Seven-day cashflow values</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Income</th>
            <th>Expenses</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.day}>
              <td>{row.day}</td>
              <td>{row.income}</td>
              <td>{row.expense}</td>
              <td>{row.net}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function CategoryTable({
  title,
  rows,
}: {
  readonly title: string
  readonly rows: readonly ReportCategoryAmount[]
}): JSX.Element {
  return (
    <div>
      <h4>{title}</h4>
      <table class="bw-report-table">
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td>No entries</td>
              <td class="bw-num">{formatMoney(0)}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td class="bw-num">{formatMoney(row.amount)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function PopulationReport({ model }: { readonly model: PopulationReportModel }): JSX.Element {
  const largestCategory = Math.max(1, ...model.categories.map((row) => row.count))
  const largestSentence = Math.max(1, ...model.sentenceBands.map((row) => row.count))
  return (
    <>
      <div class="bw-report-metrics">
        <Metric
          label="Population"
          value={String(model.total)}
          detail={`${model.capacity} housing places`}
        />
        <Metric
          label="Arrivals"
          value={model.arrivals.continuous ? 'Continuous' : 'Requested'}
          detail={`Next bus ${model.arrivals.nextBusLabel}`}
        />
        <Metric
          label="Releases"
          value={String(model.releases.next7Days)}
          detail="Due in the next 7 days"
        />
      </div>
      <div class="bw-report-grid">
        <section class="bw-report-card">
          <header>
            <h3>Category mix</h3>
          </header>
          <div class="bw-report-card-body bw-horizontal-bars">
            {model.categories.map((row) => (
              <div class="bw-horizontal-row" key={row.id}>
                <span>{row.name}</span>
                <i style={{ width: `${(row.count / largestCategory) * 100}%` }} />
                <b>{row.count}</b>
              </div>
            ))}
          </div>
        </section>
        <section class="bw-report-card">
          <header>
            <h3>Sentence progress</h3>
          </header>
          <div class="bw-report-card-body bw-horizontal-bars">
            {model.sentenceBands.map((row) => (
              <div class="bw-horizontal-row" key={row.id}>
                <span>{row.label}</span>
                <i style={{ width: `${(row.count / largestSentence) * 100}%` }} />
                <b>{row.count}</b>
              </div>
            ))}
          </div>
        </section>
        <section class="bw-report-card">
          <header>
            <h3>Arrivals</h3>
          </header>
          <div class="bw-report-card-body">
            <ReportKeyValue
              label="Continuous intake"
              value={model.arrivals.continuous ? 'On' : 'Off'}
            />
            <ReportKeyValue label="Next bus" value={model.arrivals.nextBusLabel} />
            {model.arrivals.requested.map((row) => (
              <ReportKeyValue key={row.id} label={row.name} value={String(row.requested)} />
            ))}
          </div>
        </section>
        <section class="bw-report-card">
          <header>
            <h3>Releases</h3>
          </header>
          <div class="bw-report-card-body">
            <ReportKeyValue label="Last 7 days" value={String(model.releases.last7Days)} />
            <ReportKeyValue label="Lifetime" value={String(model.releases.lifetime)} />
            <ReportKeyValue label="Parole" value={String(model.releases.parole)} />
            <ReportKeyValue label="Sentence served" value={String(model.releases.sentenceServed)} />
          </div>
        </section>
      </div>
    </>
  )
}

function IntelligenceReport({ model }: { readonly model: IntelligenceModel }): JSX.Element {
  return (
    <div class="bw-report-grid intelligence">
      <section class="bw-report-card">
        <header>
          <h3>Contraband source map</h3>
        </header>
        <div class="bw-report-card-body">
          <table class="bw-report-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Known</th>
                <th>Present</th>
              </tr>
            </thead>
            <tbody>
              {model.sources.map((row) => (
                <tr key={row.roomId}>
                  <td>{row.roomName}</td>
                  <td class="bw-num">{row.revealed}</td>
                  <td class="bw-num">{row.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {model.sources.length === 0 && <p class="bw-report-empty">No traced sources.</p>}
        </div>
      </section>
      <section class="bw-report-card">
        <header>
          <h3>Live market</h3>
        </header>
        <div class="bw-report-card-body">
          <table class="bw-report-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Price</th>
                <th>Supply</th>
                <th>Demand</th>
              </tr>
            </thead>
            <tbody>
              {model.market.map((row) => (
                <tr key={row.itemId}>
                  <td>{row.itemName}</td>
                  <td class="bw-num">{formatMoney(row.price)}</td>
                  <td class="bw-num">{row.supply}</td>
                  <td class="bw-num">{row.demand}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="bw-report-card">
        <header>
          <h3>Informants</h3>
          <span class="bw-report-pill">
            {model.informants.filter((row) => !row.blown).length}/{model.maxInformants} active
          </span>
        </header>
        <div class="bw-report-card-body">
          <ul class="bw-report-compact-list">
            {model.informants.map((row) => (
              <li key={row.inmateId}>
                <span>{row.name}</span>
                <span>
                  {row.blown ? 'Blown' : `${Math.round(row.blowChance * 100)}% risk`} ·{' '}
                  {row.coverageRadius} tiles
                </span>
              </li>
            ))}
          </ul>
          {model.informants.length === 0 && <p class="bw-report-empty">No informants.</p>}
        </div>
      </section>
      <section class="bw-report-card">
        <header>
          <h3>Revealed reputations</h3>
        </header>
        <div class="bw-report-card-body">
          <ul class="bw-report-compact-list">
            {model.reputations.map((row) => (
              <li key={`${row.inmateId}:${row.reputationName}`}>
                <span>{row.inmateName}</span>
                <span>{row.reputationName}</span>
              </li>
            ))}
          </ul>
          {model.reputations.length === 0 && <p class="bw-report-empty">Nothing uncovered yet.</p>}
        </div>
      </section>
    </div>
  )
}

function LogReport({
  rows,
  onTrace,
}: {
  readonly rows: readonly ReportLogRowModel[]
  readonly onTrace?: (traceId: number) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState<ReportSeverity | 'all'>('all')
  const [category, setCategory] = useState('all')
  const [entity, setEntity] = useState('all')
  const categories = useMemo(() => [...new Set(rows.map((row) => row.category))].sort(), [rows])
  const entities = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const row of rows) {
      if (row.entityId > 0) byKey.set(row.entityKey, row.entityName)
    }
    return [...byKey].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  }, [rows])
  const filtered = useMemo(
    () => filterReportLog(rows, { query, severity, category, entity }),
    [rows, query, severity, category, entity],
  )

  return (
    <section class="bw-report-card bw-log-card">
      <header>
        <h3>Event history</h3>
        <span class="bw-report-pill">{filtered.length} shown</span>
      </header>
      <div class="bw-log-filters">
        <label>
          <span>Search</span>
          <input
            type="search"
            value={query}
            placeholder="Search events"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Severity</span>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.currentTarget.value as ReportSeverity | 'all')}
          >
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label>
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.currentTarget.value)}>
            <option value="all">All</option>
            {categories.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Entity</span>
          <select value={entity} onChange={(event) => setEntity(event.currentTarget.value)}>
            <option value="all">All</option>
            {entities.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="bw-log-scroll">
        <table class="bw-report-table bw-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Severity</th>
              <th>Category</th>
              <th>Entity</th>
              <th>Event</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} data-severity={row.severity}>
                <td>{row.timeLabel}</td>
                <td>
                  <span class="bw-log-severity" data-severity={row.severity}>
                    {row.severity}
                  </span>
                </td>
                <td>{row.category}</td>
                <td>{row.entityName}</td>
                <td>
                  <strong>{row.title}</strong>
                  {row.detail.length > 0 && <span>{row.detail}</span>}
                </td>
                <td>
                  {row.traceId !== null && (
                    <Button
                      variant="ghost"
                      ariaLabel={`Open Trace for ${row.title}`}
                      onClick={() => onTrace?.(row.traceId ?? 0)}
                    >
                      Trace
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p class="bw-report-empty">No events match the active filters.</p>
        )}
      </div>
    </section>
  )
}

function StatisticsReport({ model }: { readonly model: StatisticsReportModel }): JSX.Element {
  return (
    <div class="bw-statistics-grid">
      {model.metrics.map((metric) => (
        <Metric
          key={metric.id}
          label={metric.label}
          value={metric.value}
          detail={metric.detail}
          tone={metric.tone}
        />
      ))}
    </div>
  )
}
