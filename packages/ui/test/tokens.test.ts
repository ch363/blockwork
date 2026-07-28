/**
 * Tokens must match `docs/04-ui-mockups.html` verbatim (T2.9).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOKEN_VALUES } from '../src/index'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const MOCKUP = readFileSync(join(ROOT, 'docs/04-ui-mockups.html'), 'utf8')

describe('design tokens', () => {
  it('every token value appears in the mockup :root block', () => {
    for (const [name, value] of Object.entries(TOKEN_VALUES)) {
      expect(MOCKUP, `missing --${name}: ${value}`).toContain(`--${name}`)
      // Soft colours carry an alpha suffix the mockup writes without a space.
      expect(MOCKUP, `value drift for --${name}`).toContain(value)
    }
  })
})
