# Blockwork — agent instructions

You are working on **Blockwork**, a tile-based prison management simulation for iPad and Mac, built in TypeScript with PixiJS v8 + Preact (Vite, Capacitor). No game engine.

## Source of truth (read in this order when relevant)

| Doc | Path | Role |
| --- | --- | --- |
| PRD | `docs/02-prd.md` | Product and system spec — always authoritative |
| Plan | `docs/03-plan.md` | Tickets, phases, handoff template |
| UI | `docs/04-ui-mockups.html` | Visual spec: colours, type, spacing, layout |
| Teardown | `docs/01-teardown.md` | Reference research — background only |
| Index | `docs/00-README.md` | Document set overview and key decisions |

Hand over **one ticket at a time, in order**. Do not skip ahead within a phase. Do not implement outside the current ticket's scope; note gaps at the end of your response instead.

## Hard rules

1. **Original expression only.** Zero assets, names, sprites, sounds, fonts, or text strings from Prison Architect. Use project naming: Directorate, Routine, Standing Orders, Contracts.
2. **`packages/sim` isolation.** No DOM dependencies and no imports from `render`, `ui`, or `app`.
3. **Deterministic sim.** Integer ticks only. No delta-time in sim code. No `Math.random` — use seeded RNG streams.
4. **Data-driven balance.** All balance numbers and content live in `packages/data/*.json`, validated with Zod. Never hardcode balance numbers in systems.
5. **Causal tracing.** Every simulation failure or warning must emit a `CausalEvent` so the Trace panel can reconstruct the chain.
6. **TypeScript strict.** No `any`. No non-null assertions without a comment.
7. **Tests required.** Write the tests listed in the ticket; they must pass before you are done.
8. **Scope discipline.** Only the current ticket. Flag missing work; do not build it.

## Stack reminders

- Monorepo: `packages/sim`, `packages/render`, `packages/ui`, `packages/data`, `packages/app`
- Simulation runs in a Web Worker; fixed integer tick; typed-array world
- Platform: Capacitor iPadOS (also Mac via Designed for iPad)
