/**
 * Layout constants measured against the mockup at 1194×834 (PRD 6.1).
 *
 * These are the numbers the layout snapshot test compares against. They come
 * from `docs/04-ui-mockups.html` and `TOKENS.layout` — not invented here.
 */

import { TOKENS } from '../theme/tokens'

/** Reference device size from the mockup frame label. */
export const REFERENCE_WIDTH = 1194
export const REFERENCE_HEIGHT = 834

/** Parsed layout tokens, as numbers the DOM geometry tests can compare. */
export const LAYOUT = {
  topBarHeight: Number.parseInt(TOKENS.layout['topbar-h'], 10),
  dockHeight: Number.parseInt(TOKENS.layout['dock-h'], 10),
  trayHeight: Number.parseInt(TOKENS.layout['tray-h'], 10),
  inspectorWidth: Number.parseInt(TOKENS.layout['inspector-w'], 10),
  hitMin: Number.parseInt(TOKENS.layout['hit-min'], 10),
  avatarSize: Number.parseInt(TOKENS.space.s9, 10),
  /** Mockup `.speed` visual chrome; hit target is still `--hit-min`. */
  speedChromeHeight: 40,
  toolWidth: 76,
  toolHeight: 68,
} as const

/** Acceptance: measured element within this many CSS pixels of the mockup. */
export const LAYOUT_TOLERANCE_PX = 2
