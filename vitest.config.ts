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
      include: ['{packages,tools}/*/src/**/*.{ts,tsx}'],
    },
  },
})
