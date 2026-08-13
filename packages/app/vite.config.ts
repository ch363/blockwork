import { defineConfig } from 'vite'

/**
 * COOP/COEP headers required for `SharedArrayBuffer` (PRD 4.6, T8.16).
 *
 * Vite `server` and `preview` apply these locally. Static hosts need the same
 * values — see `public/_headers` (Netlify / Cloudflare Pages) and
 * `vercel.json`.
 */
export const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
})
