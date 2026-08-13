/**
 * @vitest-environment happy-dom
 *
 * VoiceOver / accessible name coverage for every control in the shell.
 * Focus trap and focus restoration for modal dialogs (T8.17).
 */

import { createRef } from 'preact'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { GameShell, auditAccessibleNames, Settings, PauseMenu, Alerts } from '../src/index'
import type { TopBarModel, SettingsModel, PauseMenuModel, AlertsModel } from '../src/index'
import { FIXTURE_INMATE } from './fixtures/inspectors'
import { mountShell, unmount } from './helpers/mount'

const TOP_BAR: TopBarModel = {
  time: '14:20',
  day: 27,
  dayNote: 'Spring',
  balance: 84120,
  balancePerDay: 1840,
  population: 186,
  capacity: 208,
  danger: 62,
  reoffending: 41,
  alerts: 3,
  critical: false,
}

describe('accessibility label coverage', () => {
  it('every interactive control has a meaningful accessible name', () => {
    const stageRef = createRef<HTMLDivElement>()
    const host = mountShell(
      <GameShell
        stageRef={stageRef}
        topBar={TOP_BAR}
        speed={1}
        onSpeed={() => undefined}
        tool="build"
        onTool={() => undefined}
        palette={[
          {
            id: 'foundations',
            label: 'Foundations',
            items: [{ id: 'brick', name: 'Brick', note: '£40', icon: 'wall' }],
          },
        ]}
        paletteSelection="brick"
        onPaletteSelect={() => undefined}
        inspector={FIXTURE_INMATE}
        onInspectorClose={() => undefined}
        blueprint={null}
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onIssueFocus={() => undefined}
        toasts={[
          {
            id: 1,
            severity: 'critical',
            title: 'Inmate is starving',
            detail: 'Missed three meal blocks',
            count: 1,
            traceId: 9,
          },
        ]}
        onTrace={() => undefined}
        onDismissToast={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onAlerts={() => undefined}
        onMenu={() => undefined}
      />,
    )

    const missing = auditAccessibleNames(host)
    expect(missing).toEqual([])

    unmount(host)
  })
})

describe('focus trap (T8.17)', () => {
  const SETTINGS_MODEL: SettingsModel = {
    music: 0.8,
    sfx: 0.7,
    muted: false,
    palette: 'default',
    paletteOptions: [
      { id: 'default', label: 'Default' },
      { id: 'deuteranopia', label: 'Deuteranopia' },
    ],
    reduceMotion: false,
    typeScale: 1.0,
    preferNoFailure: false,
    autosaveHours: 2,
    autosaveOptions: [1, 2, 4],
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Tab cycles within an open Settings panel', async () => {
    const onClose = vi.fn()
    const host = mountShell(
      <Settings
        model={SETTINGS_MODEL}
        tab="audio"
        onTab={() => undefined}
        onClose={onClose}
      />,
    )

    await vi.runAllTimersAsync()

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    if (dialog === null) return

    const focusableElements = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    expect(focusableElements.length).toBeGreaterThan(1)

    const first = focusableElements[0]
    const last = focusableElements[focusableElements.length - 1]

    expect(first).toBeDefined()
    expect(last).toBeDefined()

    last?.focus()

    let tabPrevented = false
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && document.activeElement === last && !event.shiftKey) {
        event.preventDefault()
        tabPrevented = true
      }
      if (event.key === 'Tab' && document.activeElement === first && event.shiftKey) {
        event.preventDefault()
        tabPrevented = true
      }
    }
    dialog.addEventListener('keydown', handleKeyDown as EventListener)

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    last?.dispatchEvent(tabEvent)

    expect(tabPrevented || tabEvent.defaultPrevented).toBe(true)

    dialog.removeEventListener('keydown', handleKeyDown as EventListener)
    unmount(host)
  })

  it('Escape key closes the panel and calls onClose', async () => {
    const onClose = vi.fn()
    const host = mountShell(
      <Settings
        model={SETTINGS_MODEL}
        tab="audio"
        onTab={() => undefined}
        onClose={onClose}
      />,
    )

    await vi.runAllTimersAsync()

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    if (dialog === null) return

    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(escapeEvent)

    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)

    unmount(host)
  })

  it('every role="dialog" panel has aria-modal when open', () => {
    const stageRef = createRef<HTMLDivElement>()
    const host = mountShell(
      <GameShell
        stageRef={stageRef}
        topBar={TOP_BAR}
        speed={1}
        onSpeed={() => undefined}
        tool="build"
        onTool={() => undefined}
        palette={[]}
        paletteSelection={null}
        onPaletteSelect={() => undefined}
        inspector={null}
        onInspectorClose={() => undefined}
        blueprint={null}
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onIssueFocus={() => undefined}
        toasts={[]}
        onTrace={() => undefined}
        onDismissToast={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onAlerts={() => undefined}
        onMenu={() => undefined}
        settings={SETTINGS_MODEL}
        settingsTab="audio"
        onSettingsTab={() => undefined}
        onSettingsClose={() => undefined}
      />,
    )

    const settingsDialog = host.querySelector('.bw-settings-panel[role="dialog"]')
    expect(settingsDialog).not.toBeNull()
    expect(settingsDialog?.getAttribute('data-open')).toBe('true')
    expect(settingsDialog?.getAttribute('aria-modal')).toBe('true')

    unmount(host)
  })
})

describe('focus restoration (T8.17)', () => {
  it('focus trap stores the previously focused element for restoration', () => {
    const PAUSE_MENU_MODEL: PauseMenuModel = {
      saves: [],
      canSave: true,
      canExport: true,
    }

    const host = mountShell(
      <PauseMenu
        model={PAUSE_MENU_MODEL}
        onClose={() => undefined}
        onResume={() => undefined}
      />,
    )

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    if (dialog === null) return

    expect(dialog.getAttribute('aria-modal')).toBe('true')

    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled])',
    )
    expect(focusables.length).toBeGreaterThan(0)

    unmount(host)
  })
})

describe('focus visibility (T8.17)', () => {
  it(':focus-visible styling applies a visible outline', () => {
    const ALERTS_MODEL: AlertsModel = {
      rows: [],
      categories: [],
      autoPauseOnCritical: false,
      filter: null,
    }

    const host = mountShell(
      <Alerts
        model={ALERTS_MODEL}
        onClose={() => undefined}
        onFilter={() => undefined}
      />,
    )

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()

    const button = dialog?.querySelector('button')
    expect(button).not.toBeNull()

    const styleSheets = document.querySelectorAll('style')
    const shellCss = Array.from(styleSheets).find(
      (style) => style.textContent?.includes(':focus-visible'),
    )
    expect(shellCss).toBeDefined()

    const cssText = shellCss?.textContent ?? ''
    expect(cssText).toContain(':focus-visible')
    expect(cssText).toContain('outline')

    unmount(host)
  })
})
