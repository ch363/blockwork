/**
 * The design tokens, lifted verbatim from `docs/04-ui-mockups.html`.
 *
 * That file says of its own `:root` block: "This block is the source of truth.
 * Extract verbatim into packages/ui/src/theme/tokens.ts. Do not invent values
 * elsewhere." This is that file, and the instruction is worth restating,
 * because the failure mode it prevents is subtle. A panel that hard-codes
 * `#2C3441` looks right the day it is written and wrong the day the surface
 * ramp is retuned, and nothing catches it: there is no test for "this grey is
 * the wrong grey". Every colour, space, radius and type size a component uses
 * must be a `var(--token)` naming one of the entries below.
 *
 * The values live here as data rather than as a CSS string so they can be read
 * from TypeScript too — the renderer needs the terrain colours as numbers, and
 * a legend swatch needs to name a colour it is not painting itself.
 * `themeCss()` is what turns them into the `:root` block a document wants.
 */

/** Every token, grouped the way the mockup groups them. */
export const TOKENS = {
  surfaces: {
    'bg-void': '#0D1015',
    'bg-app': '#12161C',
    'surface-1': '#1A1F27',
    'surface-2': '#222834',
    'surface-3': '#2C3441',
    'surface-4': '#384252',
    'border-subtle': '#2A313D',
    border: '#39424F',
    'border-strong': '#4B5666',
  },

  text: {
    'text-hi': '#E9EDF3',
    text: '#C4CCD8',
    'text-dim': '#8D98A8',
    'text-faint': '#626D7C',
    'text-on-accent': '#14181E',
  },

  semantic: {
    accent: '#F0A93B',
    'accent-press': '#D2902A',
    'accent-soft': '#F0A93B26',
    info: '#4C9BE8',
    'info-soft': '#4C9BE826',
    ok: '#4FB477',
    'ok-soft': '#4FB47726',
    warn: '#E8A33D',
    'warn-soft': '#E8A33D26',
    danger: '#E05C5C',
    'danger-soft': '#E05C5C26',
    research: '#9B7BD4',
  },

  /** Inmate security categories. Also the uniform tint (PRD 7.7). */
  categories: {
    'cat-min': '#8B93A0',
    'cat-med': '#E08B3D',
    'cat-max': '#D95151',
    'cat-supermax': '#9B4DCA',
    'cat-protective': '#4C9BE8',
    'cat-condemned': '#1D222A',
  },

  needs: {
    'need-ok': '#4FB477',
    'need-medium': '#D6C24A',
    'need-high': '#E8A33D',
    'need-critical': '#E05C5C',
    'need-active': '#4C9BE8',
  },

  /** The renderer must use these (mockup's words). */
  world: {
    'terrain-grass': '#3A5040',
    'terrain-mud': '#4A4034',
    'terrain-road': '#2F343B',
    'terrain-paving': '#3F4550',
    'floor-concrete': '#4A5261',
    'floor-tile': '#58616F',
    'floor-wood': '#6A5844',
    'floor-track': '#6B4B3C',
    'wall-interior': '#757E8D',
    'wall-shadow': '#4C5462',
    'wall-perimeter': '#5A6270',
    fence: '#6E7A88',
    door: '#A9805A',
    'door-secure': '#7E8B9B',
  },

  /** 4pt base. */
  space: {
    s1: '4px',
    s2: '8px',
    s3: '12px',
    s4: '16px',
    s5: '20px',
    s6: '24px',
    s7: '32px',
    s8: '40px',
    s9: '56px',
  },

  radii: {
    'r-sm': '6px',
    'r-md': '10px',
    'r-lg': '14px',
    'r-xl': '20px',
    'r-pill': '999px',
  },

  elevation: {
    e1: '0 1px 2px rgba(0,0,0,.35)',
    e2: '0 4px 14px rgba(0,0,0,.40)',
    e3: '0 12px 36px rgba(0,0,0,.50)',
  },

  /** pt on iPad, px 1:1 in a browser. */
  type: {
    'f-micro': '10px',
    'f-cap': '11px',
    'f-sm': '13px',
    'f-body': '15px',
    'f-lg': '17px',
    'f-xl': '20px',
    'f-2xl': '28px',
    'f-3xl': '34px',
  },

  layout: {
    'topbar-h': '56px',
    'dock-h': '88px',
    'tray-h': '92px',
    'inspector-w': '360px',
    /** NEVER go below this for any interactive element (PRD 2.3). */
    'hit-min': '44px',
  },
} as const

type TokenGroup = (typeof TOKENS)[keyof typeof TOKENS]

/** Flattened `name -> value`, ignoring the grouping. */
export const TOKEN_VALUES: Readonly<Record<string, string>> = Object.assign(
  {},
  ...(Object.values(TOKENS) as TokenGroup[]),
) as Record<string, string>

/** The value of one token, by name. Throws on a name that does not exist. */
export function token(name: string): string {
  const value = TOKEN_VALUES[name]
  if (value === undefined) throw new Error(`unknown design token '${name}'`)
  return value
}

/** `var(--name)`, for building an inline style honestly. */
export function tokenVar(name: string): string {
  // Resolved first, so a typo fails here rather than rendering transparent.
  token(name)
  return `var(--${name})`
}

/**
 * A colour token as a 24-bit number, for the renderer.
 *
 * Pixi wants `0x4a5261`, the mockup writes `#4A5261`, and the two must not be
 * allowed to drift apart by being typed twice. Alpha-carrying tokens — the
 * `-soft` fills — are rejected rather than silently truncated.
 */
export function tokenHex(name: string): number {
  const value = token(name)
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`token '${name}' is not an opaque colour: ${value}`)
  }
  return Number.parseInt(value.slice(1), 16)
}

/** The `:root` custom-property block. */
export function themeCss(): string {
  const lines = Object.entries(TOKEN_VALUES).map(([name, value]) => `  --${name}: ${value};`)
  return `:root {\n${lines.join('\n')}\n}`
}
