import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'
import { config, configs } from 'typescript-eslint'

/**
 * Import boundary rules, from PRD 7.2:
 *
 *   - sim may not import from render, ui or app
 *   - render may import from sim for types only (`import type`)
 *   - ui may import from sim for types only
 *   - nothing imports from app
 *
 * Enforced twice over, because the two mechanisms fail in different ways.
 *
 *   1. `@typescript-eslint/no-restricted-imports` matches the bare package
 *      specifier (`@blockwork/render`). It needs no module resolution, so it
 *      cannot be defeated by a resolver misconfiguration, and it understands
 *      `import type` via `allowTypeImports`.
 *   2. `import/no-restricted-paths` matches the resolved file path, which
 *      catches deep relative escapes such as `../../render/src/thing`.
 */

const PKG = {
  sim: '@blockwork/sim',
  render: '@blockwork/render',
  ui: '@blockwork/ui',
  app: '@blockwork/app',
}

/** Both the bare specifier and any subpath of it. */
const specifiers = (name) => [name, `${name}/*`]

const NO_APP = {
  group: specifiers(PKG.app),
  message: 'PRD 7.2: nothing may import from @blockwork/app.',
}

const SIM_TYPES_ONLY = {
  group: specifiers(PKG.sim),
  allowTypeImports: true,
  message: "PRD 7.2: import from @blockwork/sim for types only ('import type').",
}

/** @type {import('eslint').Linter.Config['rules']} */
const boundaryPathRules = {
  'import/no-restricted-paths': [
    'error',
    {
      zones: [
        {
          target: './packages/sim',
          from: './packages/render',
          message: 'PRD 7.2: sim may not import from render.',
        },
        {
          target: './packages/sim',
          from: './packages/ui',
          message: 'PRD 7.2: sim may not import from ui.',
        },
        {
          target: './packages/sim',
          from: './packages/app',
          message: 'PRD 7.2: sim may not import from app.',
        },
        {
          target: './packages/render',
          from: './packages/app',
          message: 'PRD 7.2: nothing may import from app.',
        },
        {
          target: './packages/ui',
          from: './packages/app',
          message: 'PRD 7.2: nothing may import from app.',
        },
        {
          target: './packages/data',
          from: './packages/app',
          message: 'PRD 7.2: nothing may import from app.',
        },
        {
          target: './tools',
          from: './packages/app',
          message: 'PRD 7.2: nothing may import from app.',
        },
      ],
    },
  ],
}

export default config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'docs/**'],
  },

  js.configs.recommended,
  configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.es2022,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ['packages/*/tsconfig.json', 'tools/*/tsconfig.json'],
        },
      },
    },
    rules: {
      // TypeScript already reports unresolved modules, and it does so without
      // needing a second resolver to agree with tsc.
      'import/no-unresolved': 'off',

      // CLAUDE.md hard rule 6. A non-null assertion is allowed only behind an
      // explicit eslint-disable, which forces the author to write the comment.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Separate `import type` statements, not inline `{ type X }`, so the
      // type-only boundary rule below always has an unambiguous signal.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': 'off',
      ...boundaryPathRules,
    },
  },

  // CLAUDE.md hard rule 3: the simulation may not reach for wall-clock time or
  // an unseeded RNG.
  {
    files: ['packages/sim/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...specifiers(PKG.render), ...specifiers(PKG.ui)],
              message: 'PRD 7.2: sim may not import from render or ui.',
            },
            NO_APP,
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'CLAUDE.md rule 3: use a seeded rng stream, never Math.random.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'CLAUDE.md rule 3: the simulation advances on integer ticks, not wall clock.',
        },
      ],
    },
  },

  {
    files: ['packages/render/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [SIM_TYPES_ONLY, NO_APP] }],
    },
  },

  {
    files: ['packages/data/**/*.ts', 'tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [NO_APP] }],
    },
  },

  {
    files: ['**/*.config.{js,ts}', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  prettier,
)
