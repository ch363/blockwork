/**
 * Mac / external-keyboard fallback for the speed segmented control (PRD 2.3).
 *
 * Touch is primary; these bindings never replace the on-screen control. Space
 * toggles pause against the last non-zero speed so a second press resumes at
 * the rate the player was on, rather than always jumping to 1x.
 */

import { SPEED_STOPS } from '../panels/TopBar'
import type { SpeedStop } from '../panels/TopBar'

const DIGIT_SPEED: Readonly<Record<string, SpeedStop>> = {
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 5,
  '4': 20,
}

export interface SpeedKeyState {
  readonly speed: SpeedStop
  /** Last non-zero stop, for Space resume. */
  readonly resumeSpeed: SpeedStop
}

export interface SpeedKeyResult {
  readonly speed: SpeedStop
  readonly resumeSpeed: SpeedStop
}

/**
 * Maps a keydown to a new speed, or `null` when the key is not a speed shortcut.
 *
 * Ignores events with meta/ctrl/alt so Cmd+1 stays with the host (undo etc.).
 */
export function speedFromKeyboard(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  state: SpeedKeyState,
): SpeedKeyResult | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null

  if (event.key === ' ' || event.key === 'Spacebar') {
    if (state.speed === 0) {
      return { speed: state.resumeSpeed, resumeSpeed: state.resumeSpeed }
    }
    return { speed: 0, resumeSpeed: state.speed }
  }

  const digit = DIGIT_SPEED[event.key]
  if (digit === undefined) return null

  return {
    speed: digit,
    resumeSpeed: digit === 0 ? state.resumeSpeed : digit,
  }
}

/** The stop after `current` on the ladder, wrapping pause → 20x → pause. */
export function cycleSpeed(current: SpeedStop): SpeedStop {
  const index = SPEED_STOPS.indexOf(current)
  const next = SPEED_STOPS[(index + 1) % SPEED_STOPS.length]
  return next ?? 1
}
