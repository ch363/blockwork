/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Reports, drawSeriesChart, filterReportLog } from '../../src/panels/Reports'
import type { ReportLogRowModel, ReportsModel } from '../../src/panels/Reports'
import { mountShell, unmount } from '../helpers/mount'

const LOG_ROWS: readonly ReportLogRowModel[] = [
  {
    id: 2,
    tick: 20,
    timeLabel: 'Day 1 · 00:02',
    severity: 'critical',
    category: 'fire',
    entityId: 1,
    entityKey: 'room:1',
    entityName: 'Workshop 1',
    title: 'Ignited',
    detail: 'Heat: 90',
    traceId: 2,
  },
  {
    id: 1,
    tick: 10,
    timeLabel: 'Day 1 · 00:01',
    severity: 'warn',
    category: 'intake',
    entityId: 1,
    entityKey: 'inmate:1',
    entityName: 'Rowan Vale · #1',
    title: 'No housing',
    detail: 'No suitable room',
    traceId: 1,
  },
]

function model(): ReportsModel {
  return {
    tick: 20,
    day: 1,
    population: 1,
    access: {
      needs: { unlocked: true, requirement: null },
      finance: { unlocked: true, requirement: null },
      intelligence: { unlocked: true, requirement: null },
    },
    needs: {
      population: 1,
      inmatesWithCriticalNeed: 1,
      meanMood: 42,
      misconduct24h: 2,
      rows: [
        {
          id: 'food',
          name: 'Food',
          bands: { satisfied: 0, medium: 0, high: 0, critical: 1 },
          demand: 1,
          capacity: 0,
          facilities: [],
          criticalLocations: [{ roomId: 1, roomName: 'Workshop 1', count: 1 }],
          bottleneck: {
            title: 'Bottleneck: no serving room',
            detail: 'No operational places for demand of 1.',
          },
        },
      ],
    },
    finance: {
      balance: 1_000,
      loanPrincipal: 0,
      cashFlow24h: 100,
      projectedDailyNet: 90,
      last7Days: [],
      income: [],
      expenses: [],
    },
    populationReport: {
      total: 1,
      capacity: 0,
      categories: [],
      sentenceBands: [],
      arrivals: { continuous: false, nextBusLabel: 'in 1h', requested: [] },
      releases: {
        next7Days: 0,
        last7Days: 0,
        lifetime: 0,
        parole: 0,
        sentenceServed: 0,
      },
    },
    intelligence: {
      maxInformants: 0,
      sources: [],
      market: [],
      informants: [],
      reputations: [],
      recruitCandidate: null,
    },
    log: LOG_ROWS,
    statistics: { metrics: [] },
  }
}

describe('Reports', () => {
  it('filters by search, severity, category and registry-qualified entity', () => {
    expect(
      filterReportLog(LOG_ROWS, {
        query: 'rowan',
        severity: 'warn',
        category: 'intake',
        entity: 'inmate:1',
      }).map((row) => row.id),
    ).toEqual([1])
    expect(
      filterReportLog(LOG_ROWS, {
        query: '',
        severity: 'all',
        category: 'all',
        entity: 'room:1',
      }).map((row) => row.id),
    ).toEqual([2])
  })

  it('renders the needs drilldown and opens its heatmap action', () => {
    const heatmaps: string[] = []
    const host = mountShell(
      <Reports
        model={model()}
        tab="needs"
        onTab={() => undefined}
        onClose={() => undefined}
        onShowNeedHeatmap={(needId) => heatmaps.push(needId)}
      />,
    )

    try {
      expect(host.textContent).toContain('Capacity vs demand')
      expect(host.textContent).toContain('Bottleneck: no serving room')
      const button = [...host.querySelectorAll('button')].find((entry) =>
        entry.textContent?.includes('Show heatmap'),
      )
      ;(button as HTMLButtonElement | undefined)?.click()
      expect(heatmaps).toEqual(['food'])
    } finally {
      unmount(host)
    }
  })

  it('shows Directorate requirements instead of gated report data', () => {
    const locked = model()
    const host = mountShell(
      <Reports
        model={{
          ...locked,
          finance: null,
          access: {
            ...locked.access,
            finance: { unlocked: false, requirement: 'Finance' },
          },
        }}
        tab="finance"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Finance report locked')
      expect(host.textContent).toContain('Complete Finance')
    } finally {
      unmount(host)
    }
  })

  it('draws a deterministic canvas chart without a chart library', () => {
    const calls: string[] = []
    const context = {
      clearRect: () => calls.push('clear'),
      beginPath: () => calls.push('begin'),
      moveTo: () => calls.push('move'),
      lineTo: () => calls.push('line'),
      stroke: () => calls.push('stroke'),
      fillText: () => calls.push('text'),
      arc: () => calls.push('arc'),
      fill: () => calls.push('fill'),
    } as unknown as CanvasRenderingContext2D

    drawSeriesChart(context, 320, 160, {
      labels: ['D1', 'D2'],
      series: [{ label: 'Income', colour: '#00ff00', values: [10, 20] }],
      textColour: '#ffffff',
      gridColour: '#333333',
    })

    expect(calls[0]).toBe('clear')
    expect(calls.filter((call) => call === 'arc')).toHaveLength(2)
    expect(calls).toContain('line')
    expect(calls).toContain('text')
  })
})
