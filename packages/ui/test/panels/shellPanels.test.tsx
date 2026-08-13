/**
 * @vitest-environment happy-dom
 *
 * T8.7: Verifies that Settings, NewPrison, Onboarding, and Alerts mount in
 * the GameShell and can be opened and closed.
 */

import { describe, expect, it } from 'vitest'

import { GameShell } from '../../src/GameShell'
import type { GameShellProps } from '../../src/GameShell'
import type { SettingsModel } from '../../src/panels/Settings'
import type { NewPrisonModel, ToggleModel } from '../../src/panels/NewPrison'
import type { OnboardingModel } from '../../src/panels/Onboarding'
import type { AlertsModel } from '../../src/panels/Alerts'
import type { RoutineModel, RoutineBlockId } from '../../src/panels/Routine'
import type { ContractsModel } from '../../src/panels/Contracts'
import type { IntakeModel } from '../../src/panels/Intake'
import type { FlowModel } from '../../src/panels/Flow'
import { mountShell, unmount } from '../helpers/mount'

function noop(): void {
  // Intentionally empty.
}

const EMPTY_TOP_BAR = {
  time: '00:00',
  day: 1,
  dayNote: 'Paused',
  balance: 0,
  balancePerDay: 0,
  population: 0,
  capacity: 0,
  danger: 0,
  reoffending: 0,
  alerts: 0,
  critical: false,
}

function baseShellProps(): GameShellProps {
  return {
    stageRef: { current: null },
    topBar: EMPTY_TOP_BAR,
    speed: 1,
    onSpeed: noop,
    tool: null,
    onTool: noop,
    palette: [],
    paletteSelection: null,
    onPaletteSelect: noop,
    inspector: null,
    onInspectorClose: noop,
    blueprint: null,
    onCommit: noop,
    onDiscard: noop,
    onIssueFocus: noop,
    toasts: [],
    onTrace: noop,
    onDismissToast: noop,
    onUndo: noop,
    onRedo: noop,
    onAlerts: noop,
    onMenu: noop,
  }
}

function toggles(ids: readonly string[], enabled: boolean): ToggleModel[] {
  return ids.map((id) => ({
    id,
    label: id,
    description: `What ${id} does`,
    enabled,
  }))
}

function settingsModel(patch: Partial<SettingsModel> = {}): SettingsModel {
  return {
    music: 0.6,
    sfx: 0.8,
    muted: false,
    palette: 'default',
    paletteOptions: [
      { id: 'default', label: 'Default' },
      { id: 'deuteranopia', label: 'Deuteranopia' },
      { id: 'protanopia', label: 'Protanopia' },
      { id: 'tritanopia', label: 'Tritanopia' },
    ],
    reduceMotion: false,
    typeScale: 1,
    preferNoFailure: false,
    autosaveHours: 5,
    autosaveOptions: [1, 3, 5, 12, 24],
    ...patch,
  }
}

function newPrisonModel(patch: Partial<NewPrisonModel> = {}): NewPrisonModel {
  return {
    sizePreset: 'medium',
    sizes: [
      { id: 'small', label: 'Small', tiles: 100 },
      { id: 'medium', label: 'Medium', tiles: 160 },
      { id: 'large', label: 'Large', tiles: 220 },
      { id: 'huge', label: 'Huge', tiles: 300 },
    ],
    startingFunds: 30_000,
    continuousIntake: true,
    randomEvents: true,
    firstOrderGrace: true,
    seedInput: '',
    failures: toggles(['escapes', 'insolvency', 'deaths'], true),
    mutators: toggles(['fires', 'contraband'], true),
    ...patch,
  }
}

function onboardingModel(patch: Partial<OnboardingModel> = {}): OnboardingModel {
  return {
    mode: 'guided',
    contractName: 'First Steps',
    objectives: [
      { index: 0, label: 'Build a holding cell', done: false, current: true },
      { index: 1, label: 'Accept your first inmate', done: false, current: false },
    ],
    marks: [],
    viewport: { width: 1194, height: 834 },
    ...patch,
  }
}

function alertsModel(patch: Partial<AlertsModel> = {}): AlertsModel {
  return {
    rows: [
      {
        id: 1,
        severity: 'warn',
        category: 'security',
        categoryLabel: 'Security',
        title: 'Fight in cell block A',
        detail: 'Two inmates fighting',
        count: 1,
        traceId: 100,
        timeLabel: 'Just now',
      },
    ],
    categories: [
      { id: 'general', label: 'General', muted: false, total: 0 },
      { id: 'security', label: 'Security', muted: false, total: 1 },
    ],
    autoPauseOnCritical: false,
    filter: null,
    ...patch,
  }
}

function routineModel(patch: Partial<RoutineModel> = {}): RoutineModel {
  const defaultBlocks: RoutineBlockId[] = Array(24).fill('free')
  return {
    categories: [
      { id: 'min', name: 'Min-sec', blocks: defaultBlocks },
      { id: 'med', name: 'Med-sec', blocks: defaultBlocks },
      { id: 'max', name: 'Max-sec', blocks: defaultBlocks },
    ],
    conflicts: [],
    ...patch,
  }
}

function contractsModel(patch: Partial<ContractsModel> = {}): ContractsModel {
  return {
    active: [
      {
        id: 'grant-1',
        name: 'First Steps',
        description: 'Build your first cell',
        advance: 5000,
        completion: 10000,
        progress: 0.5,
        todos: [
          { id: '1', label: 'Build a holding cell', done: true, current: '1', required: '1' },
          { id: '2', label: 'Accept first inmate', done: false, current: '0', required: '1' },
        ],
        active: true,
        locked: false,
        lockReason: null,
      },
    ],
    available: [
      {
        id: 'grant-2',
        name: 'Expansion',
        description: 'Grow your prison',
        advance: 10000,
        completion: 25000,
        progress: 0,
        todos: [],
        active: false,
        locked: false,
        lockReason: null,
      },
    ],
    maxActive: 3,
    loan: null,
    ...patch,
  }
}

function intakeModel(patch: Partial<IntakeModel> = {}): IntakeModel {
  return {
    continuous: false,
    categories: [
      { id: 'min', name: 'Min-sec', requested: 5, locked: false, lockReason: null },
      { id: 'med', name: 'Med-sec', requested: 0, locked: false, lockReason: null },
      { id: 'max', name: 'Max-sec', requested: 0, locked: true, lockReason: 'No max-sec cells' },
    ],
    capacityModel: {
      population: 10,
      capacity: 50,
      housing: { cells: 40, dormitories: 10, holdingPens: 0 },
    },
    nextBusLabel: 'Tomorrow 08:00',
    nextBusTick: 1440,
    ...patch,
  }
}

function flowModel(patch: Partial<FlowModel> = {}): FlowModel {
  return {
    chains: [
      {
        id: 'meals',
        name: 'Meals',
        healthy: true,
        summary: '150 meals/day',
        stages: [
          { id: 'delivery', name: 'Delivery', capacity: 200, throughput: 150, bottleneck: false, detail: '' },
          { id: 'kitchen', name: 'Kitchen', capacity: 180, throughput: 150, bottleneck: false, detail: '' },
          { id: 'serving', name: 'Serving', capacity: 160, throughput: 150, bottleneck: false, detail: '' },
        ],
      },
    ],
    ...patch,
  }
}

describe('GameShell panel mounting (T8.7)', () => {
  describe('Settings panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} settings={settingsModel()} />)
      try {
        const panel = host.querySelector('.bw-settings-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Settings')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} settings={null} />)
      try {
        const panel = host.querySelector('.bw-settings-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          settings={settingsModel()}
          onSettingsClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-settings-panel .bw-settings-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })

    it('switches tabs', () => {
      const tabs: string[] = []
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          settings={settingsModel()}
          settingsTab="audio"
          onSettingsTab={(tab) => tabs.push(tab)}
        />,
      )
      try {
        const accessTab = [...host.querySelectorAll('.bw-settings-tabs button')].find(
          (b) => b.textContent === 'Accessibility',
        )
        ;(accessTab as HTMLButtonElement | undefined)?.click()
        expect(tabs).toContain('accessibility')
      } finally {
        unmount(host)
      }
    })
  })

  describe('NewPrison screen', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} newPrison={newPrisonModel()} />)
      try {
        const panel = host.querySelector('.bw-newprison')
        expect(panel).not.toBeNull()
        expect(host.textContent).toContain('New prison')
        expect(host.textContent).toContain('Map size')
      } finally {
        unmount(host)
      }
    })

    it('does not render when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} newPrison={null} />)
      try {
        const panel = host.querySelector('.bw-newprison')
        expect(panel).toBeNull()
      } finally {
        unmount(host)
      }
    })

    it('fires start callback', () => {
      let started = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          newPrison={newPrisonModel()}
          onNewPrisonStart={() => {
            started = true
          }}
        />,
      )
      try {
        const startBtn = [...host.querySelectorAll('button')].find((b) =>
          (b.textContent ?? '').includes('Open the prison'),
        )
        ;(startBtn as HTMLButtonElement | undefined)?.click()
        expect(started).toBe(true)
      } finally {
        unmount(host)
      }
    })

    it('fires cancel callback', () => {
      let cancelled = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          newPrison={newPrisonModel()}
          onNewPrisonCancel={() => {
            cancelled = true
          }}
        />,
      )
      try {
        const cancelBtn = [...host.querySelectorAll('button')].find(
          (b) => b.textContent === 'Cancel',
        )
        ;(cancelBtn as HTMLButtonElement | undefined)?.click()
        expect(cancelled).toBe(true)
      } finally {
        unmount(host)
      }
    })
  })

  describe('Onboarding guide', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} onboarding={onboardingModel()} />)
      try {
        const panel = host.querySelector('.bw-onboarding')
        expect(panel).not.toBeNull()
        expect(host.textContent).toContain('First Steps')
        expect(host.textContent).toContain('Build a holding cell')
      } finally {
        unmount(host)
      }
    })

    it('does not render when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} onboarding={null} />)
      try {
        const panel = host.querySelector('.bw-onboarding')
        expect(panel).toBeNull()
      } finally {
        unmount(host)
      }
    })

    it('fires skip callback', () => {
      let skipped = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          onboarding={onboardingModel()}
          onOnboardingSkip={() => {
            skipped = true
          }}
        />,
      )
      try {
        const skipBtn = host.querySelector('.bw-onboarding header button')
        ;(skipBtn as HTMLButtonElement | null)?.click()
        expect(skipped).toBe(true)
      } finally {
        unmount(host)
      }
    })

    it('does not render when mode is off', () => {
      const host = mountShell(
        <GameShell {...baseShellProps()} onboarding={onboardingModel({ mode: 'off' })} />,
      )
      try {
        const panel = host.querySelector('.bw-onboarding')
        expect(panel).toBeNull()
      } finally {
        unmount(host)
      }
    })
  })

  describe('Alerts panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} alerts={alertsModel()} />)
      try {
        const panel = host.querySelector('.bw-alerts-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Alerts')
        expect(host.textContent).toContain('Fight in cell block A')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} alerts={null} />)
      try {
        const panel = host.querySelector('.bw-alerts-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          alerts={alertsModel()}
          onAlertsClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-alerts-panel .bw-alerts-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })

    it('filters by severity', () => {
      const filters: (string | null)[] = []
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          alerts={alertsModel()}
          onAlertsFilter={(severity) => filters.push(severity)}
        />,
      )
      try {
        const criticalTab = [...host.querySelectorAll('.bw-alerts-filters button')].find(
          (b) => b.textContent === 'Critical',
        )
        ;(criticalTab as HTMLButtonElement | undefined)?.click()
        expect(filters).toContain('critical')
      } finally {
        unmount(host)
      }
    })
  })
})

describe('GameShell panel mounting (T8.9)', () => {
  describe('Routine panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} routine={routineModel()} />)
      try {
        const panel = host.querySelector('.bw-routine-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Routine')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} routine={null} />)
      try {
        const panel = host.querySelector('.bw-routine-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          routine={routineModel()}
          onRoutineClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-routine-panel .bw-routine-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })
  })

  describe('Contracts panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} contracts={contractsModel()} />)
      try {
        const panel = host.querySelector('.bw-contracts-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Contracts')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} contracts={null} />)
      try {
        const panel = host.querySelector('.bw-contracts-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          contracts={contractsModel()}
          onContractsClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-contracts-panel .bw-contracts-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })
  })

  describe('Intake panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} intake={intakeModel()} />)
      try {
        const panel = host.querySelector('.bw-intake-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Intake')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} intake={null} />)
      try {
        const panel = host.querySelector('.bw-intake-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          intake={intakeModel()}
          onIntakeClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-intake-panel .bw-intake-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })
  })

  describe('Flow panel', () => {
    it('mounts when model is provided', () => {
      const host = mountShell(<GameShell {...baseShellProps()} flow={flowModel()} />)
      try {
        const panel = host.querySelector('.bw-flow-panel')
        expect(panel).not.toBeNull()
        expect(panel?.getAttribute('data-open')).toBe('true')
        expect(host.textContent).toContain('Logistics')
      } finally {
        unmount(host)
      }
    })

    it('stays hidden when model is null', () => {
      const host = mountShell(<GameShell {...baseShellProps()} flow={null} />)
      try {
        const panel = host.querySelector('.bw-flow-panel')
        expect(panel?.getAttribute('data-open')).toBe('false')
      } finally {
        unmount(host)
      }
    })

    it('fires close callback when back button is clicked', () => {
      let closed = false
      const host = mountShell(
        <GameShell
          {...baseShellProps()}
          flow={flowModel()}
          onFlowClose={() => {
            closed = true
          }}
        />,
      )
      try {
        const backBtn = host.querySelector('.bw-flow-panel .bw-flow-head button')
        ;(backBtn as HTMLButtonElement | null)?.click()
        expect(closed).toBe(true)
      } finally {
        unmount(host)
      }
    })
  })
})
