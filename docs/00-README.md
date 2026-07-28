# Blockwork - Document Set

A Prison Architect style freeplay prison management sim for iPad and Mac, specified end to end so an AI coding agent can build it ticket by ticket.

## The documents

| File | What it is | Who reads it |
| --- | --- | --- |
| `../CLAUDE.md` | Always-loaded agent instructions and hard rules. | Every agent session |
| `01-teardown.md` | Research. Every system in Prison Architect freeplay, with real numbers, plus a list of its known design flaws. | You, and any agent that needs background on why a system exists |
| `02-prd.md` | The product requirements. Vision, the ten improvements over the reference game, full system specs with formulas, data schemas, touch UX, technical architecture, performance budgets, save format, testing strategy. | Every agent, every ticket. This is the source of truth. |
| `03-plan.md` | 57 agent-sized tickets across 8 phases, each with scope, files, spec, acceptance criteria and tests. Includes the handoff prompt template. | You, when handing over work |
| `04-ui-mockups.html` | High fidelity visual spec. Nine full screens at iPad landscape size, plus the extractable design token block. Open it in a browser. | Every UI ticket |

## How to run this

1. Read `02-prd.md` yourself, front to back. It is the thing you are approving.
2. Open `04-ui-mockups.html` in a browser and check the look is what you want. Changing it now is free.
3. Hand over tickets **one at a time, in order**, using the prompt template at the top of `03-plan.md`.
4. Do not let an agent skip ahead within a phase. The dependency graph at the bottom of the plan is real.
5. After each phase, run the phase exit criteria yourself before starting the next.

## The key decisions already made

| Decision | Choice | Where it is justified |
| --- | --- | --- |
| Stack | TypeScript + PixiJS v8 + Preact, Vite, no game engine | PRD 7.1 |
| Platform | Capacitor iPadOS build, which also runs natively on Apple Silicon Macs via "Designed for iPad" | PRD 7.1 |
| Fidelity | Faithful systems, modernised UX, original expression | PRD 1.3 |
| Architecture | Simulation in a Web Worker, fixed integer tick, fully deterministic, typed-array world | PRD 4.1 to 4.6 |
| Content | All balance and content in JSON, validated with Zod | PRD 7.3 |
| MVP | Build, inmates, needs, routine, guards, day cycle (Phases 0 to 2) | Plan, phases 0 to 2 |

## The flagship differentiators

If you cut scope, protect these four. They are what makes it better rather than just different.

1. **Trace panel** - every failure explains its own causal chain with real numbers and actionable fixes. PRD 3.1, ticket T3.1.
2. **Blueprint mode with commit** - draw for free, validate, then pay. PRD 3.2, ticket T1.5.
3. **Intent-based posts** - declare "3 officers in the mess hall during meals", the game staffs it. PRD 3.5, ticket T4.1.
4. **Flow view** - every logistics chain shown as a throughput diagram with the bottleneck named. PRD 3.6 and 5.13, ticket T3.3.

## Coverage matrix

Every system found in the research appears in the PRD and is covered by at least one ticket.

| Reference system | Teardown | PRD | Ticket(s) |
| --- | --- | --- | --- |
| Grid, foundations, walls, doors, materials | 3 | 4.3, 5.1 | T0.3, T1.2, T1.6 |
| Rooms and requirements | 4.1 | 5.1 | T1.3 |
| Room grading and cell entitlement | 4.2 | 5.2 | T5.2 |
| Objects | 5.1 | 5.3 | T1.4 |
| Electricity, water, wiring, logic | 5.2 to 5.4 | 5.12, 3.4 | T5.5 |
| Logistics: meals, laundry, cleaning, supply | 5.5 | 5.13, 3.6 | T3.3, T3.4, T3.5 |
| Inmate categories, traits, reputations, crimes | 6 | 5.5 | T2.4 |
| Needs and addictions | 7 | 5.4 | T2.5 |
| Staff roster and guard behaviour | 8 | 5.6 | T2.7 |
| Staff needs, morale, strikes | 7.3 | 5.6 | T3.8 |
| Regime / Routine | 9 | 5.7 | T2.6 |
| Deployment, sectors, patrols | 10 | 3.5 | T4.1 |
| Bureaucracy / Directorate | 11 | 5.8 | T5.1 |
| Programs and reform | 12 | 5.9 | T5.3 |
| Parole, release, re-offending | 12, 6.7 | 5.5, 5.15 | T5.4 |
| Contraband, trading, detection | 13 | 5.10 | T4.2, T4.3 |
| Misconduct, punishment, suppression | 6.6 | 5.4, 5.11 | T4.4 |
| Combat and injury | 13, 14 | 5.11 | T4.5 |
| Danger, riots, emergency response | 14.1, 14.2 | 5.11, 3.7 | T4.6 |
| Escapes and tunnels | 14.3 | 5.11 | T4.7 |
| Fire | 14.4 | 5.11 | T4.8 |
| Random events | 14.5 | 5.11 | T4.6, T6.3 |
| Failure conditions | 14.6 | 5.15 | T4.6, T5.4 |
| Economy, grants, loans, tax | 15 | 5.14 | T3.6, T3.7 |
| Prison labour, workshop, forestry, shop | 5.5, 12 | 5.13 | T5.7 |
| Intelligence, informants, phone taps | 13.4 | 5.10 | T5.6 |
| Reports and overlays | 16 | 6.2, 6.4 | T6.1, T6.2 |
| Pathfinding (rebuilt, not replicated) | 17.1, 17.2 | 4.5 | T2.1, T2.2, T2.3 |
| Undo, planning, clone | 17.9, 3 | 3.2, 3.3 | T1.5 |
| Onboarding | 17.11 | 3.8 | T6.4 |

Systems deliberately deferred past v1, with the reasoning in PRD 1.2: gangs, female prisons and babies, criminally insane and psychiatric care, island maps, weather beyond the warmth need, modding UI.

## Legal position

This is systems replication with original expression. Game mechanics are not copyrightable; the specific assets, names, art, text and code are. The rules in PRD 1.3 are not optional:

- Zero assets, sprites, sounds, fonts or text strings from the reference game
- Zero reference-game proper nouns anywhere in the repository
- Original naming used throughout: the research tree is the **Directorate**, the schedule is the **Routine**, policy is **Standing Orders**, grants are **Contracts**

If you plan to release commercially, get a lawyer to review the finished build. This document set is not legal advice.
