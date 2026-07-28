/**
 * The icon set.
 *
 * The mockups draw their icons as HTML entities and emoji — `&#9974;` for
 * Build, `&#128712;` for Objects. That is the right call for a static visual
 * spec and the wrong one for the product: emoji render in the platform's own
 * colours and its own weight, so a dock of them is a row of mismatched
 * pictures at mismatched optical sizes, and on iPadOS half of them arrive
 * full-colour whatever the surrounding text says. It is the single loudest
 * "unfinished" tell an interface can have.
 *
 * So: one geometric set, drawn on a 24-unit grid, stroked rather than filled,
 * inheriting `currentColor` so a token decides the colour and the active state
 * costs nothing. Stroke width is 1.75 — 1.5 goes thin and grey at 22px on a
 * retina panel, 2 goes blunt.
 *
 * They are paths rather than a font because a font is a binary asset to host,
 * subset and cache-bust for eleven glyphs, and because CLAUDE.md rule 1 is
 * easiest to keep when there is no third-party artwork anywhere near the
 * repository.
 */

import type { JSX } from 'preact'

/**
 * Path data per icon, on a 24x24 grid.
 *
 * An entry is one or more `d` strings. Splitting a glyph into several paths is
 * how a shape gets a closed outline and an open detail without either one
 * inheriting the other's fill rule.
 */
const PATHS = {
  /* --- dock --- */
  /** Build: a set square over a baseline. */
  build: ['M3 20h18', 'M6 20V8l12 12'],
  /** Rooms: a plan with one wing partitioned off. */
  rooms: ['M3 4h18v16H3z', 'M10 4v16', 'M10 12h11'],
  /** Objects: an isometric crate. */
  objects: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  /** Utilities: a bolt. */
  utilities: ['M13 2L5 13h6l-1 9 8-11h-6l1-9z'],
  /** Staff: a figure. */
  staff: ['M12 11a4 4 0 100-8 4 4 0 000 8z', 'M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1'],
  /** Posts: a post marker with a coverage ring. */
  posts: ['M12 12a3 3 0 100-6 3 3 0 000 6z', 'M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z'],
  /** Flow: two lanes running opposite ways. */
  flow: ['M4 8h13l-3-3', 'M20 16H7l3 3'],
  /** Plan: a pencil over a sheet. */
  plan: ['M4 20h4l10-10-4-4L4 16v4z', 'M14 6l4 4'],
  /** Reports: a bar chart. */
  reports: ['M4 20h16', 'M7 20v-6', 'M12 20V6', 'M17 20v-9'],
  /** Overlay: stacked sheets. */
  overlay: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  /** Emergency: an alarm bell mid-ring. */
  emergency: [
    'M18 15V10a6 6 0 10-12 0v5l-2 3h16l-2-3z',
    'M10.5 21a2 2 0 003 0',
    'M2.5 7.5a7 7 0 013-3',
    'M21.5 7.5a7 7 0 00-3-3',
  ],

  /* --- top bar --- */
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['M8 5l11 7-11 7V5z'],
  alerts: ['M18 15V10a6 6 0 10-12 0v5l-2 3h16l-2-3z', 'M10.5 21a2 2 0 003 0'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  undo: ['M4 10h10a5 5 0 010 10h-4', 'M8 6l-4 4 4 4'],
  redo: ['M20 10H10a5 5 0 000 10h4', 'M16 6l4 4-4 4'],
  save: ['M5 4h11l3 3v13H5z', 'M9 4v5h6V4', 'M8 20v-6h8v6'],

  /* --- build palette --- */
  foundation: ['M3 7h18v13H3z', 'M3 12h18', 'M9 12v8', 'M15 12v8'],
  wall: ['M3 6h18v12H3z', 'M3 12h18', 'M9 6v6', 'M15 12v6'],
  floor: ['M3 5h18v14H3z', 'M3 9.7h18', 'M3 14.3h18', 'M9 5v14', 'M15 5v14'],
  door: ['M6 3h12v18H6z', 'M14.5 12h.01'],
  demolish: ['M4 8l6-4 10 6-2 3-4-2-2 3-4-2-2 3-2-7z', 'M4 20h16'],
  select: ['M6 3l12 8-5 1.5 3.5 6-2.5 1.5-3.5-6L6 17V3z'],

  /* --- states --- */
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M4.5 12.5l5 5 10-11'],
  warning: ['M12 3l9.5 17H2.5L12 3z', 'M12 10v4.5', 'M12 17.6h.01'],
  chevronRight: ['M9.5 5l7 7-7 7'],
  power: ['M12 3v9', 'M6.5 6.5a8 8 0 1011 0'],
  water: ['M12 3s6 6.6 6 10.5a6 6 0 11-12 0C6 9.6 12 3 12 3z'],
  search: ['M11 18a7 7 0 100-14 7 7 0 000 14z', 'M16.2 16.2L21 21'],
} as const

export type IconName = keyof typeof PATHS

export const ICON_NAMES = Object.keys(PATHS) as readonly IconName[]

export interface IconProps {
  readonly name: IconName
  /** Edge length in px. The grid is 24, so 24 is 1:1. */
  readonly size?: number
  /**
   * Accessible name. Omit for an icon beside its own label — the label is the
   * name, and repeating it makes a screen reader say everything twice.
   */
  readonly title?: string
}

/**
 * One icon, inheriting `currentColor` and the surrounding font's optical size.
 *
 * `vector-effect: non-scaling-stroke` is deliberate: an icon scaled to 22 or
 * 28px keeps a 1.75px stroke either way, so a dock and an inspector agree on
 * weight without maintaining two sets.
 */
export function Icon({ name, size = 24, title }: IconProps): JSX.Element {
  const paths = PATHS[name]

  return (
    <svg
      class="ico-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title === undefined ? 'true' : undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
    >
      {title === undefined ? null : <title>{title}</title>}
      {paths.map((d) => (
        <path key={d} d={d} vector-effect="non-scaling-stroke" />
      ))}
    </svg>
  )
}
