import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    include: ['test/**/*.test.ts', '{packages,tools}/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      enabled: process.env['CI'] === 'true',
      include: ['{packages,tools}/*/src/**/*.{ts,tsx}'],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 55,
        lines: 50,
        'packages/sim/src/systems/**': {
          statements: 70,
          branches: 70,
          functions: 75,
          lines: 70,
        },
      },
    },
  },
})
