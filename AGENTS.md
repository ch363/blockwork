# AGENTS.md

For product rules and architecture, see `CLAUDE.md` and `docs/` (`docs/00-README.md` is the index). For standard scripts, see the root `package.json`.

## Cursor Cloud specific instructions

### What this is

Blockwork is a **client-only** TypeScript monorepo (pnpm workspaces): a browser/iPad prison-management sim (PixiJS v8 + Preact, Vite, Capacitor). There is **no backend, database, or auxiliary service** to start — the simulation runs in a Web Worker and persistence is IndexedDB in the browser. To exercise the product you only need the Vite dev server plus a browser.

### Running it

- Dev server: `pnpm dev` (delegates to `@blockwork/app`'s `vite`), served at `http://localhost:5173` (Vite is configured with `host: true`). This is the single runnable app; all other `packages/*` and `tools/*` are libraries consumed by it or by tests, not separately-started services.
- The dev server sets COOP/COEP headers so the sim worker can use `SharedArrayBuffer`; if you proxy/serve the app another way and the worker fails to boot, missing cross-origin-isolation headers are the likely cause.
- Standard commands (all from repo root): `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`. See root `package.json`.

### Testing gotchas

- The full `pnpm test` run is heavy (~5 min, ~1650 tests). On this VM it frequently prints an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` error under CPU load — this is a reporter/IPC timeout, not a test failure. When iterating, scope tests to a package instead, e.g. `pnpm test -- packages/sim` or `pnpm test -- packages/app`.
- No native/iOS toolchain is available here; `pnpm build:ios` / Capacitor `cap:*` targets require macOS + Xcode and cannot run in this Linux VM. Web dev/test/build is the supported path.
