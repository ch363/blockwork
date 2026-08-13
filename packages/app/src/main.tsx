/**
 * The composition root. This is the only module allowed to know about every
 * package at once (PRD 7.2).
 *
 * Boot order matters and is not arbitrary:
 *
 *   1. **Game data first.** `loadGameData` validates every definition file and
 *      cross-checks the references between them (T1.1). If it throws, nothing
 *      else is worth starting, and the failure is a content bug with a precise
 *      path in its message — far better shown as itself than as whatever the
 *      renderer would do with a missing material.
 *   2. **Then the session**, which spawns the worker and negotiates a GPU
 *      context. The worker boots in parallel with the renderer's `init`,
 *      because neither waits on the other.
 *   3. **Then Preact**, over a canvas that already exists. The shell adopts
 *      the canvas rather than creating one, so a re-render can never take the
 *      GPU context with it.
 *
 * Any failure along the way replaces the app with the reason. A blank dark
 * rectangle is the least useful thing a boot failure can produce, and it is
 * exactly what an unhandled rejection in an async module gives you.
 */

import { loadGameData, TICKS_PER_HOUR } from '@blockwork/sim'
import { injectShellCss } from '@blockwork/ui'
import { render } from 'preact'

import { App } from './App'
import { installCapacitorLifecycle } from './game/capacitor'
import { Session } from './game/session'
import {
  APP_SETTINGS_KEY,
  parseAppSettings,
  settingsCssVariables,
  type AppSettings,
} from './game/appSettings'

const mountPoint = document.querySelector('#root')
if (!(mountPoint instanceof HTMLElement)) {
  throw new Error('Blockwork: #root element is missing from index.html')
}
// Re-bound so the narrowing survives into the closures below.
const root: HTMLElement = mountPoint

/** Shows a boot failure as text, because there is no UI left to show it in. */
function fail(error: unknown, stage: string): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Blockwork failed to start (${stage})`, error)

  root.textContent = ''
  const panel = document.createElement('pre')
  panel.className = 'bw-boot-error'
  panel.textContent = `Blockwork could not start.\n\n${stage}\n\n${message}`
  root.appendChild(panel)
}

/** Applies app settings as CSS variables on the document root. */
function applySettingsCss(settings: AppSettings): void {
  const vars = settingsCssVariables(settings)
  for (const [key, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(key, value)
  }
}

/** Loads settings from localStorage, falling back to defaults defensively. */
function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY)
    return parseAppSettings(raw === null ? null : JSON.parse(raw))
  } catch {
    return parseAppSettings(null)
  }
}

/** Persists settings to localStorage. */
function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Quota exceeded or private mode — the setting still takes effect this run.
  }
}

/**
 * Installs global error handlers (T8.15).
 *
 * Captures uncaught errors and unhandled promise rejections so they surface
 * visibly rather than silently failing or blanking the screen.
 */
function installGlobalErrorHandlers(session: { reportRuntimeError: (message: string) => void }): void {
  window.onerror = (
    message: string | Event,
    _source?: string,
    _lineno?: number,
    _colno?: number,
    error?: Error,
  ): boolean => {
    const text = error?.message ?? (typeof message === 'string' ? message : 'Unknown error')
    console.error('Blockwork uncaught error:', error ?? message)
    session.reportRuntimeError(text)
    return true
  }

  window.onunhandledrejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    console.error('Blockwork unhandled rejection:', reason)
    session.reportRuntimeError(message)
  }
}

async function boot(): Promise<void> {
  injectShellCss(document)

  const data = loadGameData()

  // Load and apply stored settings before any rendering.
  const initialSettings = loadSettings()
  applySettingsCss(initialSettings)

  const session = await Session.create({ parent: root, data })

  // Install global error handlers now that we have a session to report to.
  installGlobalErrorHandlers(session)

  // Wire settings changes from session back to persistence and CSS.
  session.onSettingsChange = (settings: AppSettings) => {
    applySettingsCss(settings)
    saveSettings(settings)

    // Route colour-blind palette through the renderer's overlay palette (T8.8).
    const paletteId = settings.accessibility.palette === 'default'
      ? 'standard'
      : settings.accessibility.palette
    session.setOverlayPalette(paletteId)
  }

  // Apply initial settings to renderer overlay palette.
  if (initialSettings.accessibility.palette !== 'default') {
    session.setOverlayPalette(initialSettings.accessibility.palette)
  }

  // Initialize audio engine with stored settings (T8.8).
  session.initAudio(initialSettings.audio)

  // Initialize session with full settings for autosave scheduling.
  session.applyAppSettings(initialSettings)

  render(<App session={session} />, root)

  // Timed autosave: fires every autosaveHours of in-game time (PRD 3.10).
  // Separate from the visibilitychange autosave which handles backgrounding.
  let lastAutosaveTick = 0
  const checkTimedAutosave = (): void => {
    const currentTick = session.bridge.latestSnapshot()?.tick ?? 0
    const autosaveIntervalTicks = session.autosaveHours * TICKS_PER_HOUR
    if (currentTick - lastAutosaveTick >= autosaveIntervalTicks) {
      lastAutosaveTick = currentTick
      void session.autosave()
    }
  }

  // Check for timed autosave once per second.
  setInterval(checkTimedAutosave, 1000)

  // Capacitor and Safari both fire this when the app goes to the background;
  // the worker's own catch-up clamp handles the resume, and pausing here means
  // a backgrounded prison is not silently running at 20x on someone's battery.
  // Autosave runs on the same signal (PRD 7.4) so a killed tab still has a
  // recent capture.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      session.setSpeed(0)
      void session.autosave()
    }
  })

  // Capacitor lifecycle handlers for iPadOS (T8.21).
  // Handles native app state changes. On web this is a no-op; the
  // visibilitychange handler above is sufficient.
  void installCapacitorLifecycle({
    onBackground: async () => {
      session.setSpeed(0)
      await session.autosave()
    },
    onForeground: () => {
      // Resume handled by player; don't auto-resume speed on foreground.
    },
  })
}

try {
  await boot()
} catch (error) {
  fail(error, 'startup')
}
