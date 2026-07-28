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

import { loadGameData } from '@blockwork/sim'
import { injectShellCss } from '@blockwork/ui'
import { render } from 'preact'

import { App } from './App'
import { Session } from './game/session'

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

async function boot(): Promise<void> {
  injectShellCss(document)

  const data = loadGameData()

  const session = await Session.create({ parent: root, data })

  render(<App session={session} />, root)

  // Capacitor and Safari both fire this when the app goes to the background;
  // the worker's own catch-up clamp handles the resume, and pausing here means
  // a backgrounded prison is not silently running at 20x on someone's battery.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') session.setSpeed(0)
  })
}

try {
  await boot()
} catch (error) {
  fail(error, 'startup')
}
