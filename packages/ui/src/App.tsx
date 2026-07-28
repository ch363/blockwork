/**
 * UI application root (T2.9).
 *
 * Wraps `GameShell` with the Mac / external-keyboard speed fallback. The host
 * still owns session state; this file is the seam between keyboard and the
 * speed segmented control so a panel test never needs a `Session`.
 */

import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { speedFromKeyboard } from './controls/speedKeys'
import { GameShell } from './GameShell'
import type { GameShellProps } from './GameShell'
import type { SpeedStop } from './panels/TopBar'

export type AppProps = GameShellProps

/**
 * The shell plus Space / 0–4 speed keys.
 *
 * Undo (Cmd/Ctrl+Z) and Escape stay in the host — they reach into session
 * methods this package must not know about.
 */
export function App(props: AppProps): JSX.Element {
  const resumeSpeed = useRef<SpeedStop>(props.speed === 0 ? 1 : props.speed)
  const speed = props.speed
  const onSpeed = props.onSpeed

  useEffect(() => {
    if (speed !== 0) resumeSpeed.current = speed
  }, [speed])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const result = speedFromKeyboard(event, {
        speed,
        resumeSpeed: resumeSpeed.current,
      })
      if (result === null) return

      event.preventDefault()
      resumeSpeed.current = result.resumeSpeed
      onSpeed(result.speed)
    }

    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [speed, onSpeed])

  return <GameShell {...props} />
}
