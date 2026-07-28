import path from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The import boundary rules in PRD 7.2 are a build-breaking guarantee, so they
 * get a test rather than a convention. Each case lints a synthetic file at a
 * real path inside the relevant package and asserts on the reported rule ids.
 */

const repoRoot = path.resolve(import.meta.dirname, '..')

let eslint: ESLint

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot })
})

async function ruleIdsFor(relativePath: string, source: string): Promise<string[]> {
  const results = await eslint.lintText(source, {
    filePath: path.join(repoRoot, relativePath),
  })

  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? 'fatal')
}

/**
 * The first case pays for the whole suite: ESLint's typed resolver builds a
 * TypeScript program for the workspace on the first `lintText`, and that grows
 * with the codebase. Vitest's 5s default is a limit on the compiler's cold
 * start rather than on anything this test does, so it gets its own.
 */
const LINT_TIMEOUT_MS = 60_000

describe('import boundaries (PRD 7.2)', { timeout: LINT_TIMEOUT_MS }, () => {
  it('rejects a value import of render from sim', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/sim/src/boundary-case.ts',
      "import { TILE_SIZE } from '@blockwork/render'\nexport const x = TILE_SIZE\n",
    )

    expect(ruleIds).toContain('@typescript-eslint/no-restricted-imports')
    expect(ruleIds).toContain('import/no-restricted-paths')
  })

  it('rejects a type-only import of ui from sim, because sim may not reach ui at all', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/sim/src/boundary-case.ts',
      "import type { MIN_HIT_TARGET_PT } from '@blockwork/ui'\nexport type X = typeof MIN_HIT_TARGET_PT\n",
    )

    expect(ruleIds).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('rejects a deep relative escape out of sim into render', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/sim/src/boundary-case.ts',
      "import { TILE_SIZE } from '../../render/src/index'\nexport const x = TILE_SIZE\n",
    )

    expect(ruleIds).toContain('import/no-restricted-paths')
  })

  it('rejects a value import of sim from render', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/render/src/boundary-case.ts',
      "import { TICKS_PER_MINUTE } from '@blockwork/sim'\nexport const x = TICKS_PER_MINUTE\n",
    )

    expect(ruleIds).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('allows a type-only import of sim from render', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/render/src/boundary-case.ts',
      "import type { TICKS_PER_MINUTE } from '@blockwork/sim'\nexport type X = typeof TICKS_PER_MINUTE\n",
    )

    expect(ruleIds).toEqual([])
  })

  it('allows a type-only import of sim from ui', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/ui/src/boundary-case.ts',
      "import type { TICKS_PER_MINUTE } from '@blockwork/sim'\nexport type X = typeof TICKS_PER_MINUTE\n",
    )

    expect(ruleIds).toEqual([])
  })

  it('rejects importing app from anywhere', async () => {
    for (const pkg of ['sim', 'render', 'ui', 'data']) {
      const ruleIds = await ruleIdsFor(
        `packages/${pkg}/src/boundary-case.ts`,
        "import { thing } from '@blockwork/app'\nexport const x = thing\n",
      )

      expect(ruleIds, `packages/${pkg} must not import app`).toContain(
        '@typescript-eslint/no-restricted-imports',
      )
    }
  })

  it('rejects Math.random inside sim (CLAUDE.md rule 3)', async () => {
    const ruleIds = await ruleIdsFor(
      'packages/sim/src/boundary-case.ts',
      'export const x = Math.random()\n',
    )

    expect(ruleIds).toContain('no-restricted-properties')
  })
})
