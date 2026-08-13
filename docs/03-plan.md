# Blockwork - Implementation Plan

How to use this document: each ticket below is a self-contained unit of work sized for one AI coding agent session. Hand them over **one at a time, in order**. Do not skip ahead within a phase. Phases can only start when the previous phase's exit criteria are met.

Every ticket has the same shape:

- **Goal** - one sentence
- **Depends on** - ticket IDs
- **Files** - what to create or change
- **Spec** - the actual requirements
- **Acceptance** - what must be true when done
- **Tests** - what to write

Ticket IDs are stable. Do not renumber.

---

## Agent handoff prompt template

Paste this at the top of every ticket you hand over.

```
You are implementing one ticket of the Blockwork project, a tile-based prison
management simulation for iPad and Mac, built in TypeScript with PixiJS.

Read these first, they are the source of truth:
  - docs/02-prd.md               (product and system spec)
  - docs/03-plan.md              (this plan, for context on what comes next)
  - docs/04-ui-mockups.html      (visual spec: colours, type, spacing, layout)
  - docs/01-teardown.md          (reference research, background only)
  - CLAUDE.md                    (always-loaded hard rules)

Hard rules:
  1. Zero assets, names or strings from Prison Architect. Original expression only.
  2. packages/sim has no DOM dependencies and no imports from render, ui or app.
  3. All simulation runs on integer ticks. No delta-time in sim code. No Math.random,
     use the seeded rng streams.
  4. All balance numbers and content definitions live in packages/data/*.json,
     validated with Zod. Never hardcode a balance number in a system.
  5. Every simulation failure or warning must emit a CausalEvent so the Trace panel
     can reconstruct the chain.
  6. TypeScript strict mode. No `any`. No non-null assertions without a comment.
  7. Write the tests listed in the ticket. They must pass before you are done.
  8. Do not implement anything outside this ticket's scope. If you find something
     missing, note it at the end of your response rather than building it.

Your ticket follows.
---
<paste ticket here>
```

---

## Phase 0 - Foundations

**Goal:** an empty but architecturally correct project that renders a tile grid on an iPad and holds 60fps.

**Exit criteria:** you can pinch-zoom and pan around a 220x220 tile map on a physical iPad at 60fps, with a worker running an empty tick loop, and a save file round-trips.

---

### T0.1 - Repository scaffold and tooling

**Goal:** create the monorepo with strict tooling and passing empty builds.

**Depends on:** nothing

**Files:**
```
package.json, pnpm-workspace.yaml, tsconfig.base.json
.eslintrc.cjs, .prettierrc, vitest.config.ts
packages/sim/{package.json,tsconfig.json,src/index.ts}
packages/render/{package.json,tsconfig.json,src/index.ts}
packages/ui/{package.json,tsconfig.json,src/index.ts}
packages/data/{package.json,tsconfig.json}
packages/app/{package.json,tsconfig.json,index.html,src/main.ts,vite.config.ts}
tools/replay/, tools/balance/
.github/workflows/ci.yml
```

**Spec:**
- pnpm workspaces. Node 20+.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- ESLint with `eslint-plugin-import` configured to enforce the boundary rules in PRD 7.2. A violation must fail the build.
- Vite dev server for `packages/app`.
- CI runs: typecheck, lint, test, build.

**Acceptance:**
- `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass on a clean checkout.
- Adding `import { x } from '@blockwork/render'` inside `packages/sim` fails lint.

**Tests:** one trivial test per package so the runner is wired.

---

### T0.2 - Deterministic core: clock, RNG, command queue

**Goal:** the beating heart of the simulation, with determinism provable by test.

**Depends on:** T0.1

**Files:** `packages/sim/src/core/{clock.ts,rng.ts,commands.ts,simulation.ts}`

**Spec:**
- `Clock`: integer `tick`, derived `minute`, `hour`, `day`. 10 ticks per in-game minute. Helpers: `ticksToTimeString`, `isHour(h)`, `everyNTicks(n)`.
- `Rng`: mulberry32. `Rng.stream(name: string)` returns a named sub-stream deterministically derived from the master seed and the name hash. Streams serialise and restore their internal state.
- `CommandQueue`: player commands are plain serialisable objects `{ type, payload, issuedAtTick }`. They are applied at the **start** of a tick, in insertion order.
- `Simulation`: owns the clock, rng, world and the ordered system list. `step()` advances exactly one tick. `hash()` returns a stable FNV-1a hash of all simulation state for determinism testing.

**Acceptance:**
- Running 10,000 steps twice from the same seed and command list yields identical `hash()` at every step.
- Adding a new named rng stream does not change the output of existing streams.

**Tests:**
- Determinism: two simulations, same seed, 10k steps, hashes match at steps 1, 100, 1000, 10000.
- Stream isolation: draw 100 from stream A, assert stream B's first 100 unchanged.
- Clock: tick 0 is day 1 00:00. Tick 14,400 is day 2 00:00.

---

### T0.3 - Tile grid with typed arrays

**Goal:** the world's data substrate.

**Depends on:** T0.2

**Files:** `packages/sim/src/world/{tileGrid.ts,materials.ts,coords.ts}`

**Spec:**
- Implement `TileGrid` exactly as specified in PRD 4.3, all fields as typed arrays sized `size * size`.
- Index helpers: `idx(x,y)`, `xy(i)`, bounds checks in dev builds only.
- `TileGrid.allocate(size)` and `TileGrid.fromBuffers(...)`.
- A `dirtyRegions` tracker: any write marks a 16x16 chunk dirty. `consumeDirtyChunks()` returns and clears the set. This is what the renderer and pathfinder subscribe to.

**Acceptance:**
- A 300x300 grid allocates in under 20ms and uses under 5MB.
- Writing one tile marks exactly one chunk dirty.

**Tests:** allocation size, index round-trip for 1000 random coords, dirty chunk accounting.

---

### T0.4 - Worker bridge and snapshots

**Goal:** the simulation runs off the main thread and the main thread can render it.

**Depends on:** T0.3

**Files:** `packages/sim/src/core/snapshot.ts`, `packages/app/src/worker/{simWorker.ts,bridge.ts}`

**Spec:**
- Worker boots the simulation, runs a `setInterval`-free loop driven by `performance.now()` accumulation, stepping at `4 * speedMultiplier` steps per second.
- After each step, write a snapshot. Snapshot contains: tick, camera-independent entity array (id, x, y, kind, spriteIndex, facing, flags), changed tile chunk ids, notification queue delta, and a small UI digest (balance, danger, population, alerts count).
- Transport: `SharedArrayBuffer` double buffer with an atomic sequence number, so the renderer never reads a torn frame. If `crossOriginIsolated` is false, fall back to `postMessage` with transferable ArrayBuffers.
- Main thread `bridge` exposes `latestSnapshot()`, `sendCommand(cmd)`, `setSpeed(n)`.

**Acceptance:**
- At 20x speed with 400 dummy entities, the main thread never blocks more than 2ms reading a snapshot.
- The fallback path works when `crossOriginIsolated` is false.

**Tests:** a torn-read test that writes continuously while reading and asserts every read is internally consistent.

---

### T0.5 - Renderer: terrain, camera, gestures

**Goal:** you can see and navigate the map.

**Depends on:** T0.4

**Files:** `packages/render/src/{app.ts,camera/*,layers/terrain.ts,layers/grid.ts}`

**Spec:**
- PixiJS v8 application sized to the device, `resolution: devicePixelRatio`, capped at 2.
- Terrain layer: 32x32 tile chunks, each a `Mesh` or `ParticleContainer` of tile sprites from an atlas. Only dirty chunks rebuild.
- Camera: position in world units, zoom with 4 stops (0.5, 1.0, 2.0, 4.0) and smooth interpolation between. Clamped to map bounds plus a small margin.
- Gestures via Pointer Events (not touch events, so trackpad works too):
  - one pointer drag = pan with momentum
  - two pointer pinch = zoom about the pinch centroid
  - wheel = pan, ctrl/cmd + wheel = zoom (Mac)
- Frustum culling on chunks.

**Acceptance:**
- 220x220 map of mixed floor materials renders at 60fps on an iPad Air while panning and zooming.
- Under 12 draw calls for terrain alone at full zoom-out.

**Tests:** unit tests for camera clamping and screen-to-world conversion. Manual device check for fps.

---

### T0.6 - Save, load and migration skeleton

**Goal:** state persists and old saves survive schema changes.

**Depends on:** T0.3

**Files:** `packages/sim/src/save/{serialise.ts,deserialise.ts,migrations/index.ts}`

**Spec:**
- Implement `SaveFile` from PRD 7.4. Typed arrays serialise as base64.
- Gzip via `CompressionStream`.
- IndexedDB store with 5 rotating autosave slots plus named manual saves.
- Migration chain: `migrations[n]` transforms a v`n` save into v`n+1`. Loading runs every step from the file's version to current. Add a no-op migration from v1 to v2 as the pattern example.
- Export and import as a `.blockwork` file via the Files app.

**Acceptance:**
- A save containing a full 220x220 grid and 400 entities round-trips to an identical `hash()`.
- A v1 file loads under a v2 schema.

**Tests:** round-trip determinism, migration chain, corrupt-file handling produces a clean error not a crash.

---

## Phase 1 - Building

**Goal:** the player can construct a physical prison.

**Exit criteria:** you can draw a foundation, wall it, add doors and floors, designate a room, place objects, and see the room report itself as functional or not.

---

### T1.1 - Data layer and schemas

**Goal:** all game content is JSON, validated at load.

**Depends on:** T0.1

**Files:** `packages/data/*.json`, `packages/sim/src/data/{schemas.ts,loader.ts}`

**Spec:**
- Zod schemas for every definition type in PRD section 5: `RoomDef`, `ObjectDef`, `NeedDef`, `MaterialDef`, `StaffDef`, `DirectorateNode`, `ProgramDef`, `ContrabandDef`, `ContractDef`, `TraitDef`, `ReputationDef`, `ConvictionDef`, plus a `balance.json` for global constants.
- `loadGameData()` parses all files, validates, and then runs **cross-reference validation**: every `requiredObjects.objectId` exists, every `unlockedBy` names a real Directorate node, every `sourceRooms` names a real room, and so on. Failures throw with the exact path.
- Seed the files with the full v1 content lists from PRD 5.1, 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 5.10, 5.14. Use placeholder balance values where the PRD does not specify one, and mark them with a `"_tuning": true` sibling key.

**Acceptance:**
- Deleting any object referenced by a room fails the load with a clear message naming both.
- `pnpm test` includes a schema test that runs against the real data files, not fixtures.

**Tests:** happy path load, each class of cross-reference failure, unknown-key rejection.

---

### T1.2 - Construction: foundations, walls, doors, floors

**Goal:** physical structure exists and affects passability.

**Depends on:** T0.3, T1.1

**Files:** `packages/sim/src/world/{construction.ts,walls.ts,doors.ts}`, `packages/sim/src/systems/constructionSystem.ts`

**Spec:**
- Commands: `PlaceFoundation(rect, material)`, `PlaceWall(line, material)`, `RemoveWall(line)`, `PlaceDoor(tile, type)`, `PaintFloor(rect, material)`, `Demolish(rect)`.
- Foundations create walls on the perimeter and floor inside, and set `outdoors = 0`.
- Doors: `standard`, `secure`, `barred`, `staff`, `isolation`, `remote`. Each has a passability mask and a lock state.
- Construction is **queued work**, not instant. A `ConstructionSite` entity per tile with a required material list and a progress value. Materials must be delivered before progress starts (stub the delivery in this ticket, real logistics come in T3.4). `constructionSystem` advances sites where a worker is present.
- Passability updates immediately on completion and marks chunks dirty.

**Acceptance:**
- A 10x8 foundation produces a closed shell with correct wall autotiling data.
- Removing one wall tile makes the interior reachable from outside.
- Demolishing refunds 50% of material cost.

**Tests:** foundation geometry, passability after each operation, refund maths.

---

### T1.3 - Room detection and requirements

**Goal:** designated areas become functional rooms.

**Depends on:** T1.2

**Files:** `packages/sim/src/world/{rooms.ts,roomDetection.ts}`

**Spec:**
- Command: `DesignateRoom(rect, roomDefId)`, `UndesignateRoom(rect)`.
- Detection: flood fill over designated tiles of the same type, bounded by walls and doors. Each connected component is one `Room` with an id, a tile set, and a bounding box.
- Compute properties: `enclosed` (flood fill from the room never escapes to an outdoor tile through a non-door gap), `indoors` (every tile has a foundation), `outdoors`, `secure` (the room is inside a perimeter of walls or fences).
- Evaluate `requiredObjects` and `minTiles`/`minWidth`/`minHeight`. Produce a `RoomStatus` with a per-requirement pass/fail list, not just a boolean.
- **Incremental:** any change re-runs detection only for the affected connected components, never the whole map.

**Acceptance:**
- A 2x3 area with a bed and a toilet, enclosed and indoors, reports as a functional cell.
- Removing the toilet reports exactly one failed requirement, naming the toilet.
- Room detection on a 220x220 map with 400 rooms, after a single wall change, completes in under 2ms.

**Tests:** each room property predicate, requirement evaluation, incremental scoping (assert only N rooms were re-evaluated).

---

### T1.4 - Objects: placement, power and water flags

**Goal:** objects exist in the world.

**Depends on:** T1.3

**Files:** `packages/sim/src/entities/objects.ts`, `packages/sim/src/systems/objectSystem.ts`

**Spec:**
- Command: `PlaceObject(tile, objectDefId, rotation)`, `RemoveObject(entityId)`.
- Multi-tile objects occupy a rect anchored at the placed tile, rotated. Placement validation: all tiles free, correct surface (floor/wall/door), inside a room if the def requires it.
- Objects are entities with an `ObjectComponent`. They register with their containing room so requirement evaluation is a lookup, not a scan.
- Power and water: an object stores `hasPower`/`hasWater` booleans, set by the utilities system in Phase 4. Until then, default true, behind a `balance.json` flag `utilitiesEnabled`.

**Acceptance:**
- Placing a 2x1 cooker rotated 90 degrees occupies the correct two tiles.
- Removing an object immediately invalidates its room's requirement status.

**Tests:** rotation geometry, placement validation cases, room registration.

---

### T1.5 - Blueprint mode and the command/undo stack

**Goal:** the flagship building UX.

**Depends on:** T1.4

**Files:** `packages/sim/src/core/{undo.ts,blueprint.ts}`, `packages/ui/src/panels/BlueprintBar.tsx`

**Spec:**
- A `Blueprint` is a staged list of construction commands held on the **main thread**, not in the simulation. It is priced by querying the data layer, and validated by a pure function that simulates the resulting room/requirement state without mutating the world.
- `CommitBlueprint` sends the whole command list to the worker as one atomic command, deducting the total cost.
- Undo stack: every applied command has an inverse. Depth 50. Blueprint operations undo locally and instantly. Committed construction undoes by issuing the inverse commands, refunding proportionally to work completed.
- Blueprint bar UI: total cost, tile count, and a validity list. Each invalid entry is tappable and pans the camera.

**Acceptance:**
- Drawing a 6-cell block, seeing "3 cells missing a toilet", adding toilets, and committing works end to end.
- Two-finger tap undoes the last blueprint stroke.
- Undoing a committed 20-object placement refunds correctly and leaves the world identical to before.

**Tests:** validation without mutation, inverse-command correctness for every command type, refund maths.

---

### T1.6 - Render: walls, doors, objects, autotiling

**Goal:** the prison looks like a prison.

**Depends on:** T1.4, T0.5

**Files:** `packages/render/src/layers/{walls.ts,objects.ts}`, `packages/render/src/sprites/autotile.ts`

**Spec:**
- 47-tile bitmask autotiling for walls, computed from the 8 neighbours. A lookup table, not branching logic.
- Doors render in open and closed states with a simple two-frame swing.
- Objects render y-sorted within their chunk. Multi-tile objects anchor to their bottom tile for sorting.
- Blueprint overlay renders as a semi-transparent blue wireframe with a distinct invalid state in amber.

**Acceptance:**
- A wall corner, T-junction and cross all render correctly.
- Under 40 draw calls for a fully built 220x220 prison at zoom 1.

**Tests:** autotile lookup table unit test covering all 256 neighbour permutations mapping to the correct 47 entries.

---

## Phase 2 - Life

**Goal:** the prison has people in it who do things.

**Exit criteria:** inmates arrive on a bus, get assigned cells, follow a routine, eat, sleep, shower, and their needs visibly rise and fall.

---

### T2.1 - Pathfinding layer 1: region graph

**Goal:** cheap coarse routing.

**Depends on:** T1.3

**Files:** `packages/sim/src/pathfinding/regionGraph.ts`

**Spec:**
- Partition walkable tiles into **regions**: connected components bounded by walls and doors. A room is usually one region, a corridor is another.
- Build a graph where regions are nodes and doors are edges, with an edge cost of the door traversal time plus the region's mean crossing distance.
- Each edge carries an **access mask** (which agent categories may pass), derived from door type and sector permissions.
- **Incremental rebuild:** a passability change dirties only the affected regions and their neighbours.

**Acceptance:**
- On a 220x220 map with 60 rooms, the graph has under 200 nodes and rebuilds in under 1ms after a single door change.
- `findRegionPath(from, to, accessMask)` returns null when no permitted route exists.

**Tests:** graph correctness on hand-built fixtures, access mask filtering, incremental rebuild scoping.

---

### T2.2 - Pathfinding layer 2: flow fields

**Goal:** hundreds of agents heading to the same place cost almost nothing.

**Depends on:** T2.1

**Files:** `packages/sim/src/pathfinding/flowField.ts`

**Spec:**
- A `FlowField` is a `Uint8Array` of direction indices (0 to 8) over the tile grid, generated by a Dijkstra expansion from one or more goal tiles, respecting an access mask.
- Field cache keyed by `(goalSetId, accessMask)`. Fields are generated lazily on first request and invalidated by dirty chunks that intersect them.
- Standard goal sets, maintained automatically: nearest serving counter, nearest shower head, nearest toilet, own cell (per-inmate, so this one is A\*), nearest yard, nearest exit, nearest work station of each type.
- Generation is **budgeted**: at most one field per tick.

**Acceptance:**
- 300 inmates pathing to a mess hall consume one flow field, not 300 A\* searches.
- Field generation for a 220x220 map completes in under 6ms and is spread across ticks so no single step exceeds budget.

**Tests:** field correctness against brute-force BFS on a small fixture, invalidation on wall change, budget enforcement.

---

### T2.3 - Pathfinding layer 3: budgeted A* and local avoidance

**Goal:** agents move without piling up.

**Depends on:** T2.2

**Files:** `packages/sim/src/pathfinding/{astar.ts,avoidance.ts,doorQueue.ts}`, `packages/sim/src/systems/{pathingSystem.ts,movementSystem.ts}`

**Spec:**
- A\* with a binary heap, octile heuristic, and a **search bound derived from the region path**, so it never expands outside the corridor of regions returned by layer 1.
- Budget: max 8 A\* searches per tick, configurable in `balance.json`. Over-budget requests queue.
- Local avoidance: each agent samples its 3x3 tile neighbourhood, and if another agent occupies its next tile, it either waits (if the other is moving in the same direction), or side-steps.
- Door queues: a door with more than 2 agents waiting forms an ordered queue. Agents join the tail and are released in order. Prevents the reference game's doorway scrum.
- Agents move in world units with a per-category speed. Diagonal movement allowed only when both orthogonal neighbours are passable.

**Acceptance:**
- 400 agents, all moving, consume under 4ms per step combined across pathfinding and movement.
- No agent gets permanently stuck in a corridor pinch over a 10,000 tick run.

**Tests:** A\* optimality against BFS on fixtures, budget enforcement, a stress fixture with 400 agents in a corridor asserting zero permanent stalls.

---

### T2.4 - Inmate entity, generation and intake

**Goal:** inmates exist and arrive.

**Depends on:** T1.1, T2.3

**Files:** `packages/sim/src/entities/inmate.ts`, `packages/sim/src/systems/intakeSystem.ts`

**Spec:**
- Implement `Inmate` from PRD 5.5.
- **Generation:** pick a security category, roll 1 to 3 convictions from the conviction table appropriate to that category's risk tier, derive traits from those convictions, roll reputations with category-scaled probability, roll aptitude, roll addictions (gated on `dependent` trait), generate a name from an original name pool and a portrait seed.
- **Intake:** a bus arrives at the dock with N inmates. Continuous intake fills to capacity automatically. Manual intake uses a requested-counts-per-category setting. Arrival pays the intake fee.
- Cell assignment: on arrival, find a free cell matching the inmate's category sector and entitlement (starting entitlement 2). If none, assign to a holding pen. If no holding pen, the inmate stands in the intake hall and a `warn` notification fires with a Trace.

**Acceptance:**
- Generating 10,000 inmates produces a trait distribution consistent with the conviction table, verifiable by test.
- Arriving with no free cells produces the correct notification and Trace.

**Tests:** generation distribution, deterministic generation from a seed, cell assignment priority order, capacity edge cases.

---

### T2.5 - Needs system

**Goal:** inmates want things.

**Depends on:** T2.4

**Files:** `packages/sim/src/systems/needsSystem.ts`, `packages/sim/src/entities/needs.ts`

**Spec:**
- Needs stored as a `Float32Array` per inmate, indexed by a stable need index derived from `needs.json` order.
- Fill: `value += fillPerMinute` each simulated minute, modified by traits and context (freedom triples while locked up, environment is driven by room dirt, privacy by nearby inmate count, safety by danger level, warmth by tile temperature).
- Discharge: while an inmate is `using` an object that serves a need, subtract `decayOnUse` per minute. Objects have a `concurrentUsers` cap.
- Critical behaviours per PRD 5.4 fire when a need crosses `critical`: urinating on the floor (adds dirt), starvation timer, weapon seeking, tunnel digging, withdrawal, exposure damage.
- Every critical need crossing emits a `CausalEvent`.

**Acceptance:**
- An inmate with no toilet access reaches critical bladder in the expected time and urinates, adding dirt to the tile.
- An inmate with a working food chain never reaches critical food over 30 in-game days.

**Tests:** decay and fill maths, each critical behaviour, need index stability across data file reordering (must throw, not silently corrupt).

---

### T2.6 - Routine system and activity

**Goal:** inmates follow a schedule.

**Depends on:** T2.5

**Files:** `packages/sim/src/systems/{routineSystem.ts,activitySystem.ts}`, `packages/sim/src/world/routine.ts`

**Spec:**
- `Routine` is 24 block ids per security category, stored in `RoutineState`.
- Each block type maps to a **permitted room set** and a **preferred activity**. Routine does not force actions, it constrains location.
- `routineSystem` runs on the hour, assigns each inmate a target room set, and issues a movement goal (a flow field goal, not a specific tile, where possible).
- `activitySystem` runs each minute: an inmate in a permitted room with a spare need-serving object claims it and enters a `using` state for a duration, discharging the need.
- Sleep rule: no sleeping 08:00 to 20:00.
- Free-choice logic during `free` blocks: pick the highest need that any reachable room can serve, weighted by travel time.

**Acceptance:**
- With a mess hall, showers, a yard and cells built, a 24 hour cycle sees inmates visibly move between all four and their needs fall correspondingly.
- Changing the routine takes effect on the next hour boundary.

**Tests:** block-to-room-set mapping, sleep rule, free-choice selection ranking, hour boundary transitions.

---

### T2.7 - Staff entity, hiring and basic guard duty

**Goal:** the prison has employees.

**Depends on:** T2.4

**Files:** `packages/sim/src/entities/staff.ts`, `packages/sim/src/systems/staffSystem.ts`

**Spec:**
- Implement `StaffDef` and staff entities. Hiring costs `hireCost` plus an hourly wage.
- Administrators require an office; the office is claimed automatically and renamed.
- Officers: wander their assigned area, remove fog of war in a radius, escort inmates (a job type), open doors for inmates in secure sectors, and respond to incidents.
- Escort job: an officer claims the job, walks to the inmate, the inmate follows, both walk to the destination, the job completes. Escorts are needed for cell assignment, isolation, clinic trips and program attendance.
- Wage payment hourly from the economy system.

**Acceptance:**
- Hiring 20 officers and 200 inmates, all cell assignments complete within one in-game day.
- Removing all officers means no inmate can pass a locked secure door.

**Tests:** escort job lifecycle, office claiming, wage accrual.

---

### T2.8 - Render: agents

**Goal:** you can see people.

**Depends on:** T2.7, T1.6

**Files:** `packages/render/src/layers/agents.ts`

**Spec:**
- Sprite batch, y-sorted, 4 directions x 4 walk frames, plus an idle frame.
- Uniform colour is a tint on a separate layer sprite, so one base sprite serves every category and staff role.
- Mood indicator: a small icon above the head when any need is high or critical, showing the worst need's icon.
- Selection ring on the selected entity.
- At zoom 0.5, agents render as 4px coloured dots with no animation.

**Acceptance:**
- 400 animated agents render in one draw call and cost under 4ms.

**Tests:** interpolation correctness between snapshots (no visible snapping when the sim steps).

---

### T2.9 - UI shell, inspector and world interaction

**Goal:** the player can touch things and learn about them.

**Depends on:** T2.8

**Files:** `packages/ui/src/{App.tsx,panels/Inspector*.tsx,controls/*,theme/tokens.ts}`

**Spec:**
- Extract the design tokens from `04-ui-mockups.html` into `theme/tokens.ts`. Colour, spacing, radius, type scale, elevation. **Do not invent values, take them from the mockup.**
- Top bar, tool dock and inspector panel per PRD 6.1, matching the mockup pixel for pixel at the reference size.
- Tap-to-select on the world view: hit test against the snapshot's entity array, then tiles.
- Inspector variants: inmate, staff, room, object. Content per PRD 6.2.
- Speed controls with a keyboard fallback on Mac.

**Acceptance:**
- Every control has a 44pt minimum hit target, verified by a test that walks the rendered DOM.
- The inspector matches the mockup at 1194x834 within 2px on every measured element.
- VoiceOver reads every control with a meaningful label.

**Tests:** hit target audit, snapshot tests of each inspector variant, accessibility label coverage test.

---

## Phase 3 - Operations

**Goal:** the prison runs as a system, not a set of independent parts.

**Exit criteria:** food gets cooked and eaten through a real supply chain, laundry cycles, floors get dirty and cleaned, money moves, and the Trace panel explains failures.

---

### T3.1 - CausalEvent recording and the Trace panel

**Goal:** the flagship feature. Build it early so every later system uses it.

**Depends on:** T2.5

**Files:** `packages/sim/src/trace/{causalEvent.ts,traceBuilder.ts}`, `packages/ui/src/panels/Trace.tsx`

**Spec:**
- `CausalEvent { id, tick, kind, subjectId, causeIds: EventId[], data }`. Events form a DAG. Ring buffer of the last 20,000 events, plus permanent retention for events referenced by an active notification.
- Any system that produces a bad outcome emits an event **with its causes**. Example chain: `inmate.starved` caused by `inmate.missedMeal x3` caused by `mess.emptyAtMealtime` caused by `kitchen.underCapacity`.
- `buildTrace(eventId)` walks causes to a depth of 8 and returns a renderable tree with human strings resolved from a `traceStrings.json` catalogue.
- Suggested fixes: each event kind may declare `suggestedFixes`, computed functions that produce actionable strings with the specific numbers filled in.
- Trace panel UI: vertical timeline, each node tappable to pan the camera to the subject, fixes as buttons at the bottom.

**Acceptance:**
- A deliberately broken kitchen produces the full five-node chain in the PRD 3.1 example, with correct numbers.
- The event buffer never exceeds its memory cap under a 100 in-game day run.

**Tests:** DAG construction, depth limiting, string resolution for every registered event kind (a test that fails if a kind has no string), ring buffer eviction respecting pinned events.

---

### T3.2 - Job system

**Goal:** work gets claimed and done.

**Depends on:** T2.7

**Files:** `packages/sim/src/systems/jobSystem.ts`, `packages/sim/src/entities/job.ts`

**Spec:**
- A `Job` is `{ id, kind, priority, location, requiredRole, claimedBy, state }`.
- Job kinds in v1: `build`, `deliver`, `clean`, `cook`, `serve`, `wash`, `iron`, `escort`, `search`, `repair`, `treat`, `collectRefuse`, `harvest`, `manufacture`.
- Assignment: each tick, unclaimed jobs are offered to idle eligible agents, sorted by `priority * (1 / travelTime)`. An agent claims at most one job.
- Jobs can be **reserved** by an inmate work assignment (inmate labour) or open to staff.
- Job abandonment on interruption (riot, lockdown, agent injured) returns the job to the pool.

**Acceptance:**
- 50 workers and 300 jobs distribute without duplicate claims and without starvation of low-priority jobs over time.

**Tests:** claim exclusivity, priority ordering, abandonment and requeue, aging so low priority jobs eventually run.

---

### T3.3 - Meal chain

**Goal:** the food logistics loop, end to end.

**Depends on:** T3.2, T3.1

**Files:** `packages/sim/src/systems/logistics/mealChain.ts`

**Spec:**
- Implement the full chain from PRD 5.13. Ingredients as items, fridges as stores, cookers as work stations, serving counters as dispensers, trays as items, sinks as work stations, refuse as an export.
- Cooks begin preparation 4 hours before a `meal` block. Required meal count = population served by that mess hall, adjusted by meal quantity policy.
- `mealsPerHour = cookers * 12 * (1 + 0.25 * cooksAssigned)`.
- Kitchen-to-mess-hall routing: automatic by nearest, overridable once Delegation is researched.
- Meal quality and variety from `standingOrders`. Variety requires N distinct ingredient types in stock.
- Every failure point emits a CausalEvent: no ingredients, insufficient cookers, no cook assigned, no route to mess hall, mess hall full.

**Acceptance:**
- A prison with a correctly sized kitchen feeds 200 inmates with zero missed meals over 30 in-game days.
- Halving the cookers produces the exact Trace chain from PRD 3.1.

**Tests:** capacity formula, preparation timing, routing selection, each failure mode's CausalEvent.

---

### T3.4 - Construction supply, storage and deliveries

**Goal:** building consumes real materials that really arrive.

**Depends on:** T3.2

**Files:** `packages/sim/src/systems/logistics/{supply.ts,deliveries.ts}`

**Spec:**
- Committing a blueprint places material orders. Orders batch into truck deliveries arriving at the dock on a schedule (one truck per 2 in-game hours, capacity 40 items).
- Items are carried dock -> store by workers, store -> site by workers.
- Retrofit T1.2's stubbed instant materials to use this chain.
- Refuse: garbage accumulates in bins and from the kitchen, is carried to the refuse zone, and collected by trucks. Uncollected refuse raises dirt and the environment need.

**Acceptance:**
- Committing a 40-object blueprint results in trucks arriving, materials moving, and construction completing over a plausible number of hours.
- Removing the store means materials pile at the dock and construction stalls with a correct notification.

**Tests:** order batching, truck scheduling, carry job generation, stall detection.

---

### T3.5 - Laundry, cleaning and dirt

**Goal:** the two remaining logistics loops.

**Depends on:** T3.4

**Files:** `packages/sim/src/systems/logistics/{laundry.ts,cleaning.ts}`

**Spec:**
- Dirt accrues per tile: +1 per agent pass, +30 per urination, +50 per blood spill, +10 per food waste. Capped at 255.
- Cleaners work indoors, groundskeepers outdoors, assigned inmates during `work_*`. Cleaning a tile takes time proportional to dirt.
- `environment` need = mean dirt of the inmate's current room, normalised.
- Laundry: uniforms accumulate dirtiness per day worn. Dirty uniforms are collected from beds into baskets, washed, ironed, redistributed. `clothing` need discharges on receiving a clean uniform.
- Laundry-to-block routing, automatic by nearest, overridable with Delegation.

**Acceptance:**
- A prison with no cleaners sees the environment need reach critical prison-wide within 5 in-game days.
- A correctly sized laundry keeps clothing satisfied for 200 inmates.

**Tests:** dirt accrual rates, cleaning throughput, uniform lifecycle, routing.

---

### T3.6 - Economy

**Goal:** money moves and can run out.

**Depends on:** T3.3

**Files:** `packages/sim/src/systems/economySystem.ts`

**Spec:**
- Ledger with categorised entries. Every debit and credit is recorded with a reason string and a source entity id.
- Hourly: wages, utility bills, loan interest. Daily at midnight: per-inmate payments, tax.
- Balance may go negative. Insolvency check: negative balance and negative 24-hour cash flow starts a 24 hour countdown.
- Finance report: 7 day chart, breakdown by category, projected daily net.

**Acceptance:**
- A prison with 100 medium inmates and 20 officers produces a plausible, non-degenerate cash flow over 30 days.
- Every ledger entry traces to a source.

**Tests:** wage accrual timing, tax application, insolvency countdown and cancellation, ledger balance invariant (sum of entries equals current balance, always).

---

### T3.7 - Contracts (grants)

**Goal:** goals and money.

**Depends on:** T3.6

**Files:** `packages/sim/src/systems/contractSystem.ts`, `packages/data/contracts.json`

**Spec:**
- Contract definitions with `todoItems` expressed as **declarative predicates over world state**, for example `{ type: 'roomCount', roomId: 'cell', min: 8 }`, `{ type: 'staffHired', staffId: 'warden', min: 1 }`, `{ type: 'programCompletions', programId: 'basic_literacy', min: 20 }`. Add a predicate evaluator with about 12 predicate types.
- Advance on accept, completion bonus when all items pass. Cancellation refunds the advance plus 10%.
- Concurrency cap of 2, raised to 3 by the Additional Contract node.
- Hidden contracts appear when their reveal predicate passes.

**Acceptance:**
- The five starting contracts are completable in a real playthrough.
- The Rescue Package appears exactly once, when insolvency is imminent.

**Tests:** every predicate type, completion detection, cancellation maths, hidden reveal conditions.

---

### T3.8 - Staff needs, breaks and morale

**Goal:** staff are people too, and neglecting them has teeth.

**Depends on:** T2.7, T3.3

**Files:** `packages/sim/src/systems/staffNeedsSystem.ts`, `packages/sim/src/entities/morale.ts`

**Spec:**
- Staff needs per PRD 5.6: `bladder`, `rest`, `food`, `comfort`, `safety`, `recreation`, `environment`, `warmth`. Enabled by a map setting, default on.
- Staff satisfy needs only during break periods, and only in staff-accessible rooms (break room, staff-only canteen, store, control room, armoury, kennel, offices, or any staff-only sector). They finish their current job before starting a break, and abandon the break if nothing is available after a timeout.
- Prison-wide `morale` 0 to 100 with the input weights and effect formulas in PRD 5.6: search effectiveness, movement speed, bribe chance.
- Bribes: a pissed-off officer performing a search has a `max(0, (35 - morale) / 100)` chance of finding contraband and pocketing it instead of confiscating. This emits a CausalEvent so it is visible in the Trace.
- Strike: at morale below 10, all non-emergency staff stop working for 24 hours and a pay demand notification appears with accept and refuse options. Refusing raises the probability of the next strike.
- Staff needs and morale feed the danger level.

**Acceptance:**
- A prison with no break room sees morale fall and a strike within roughly 10 in-game days.
- Low morale visibly reduces contraband detection, verifiable by a scenario test.

**Tests:** need satisfaction routing to staff-only rooms, break timing, morale formula inputs, each effect formula, bribe rate, strike lifecycle and repeat-strike escalation.

---

## Phase 4 - Control

**Goal:** the security half of the game.

**Exit criteria:** contraband circulates, inmates misbehave and are punished, danger rises, riots happen and can be contained, tunnels get dug and found.

---

### T4.1 - Sectors, access and posts (deployment)

**Goal:** the player controls who goes where and where staff stand.

**Depends on:** T2.1

**Files:** `packages/sim/src/world/sectors.ts`, `packages/sim/src/systems/postSystem.ts`, `packages/ui/src/panels/Posts.tsx`

**Spec:**
- Sectors are player-painted groupings of regions. Each sector has: name, colour, access mode (`staffOnly` | `secure` | `shared` | `open`), and an optional security category restriction.
- Access affects the region graph's edge masks, so pathfinding automatically respects it.
- **Posts** per PRD 3.5: `{ id, sectorId | objectId, staffRole, count, timeWindows: HourRange[] }`. `postSystem` assigns staff to satisfy posts each hour, preferring the nearest idle eligible staff. Unfilled posts produce a badge and a notification.
- Manual pinning of an individual staff member overrides post assignment.
- Patrol routes: an ordered list of waypoints, walked in a loop, with an optional time window.

**Acceptance:**
- Restricting a sector to maximum security prevents minimum security inmates from pathing into it.
- Creating a "3 officers in the mess hall during meal blocks" post results in exactly 3 officers there at those hours.
- Unfilled posts are reported with the reason (not enough staff hired, or none reachable).

**Tests:** access mask propagation to the region graph, post satisfaction algorithm, time window handling, patrol looping.

---

### T4.2 - Contraband

**Goal:** the illicit economy.

**Depends on:** T4.1, T3.4

**Files:** `packages/sim/src/systems/contrabandSystem.ts`

**Spec:**
- Implement all five acquisition vectors plus crafting, per PRD 5.10.
- **Room-as-source:** an inmate in a permitted room rolls, each 6 minutes, `pTheft = base * (1 - 0.65 * guardsInRoomFactor) * traitModifier`. On success they gain an item from the room's `sourceRooms` list and hide it (in their cell, or carried).
- Stashes: hidden items live at a tile, discoverable only by search or informant.
- Trading: hourly, inmates with unwanted items and inmates with demand match up within a region and trade at the computed price. Money changes hands.
- Throw-ins: an inmate with phone or visit access arranges a drop. At the arranged time they walk to a boundary tile and collect. Interceptable by having an officer or dog there.

**Acceptance:**
- An unguarded workshop reliably leaks tools to inmates.
- Placing a weapon rack in the yard yields nothing, because the yard is not a source room. (This is the deliberate abstraction, verify it holds.)
- Contraband prices respond to supply and demand.

**Tests:** each acquisition vector in isolation, guard suppression of theft, price computation, throw-in interception.

---

### T4.3 - Search, detection and Standing Orders

**Goal:** the player can fight back.

**Depends on:** T4.2

**Files:** `packages/sim/src/systems/searchSystem.ts`, `packages/ui/src/panels/StandingOrders.tsx`

**Spec:**
- Search kinds: individual, cell, block, prison-wide shakedown, intake (automatic in the intake hall).
- Detection rates per PRD 5.10, scaled by staff morale.
- Metal detectors and dogs as passive detectors with their own roll on pass-through.
- Standing Orders panel: a matrix of misconduct type against punishment (`ignore` | `lockdown` | `isolation`) and duration, plus search triggers per misconduct type, plus cell reassignment strictness, plus meal quantity and variety.
- Searches raise mood cost: individual small, shakedown large.

**Acceptance:**
- An intake hall with 4 officers finds essentially all arrival contraband, at the cost of a visible intake delay.
- A shakedown finds most stashes and visibly spikes the danger level afterwards.

**Tests:** detection probability under morale variation, standing order application on each misconduct type, mood cost accounting.

---

### T4.4 - Misconduct, punishment and suppression

**Goal:** behaviour has consequences.

**Depends on:** T4.3

**Files:** `packages/sim/src/systems/{misconductSystem.ts,punishmentSystem.ts}`

**Spec:**
- Misconduct roll per PRD 5.4, evaluated per inmate every 10 in-game minutes.
- Misconduct kinds: `complaint`, `contraband`, `intoxication`, `destruction`, `attackInmate`, `attackStaff`, `seriousInjury`, `homicide`, `escapeAttempt`.
- On misconduct: emit CausalEvent, apply Standing Orders punishment, reset entitlement, log to rap sheet, apply auto-reclassification rules.
- Punishment: escort to cell or isolation, hold for the duration, deliver meals during the hold.
- Suppression accrual and effects per PRD 5.11.
- `agitator` reputation: on misconduct, inmates within 5 tiles get a temporary large boost to their own misconduct probability.

**Acceptance:**
- A prison with all needs met sees near-zero misconduct. Cutting off food produces escalating misconduct within a day.
- Isolation visibly suppresses and visibly harms reform.

**Tests:** each roll modifier in isolation, punishment lifecycle, suppression accrual and decay rates, agitator propagation.

---

### T4.5 - Combat and injury

**Goal:** fights, injuries, deaths.

**Depends on:** T4.4

**Files:** `packages/sim/src/systems/combatSystem.ts`, `packages/sim/src/entities/health.ts`

**Spec:**
- Combat is turn-based per weapon recharge, not per tick. An attacker with a weapon strikes for `attackPower`, modified by `strong`/`very_strong` (+50%/+100%) and reduced by `hardy`/`very_hardy` (-33%/-50%) and by protective vests (-50%).
- `deadly`/`very_deadly` grants a chance of an instant kill. `trained_fighter`/`expert_fighter` grants a disarm chance.
- Ranged weapons: line of sight, range, accuracy roll.
- Stun devices: instant incapacitation for a duration, one charge, one hour recharge, `very_hardy` may resist.
- Health 0 to 100. Below 30, the inmate is incapacitated and needs an escort to the clinic. At 0, death: a corpse entity, a mortuary job, a hearse pickup, and a death count entry.
- Medics heal nearby injured agents over time. Untreated overdose kills on a timer.

**Acceptance:**
- A fight between two average inmates lasts a plausible number of in-game minutes and usually ends in injury, not death.
- Officer intervention reliably ends fights, with intervention time scaling with distance.

**Tests:** damage maths for every trait combination, disarm and instant kill rolls, incapacitation and death flow, corpse handling.

---

### T4.6 - Danger, riots and emergency response

**Goal:** the prison can fall apart, and be put back together.

**Depends on:** T4.5

**Files:** `packages/sim/src/systems/{dangerSystem.ts,riotSystem.ts,emergencySystem.ts}`, `packages/ui/src/panels/Emergency.tsx`

**Spec:**
- Danger formula per PRD 5.11, recomputed every 6 in-game minutes.
- Riot trigger and spread per PRD 5.11. Rioting inmates attack staff, destroy objects, break doors, and attempt to reach an exit.
- Emergency ladder per PRD 3.7, all five levels with their stated costs and side effects.
- Riot squad and national guard are temporary callable staff with their own equipment and behaviour.
- Containment detection: no rioting inmates for 10 continuous minutes.
- Failure countdown per PRD 5.15, with the CEO-equivalent warning notification.

**Acceptance:**
- A deliberately neglected prison riots within a plausible timeframe.
- Each emergency level has the stated effect and cost.
- The riot failure condition fires exactly on schedule and is cancelled correctly by containment.

**Tests:** danger formula components, riot spread on a fixture, each emergency level's effects, failure countdown timing.

---

### T4.7 - Escapes and tunnels

**Goal:** the most-loved emergent system.

**Depends on:** T4.6

**Files:** `packages/sim/src/systems/escapeSystem.ts`

**Spec:**
- Tunnel entity: `{ originTile, tiles: TileId[], diggerIds, discovered }`. Digging per PRD 5.11.
- Tunnels merge when their heads meet, forming a shared network.
- Detection: dog pass within 2 tiles of an entrance (25% per pass), cell search (100%), maintenance sweep. Discovery collapses the tunnel and triggers punishment for every digger.
- Reaching the map edge or an unowned parcel escapes every inmate connected to the network, over several nights.
- Other escape routes: unlocked or breached doors during a riot, fence climbing with rope or `very_strong`, vehicle theft with the `driver` trait, and simply walking out of a badly zoned prison.
- Escape count feeds the failure condition.

**Acceptance:**
- A `clever` inmate with a screwdriver in a cell with a toilet digs a tunnel over several nights and escapes if undetected.
- A dog patrol past the cell block reliably finds tunnels over time.

**Tests:** dig progress maths, tunnel merging, each detection method, escape resolution for a network, escape count accounting.

---

### T4.8 - Fire

**Goal:** the other emergency.

**Depends on:** T4.6

**Files:** `packages/sim/src/systems/fireSystem.ts`

**Spec:**
- Fire as a per-tile intensity value. Spread to adjacent tiles based on the flammability of the floor material, wall material and objects present.
- Ignition sources: lighter contraband, workshop accident event, electrical fault on an overloaded branch.
- Damage: objects lose hp, agents in a burning tile take damage per second.
- Suppression: sprinklers (water-connected, automatic within radius), firefighters (callable emergency staff with hoses).
- Smoke: reduces visibility and adds a temporary movement penalty.

**Acceptance:**
- A fire in a wooden-floored dormitory spreads and destroys the room if unanswered.
- Sprinklers contain a fire without intervention.

**Tests:** spread rates per material, damage application, sprinkler coverage, firefighter behaviour.

---

## Phase 5 - Depth

**Goal:** the long game: research, reform, grading and the moral ledger.

**Exit criteria:** the Directorate tree is fully navigable, programs run and change outcomes, room grading drives cell assignment, parole works, and re-offending is tracked and displayed.

---

### T5.1 - The Directorate (research)

**Goal:** progression gating.

**Depends on:** T3.6

**Files:** `packages/sim/src/systems/directorateSystem.ts`, `packages/ui/src/panels/Directorate.tsx`

**Spec:**
- Node graph from `directorate.json`, with prerequisites, cost, in-game duration and unlocks.
- A node requires its owning administrator to be hired and to have a functional office. Research progresses only while that condition holds.
- Unlocks gate: room availability, object availability, staff hireability, panel availability, and specific mechanics.
- UI: zoomable node graph per PRD 5.8, with a detail sheet per node including the "why do I want this" copy.

**Acceptance:**
- Every gated feature in the game is genuinely locked until its node completes.
- Firing the Security Director pauses all Security branch research and says so.

**Tests:** prerequisite enforcement, pause on missing administrator, every declared unlock actually gates its feature (a test that enumerates unlocks and asserts the gate exists).

---

### T5.2 - Room grading and the entitlement ladder

**Goal:** the reward loop.

**Depends on:** T1.3, T4.4

**Files:** `packages/sim/src/systems/gradingSystem.ts`

**Spec:**
- Evaluate `GradingRuleSet` for every graded room, hourly. Produce both a score and a **line-by-line breakdown** for the inspector.
- Entitlement per PRD 5.2.
- Hourly reassignment pass matching entitlement to grade, respecting Standing Orders strictness and sector category restrictions. Reassignment generates escort jobs.
- Sector grading: mean of the graded rooms in the sector, used for sector-level assignment.
- Misconduct probability modifier from cell grade versus prison average.

**Acceptance:**
- Building one luxurious cell block and one bare one causes well-behaved inmates to migrate to the good one over several days.
- The cell inspector shows exactly which objects contributed which points.

**Tests:** every grading rule type against fixtures, entitlement accrual and reset, reassignment ordering, the misconduct modifier formula.

---

### T5.3 - Programs and reform

**Goal:** rehabilitation as a mechanic.

**Depends on:** T5.1, T2.6

**Files:** `packages/sim/src/systems/programSystem.ts`, `packages/ui/src/panels/Programs.tsx`

**Spec:**
- Program definitions per PRD 5.9. Auto-scheduling into contiguous `work_*` blocks, with manual pinning once Delegation is researched.
- Enrolment: referred (automatic on a trigger condition), voluntary (inmates opt in, weighted by suppression and mood), mandatory (staff).
- Session execution: tutor and inmates converge on the room, occupy the required objects, and the session runs for its duration. Success roll per session per PRD 5.9.
- Completion applies the program's effects.
- **Blocking reason reporting:** if a program cannot be scheduled or cannot run, the panel states exactly why, with the specific number.

**Acceptance:**
- Every program in the data file can be run end to end in a real prison.
- A program with no contiguous work block reports that precise reason.

**Tests:** scheduling algorithm including the contiguity constraint, enrolment rules, success roll modifiers, effect application, every blocking reason.

---

### T5.4 - Grades, parole and re-offending

**Goal:** the moral ledger.

**Depends on:** T5.3

**Files:** `packages/sim/src/systems/{gradesSystem.ts,paroleSystem.ts,releaseSystem.ts}`

**Spec:**
- Four per-inmate grades per PRD 5.5, recomputed hourly:
  - `punishment` from time in isolation and lockdown relative to sentence
  - `reform` from programs completed, minus suppression exposure
  - `security` from misconduct frequency and severity
  - `health` from mean need satisfaction, injuries and addiction state
- `reoffendChance` derived: `clamp(0.55 - 0.10*basicLiteracy - 0.20*vocational - 0.15*joinery + 0.30*activeAddiction + 0.20*suppressionExposure - 0.10*healthGrade + 0.15*(misconductRate), 0.02, 0.95)`. Tunable in `balance.json`.
- Parole: inmates become eligible at 50% of sentence served. A queue feeds hearings. Outcome roll from reform grade, misconduct history and time served. Denial applies the `angry` status. Approval releases early.
- Release: at sentence end or on parole. The inmate leaves via the dock. A released inmate rolls against `reoffendChance` after a delay; a re-offence is recorded and counts toward the failure condition.
- Statistics panel tracks lifetime release count, re-offence count and rolling rate.

**Acceptance:**
- A reform-focused prison and a punishment-focused prison produce visibly different re-offending rates over 60 in-game days.
- The failure condition for parole recidivism fires correctly.

**Tests:** each grade formula, reoffend derivation, parole eligibility and outcome, release flow, statistics accumulation.

---

### T5.5 - Utilities: power, water, temperature

**Goal:** infrastructure with teeth.

**Depends on:** T1.4

**Files:** `packages/sim/src/systems/utilitiesSystem.ts`, `packages/sim/src/world/{powerGrid.ts,waterGrid.ts}`

**Spec:**
- Grids as connected components over cable and pipe tiles, rebuilt incrementally.
- Capacity, demand and priority-based load shedding per PRD 5.12. **No total trip.** Shed the lowest-priority branch and name it in the notification.
- Water flow with fixture demand; insufficient flow slows fixture use rather than stopping it.
- Temperature: heat sources warm nearby tiles, propagating with a simple diffusion pass every 60 ticks. Outdoor temperature follows a day cycle and a season setting. Drives the `warmth` need and the `exposure` status.
- Auto-routing per PRD 3.4: shortest path from the object to the nearest live grid node, presented as a preview.

**Acceptance:**
- Overloading a grid browns out the correct branch and produces a Trace naming the shortfall in watts.
- Auto-routing produces sensible cable runs in a typical layout, and manual routing still works.

**Tests:** grid connectivity, capacity and shedding order, water flow distribution, temperature diffusion, auto-route pathing.

---

### T5.6 - Intelligence: informants, monitoring, the danger map

**Goal:** information as a resource.

**Depends on:** T4.2, T5.1

**Files:** `packages/sim/src/systems/intelligenceSystem.ts`, `packages/ui/src/panels/Intelligence.tsx`

**Spec:**
- Informant recruitment: inmates with low loyalty and high fear can be recruited. Each informant reveals stashes, arranged throw-ins and hidden reputations within a radius.
- Informants can be **blown** (chance per day, raised by careless handling such as visible summons), after which they become assassination targets.
- Phone monitoring: reveals arranged throw-ins and hidden reputations for inmates who use monitored booths.
- Intelligence panel: contraband source map by room, live price and supply/demand table, informant roster with coverage radius shown on the map, and a revealed-reputation list.

**Acceptance:**
- Recruiting three informants meaningfully reduces contraband circulation, and losing one produces a murder attempt.

**Tests:** recruitment eligibility, reveal radius, blow probability and consequences, phone tap reveals.

---

### T5.7 - Prison labour and production

**Goal:** inmates earn their keep.

**Depends on:** T5.1, T3.2

**Files:** `packages/sim/src/systems/labourSystem.ts`

**Spec:**
- Job assignment UI: assign inmates to kitchen, laundry, cleaning, workshop, library, mail, commissary and grove, subject to program prerequisites.
- Workshop production: raw material in, finished goods out, goods to dispatch, sale on truck pickup. Two product tiers (basic and, with Joinery, high value).
- Grove: trees grow over time, are felled by assigned inmates, and produce timber for sale or workshop input.
- Commissary: inmates spend their in-prison money on luxury goods, generating revenue and discharging the `luxury` need.
- Working discharges `freedom` slightly and contributes to the reform grade.

**Acceptance:**
- A workshop with 10 assigned inmates produces a measurable, positive income stream.
- Working inmates show lower misconduct than idle ones, all else equal.

**Tests:** production throughput, prerequisite enforcement, commissary economics, grove growth cycle.

---

## Phase 6 - Polish and platform

**Goal:** it ships.

---

### T6.1 - Overlays

All overlays from PRD 6.4, implemented as a single shader-driven layer reading a data texture. One draw call regardless of map size. Colour-blind safe palettes with a shape or value component. Legend chip.

### T6.2 - Reports and statistics

Every report panel from PRD 6.2. Charts via a minimal custom canvas renderer, not a chart library. Searchable event log with filters by severity, category and entity.

### T6.3 - Notifications and alerts

Three severities, grouping within 60 in-game minutes, per-category mute, optional auto-pause on critical, and a `traceId` on every warn-or-above.

### T6.4 - Onboarding

The Guided Contract per PRD 3.8. Coach marks triggered by 60 seconds of inaction toward the current objective. Fully skippable. A "show me everything" veteran mode.

### T6.5 - Map creation and settings

New prison flow: map size, starting funds, continuous intake toggle, individual failure condition toggles, event toggle, mutator list, seed entry. Settings screen: audio, accessibility, autosave frequency, colour-blind palette, reduce motion, dynamic type.

### T6.6 - Art pass

Replace all placeholder art. Packed atlas, 32x32 base sprites, palette per PRD 7.7. Wall autotile set, floor material set, 90 object sprites, agent sprite sheet with 4 directions and 4 frames, UI icon set.

### T6.7 - Audio

Ambient loop layered by danger, positional one-shots, mixer with separate music and SFX sliders, full mute.

### T6.8 - Capacitor packaging and device QA

Capacitor 6 iPadOS project. App icons, launch screen, orientation lock to landscape on iPad (portrait supported with the rail layout), safe area handling, background/foreground autosave, memory warning handling. Verify the build runs on Apple Silicon Macs via "Designed for iPad". Full pass on the device matrix in PRD 2.2.

### T6.9 - Performance hardening

Profile on the baseline device. Meet every budget in PRD 7.5. Add the CI performance regression test. Fix the top three hotspots found.

### T6.10 - Accessibility audit

Every requirement in PRD 7.9, verified with VoiceOver on device, at 130% dynamic type, with each colour-blind palette, and with Reduce Motion on.

---

## Phase 7 - Scenario tests and release candidate

### T7.1 - Scenario test suite

Build the headless scenario runner and write these named scenarios, each asserting both the outcome and the expected Trace chain:

1. `starvation` - undersized kitchen, assert deaths and the five-node trace
2. `riot-escalation` - remove all food and guards, assert riot within 48 hours
3. `power-brownout` - overload a grid, assert the correct branch sheds
4. `tunnel-escape` - one clever inmate with a tool, assert escape by night 5 without dogs, and no escape with dogs
5. `contraband-flood` - unguarded workshop, assert weapon prevalence rises
6. `reform-vs-punishment` - two identical prisons, opposite policies, assert divergent re-offending
7. `bankruptcy` - overstaffed prison, assert insolvency countdown and rescue contract
8. `full-day-loop` - correctly built prison, 30 in-game days, assert zero deaths, zero escapes and all needs satisfied
9. `capacity-stress` - 400 inmates, 1000 ticks, assert performance budget
10. `save-migration` - v1 save loads under the current schema and produces an identical hash after 100 ticks

### T7.2 - Balance pass

Use `tools/balance` to run headless simulations across a parameter sweep. Tune `balance.json` so that: a competent player is profitable by day 10, a neglectful player riots by day 20, and re-offending ranges from roughly 20% to roughly 70% depending on play style.

### T7.3 - Release candidate

Feature freeze. Full device matrix pass. Five external playtest sessions of 60 minutes with observation notes. Fix blockers only.

---

## Phase 8 - Remediation and release

**Goal:** close the gap between a finished simulation and a finished game.

Phases 0 to 5 shipped. `packages/sim` holds 40 registered systems in PRD 4.4 order with 928 test cases and no violations of the hard rules. Phase 6 landed T6.1 to T6.5 and T6.7. What did not happen is the wiring: the composition root never connected large parts of the finished simulation to the finished interface, and three shipped tickets carry silent correctness holes that no test could see.

Each ticket below names the ticket it repairs. Ticket IDs remain stable - these are new IDs, not renumbered old ones.

**Exit criteria:** every system in PRD 5 is reachable through the interface, every `warn` or above notification produces a correct Trace, a save round-trips to an identical world hash, and the build installs on an iPad.

---

### T8.0 - Baseline and plan record

**Goal:** a clean rollback point and a plan document that describes the remaining work.

**Depends on:** nothing

**Files:** `docs/03-plan.md`, `.claude/launch.json`

**Spec:**
- Branch off `main` and commit the in-flight Phase 6 work as one commit.
- Append this Phase 8 section.
- Remove the `security-check-web` launch configuration, which points at a directory that does not exist in this repository.

**Acceptance:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass on the new branch.

**Tests:** none - this ticket writes no product code.

---

### T8.1 - Committed money reaches the balance promptly

**Goal:** make the top bar tell the truth about a build the player just committed.

**Depends on:** T8.0. **Repairs:** T3.6

**Files:** `packages/sim/src/entities/economy.ts`, `packages/sim/src/systems/economySystem.ts`

**Spec:**

The money pipeline is complete and correct - this was verified by probe, after an initial reading of the code wrongly concluded that building was free. Committing a blueprint calls `settle`, which tallies into `world.addSpend`; `drainOutboxes` moves the tally into the ledger under the `construction` category; demolition refunds go the same way under `construction_refund`; `hireStaff` calls `addSpend(def.hireCost)`. An unknown material id is refused with a `construction.rejected` CausalEvent rather than silently building for nothing.

The defect is cadence, not correctness. `drainOutboxes` ran on the economy system's hourly period, so a player who committed a $1,536 build watched the balance sit unchanged for up to a full in-game hour - about a minute of real time at 1x. PRD 6.3 step 5 says commit deducts the money.

Drain the outboxes every in-game minute while leaving wages, utility bills, loan interest and insolvency hourly. A minute divides an hour exactly, so the hourly settlements land on precisely the ticks they always did and no balance arithmetic changes; the entries simply post sooner.

**Acceptance:**
- A committed build is reflected in the balance within one in-game minute.
- Demolition refunds credit on the same cadence.
- Wages, utilities, interest, tax and insolvency are unchanged, hourly and daily respectively.

**Tests:** spend and refund both post within `ECONOMY_DRAIN_PERIOD`; `wagesPaid` still fires on the hour and not before.

**Note:** commit deliberately does *not* check affordability. Balance may go negative and insolvency is a PRD 5.15 failure condition with its own countdown, so refusing the build would remove a designed failure path.

---

### T8.2 - Objects render

**Goal:** make placed furniture visible.

**Depends on:** T8.0. **Repairs:** T1.6

**Files:** `packages/app/src/game/session.ts`, `packages/render/src/layers/objects.ts`

**Spec:** `ObjectLayer` is complete - y-sorting, frustum culling, chunk-local sort - and `setObjects()` has no caller anywhere in `packages/app`. `session.ts` exports `NO_RENDER_OBJECTS`, a permanently empty array, described in its own comment as a placeholder. Delete it and feed the layer from the snapshot's object entities on the frame loop, beside the existing agent feed.

**Acceptance:** an object placed through the build tools appears in the world view and sorts correctly against agents and walls.

**Tests:** a render test asserting a placed object reaches the layer's sprite pool and is culled when off-camera.

---

### T8.3 - Real construction workforce

**Goal:** delete the last Phase 1 stub.

**Depends on:** T8.2. **Repairs:** T1.2

**Files:** `packages/app/src/game/session.ts`, `packages/app/src/worker/simWorker.ts`, `packages/sim/src/systems/constructionSystem.ts`

**Spec:** `STUB_BUILDERS = 1` feeds a `builders` field on `sim:init` whose own doc comment says "Phase 2 brings agents and this goes away". Phase 2 shipped. Drive `constructionSystem`'s `Workforce` from real staff through the job system and remove the field from the message protocol.

**Acceptance:** construction rate scales with the number of workers actually on site; no site progresses with nobody assigned.

**Tests:** construction progress is zero with no workforce, and proportional to headcount with one.

---

### T8.4 - A new prison is startable

**Goal:** a player can build the first thing.

**Depends on:** T8.3

**Files:** `packages/sim/src/core/mapSettings.ts`, `packages/app/src/game/session.ts`

**Spec:** `balance.json` sets `stubMaterialDelivery: false`, so every construction site blocks on `materials` until the dock to store to site chain runs. A fresh map has no dock, no store and no guidance, so the first foundation never gets built. Define the opening state through `mapSettings`: a starting delivery zone and material stockpile, or an explicit first-order grace path. Whichever is chosen must be data-driven and must appear in the New Prison panel.

**Acceptance:** from a brand-new prison, following only the Guided Contract, a player reaches a functioning holding cell without outside knowledge.

**Tests:** a headless test that starts a default map, issues the Guided Contract's build sequence, and asserts a functional cell within the expected tick budget.

---

### T8.5 - The save format covers the whole world

**Goal:** a save that actually contains the game.

**Depends on:** T8.0. **Repairs:** T0.6

**Files:** `packages/sim/src/save/{format,fromWorld,toWorld,state}.ts`, `packages/sim/src/save/migrations/index.ts`

**Spec:**
- `SaveFile` omits state that `InmateWorld.hashInto` treats as authoritative: `labour`, `morale`, `jobs`, `meals`, `supply`, `deliveries`, `cleaning`, `laundry`, `needsRuntime`, `routineRuntime`, `escorts`, `offices`, `fog`, the `intake` policy, `cellGrades`, undrained income and the staff-only room sets. `LabourRuntime.serialise()/restore()` and `MoraleState.snapshot()` already exist and are never called.
- `toWorld` hardcodes `convictions: []`, `reputations: []`, `addictions: []`, `jobId: null` and `misconductLog: []`, so a load erases every inmate's history - the same history that drives security grade, parole, reoffend chance and combat.
- `SerialisedEntity` is `{ id, kind }` plus an index signature, so the omissions are structurally legal and invisible to the type checker. Give it real fields.
- Bump `CURRENT_SAVE_VERSION` to 5 with a migration step. Never break a save silently.

**Acceptance:** a world saved after N ticks and reloaded produces an identical `world.hashInto` digest.

**Tests:** the live-world round-trip test. `hashSaveState` only hashes what `SaveState` already declares, so it is self-consistent by construction and cannot catch this; the assertion must be against `world.hashInto`. A v4 save must migrate and load.

---

### T8.6 - Load path and pause menu

**Goal:** a player can reach their own saves.

**Depends on:** T8.5. **Repairs:** T0.6

**Files:** `packages/app/src/game/session.ts`, `packages/app/src/worker/{bridge,simWorker}.ts`, `packages/ui/src/panels/`, `packages/app/src/App.tsx`

**Spec:** `SaveStore` rotates five autosave slots and `save/file.ts` exports and imports `.blockwork` files. Neither can be read back: there is no `Session.load`, no `SaveStore.get` call and no interface route. Add `Session.load(bytes)` and a `sim:load` worker message, then build the pause menu behind the existing dead `onMenu` prop: Resume, Save, Load listing the store's descriptors, Export and Import, Settings, New Prison, Quit.

**Acceptance:** save mid-game, reload the page, restore, and the prison is identical.

**Tests:** panel test for the menu; an integration test round-tripping through `SaveStore`.

---

### T8.7 - Mount the finished panels

**Goal:** four built panels reach the screen.

**Depends on:** T8.6. **Repairs:** T6.3, T6.4, T6.5

**Files:** `packages/ui/src/GameShell.tsx`, `packages/app/src/App.tsx`

**Spec:** `Settings`, `NewPrison`, `Onboarding` and `Alerts` are written, styled in `shellCss.ts`, exported from the barrel and tested - and never rendered. Mount them and wire their callbacks. This also kills the dead Alerts and Menu buttons in the permanently visible top bar.

**Acceptance:** every top-bar and dock control opens something.

**Tests:** extend the shell test to assert each panel mounts and closes.

---

### T8.8 - Wire the orphaned app modules

**Goal:** settings, audio, onboarding and notification policy take effect.

**Depends on:** T8.7. **Repairs:** T6.3, T6.4, T6.5, T6.7

**Files:** `packages/app/src/game/{appSettings,audio,webAudioBackend,onboarding,traceInbox}.ts`, `packages/app/src/game/session.ts`, `packages/app/src/main.tsx`

**Spec:**
- `appSettings.ts` is complete and imported by nothing. Apply `settingsCssVariables()` to the document, route the colour-blind palette through the existing `session.setOverlayPalette`, honour reduce motion and the 130% type scale, and act on `autosaveHours` - there is currently no timed autosave at all, only one on `visibilitychange`.
- `audio.ts` and `webAudioBackend.ts` are complete and imported by nothing; no `AudioContext` is ever created and the game is silent.
- `onboarding.ts` holds the whole Guided Contract state machine and is imported by nothing.
- `bridge.setNotificationSettings()` has no caller, so the Alerts panel's per-category mute and auto-pause never reach the worker that implements them.
- `traceInbox.ts` duplicates logic `session.ts` reimplements inline. Keep one.

**Acceptance:** changing any setting changes the running game; the game makes sound; a new player sees the Guided Contract; muting a category silences it.

**Tests:** settings application, autosave scheduling, notification settings reaching the worker.

---

### T8.9 - The four missing panels

**Goal:** finish PRD 6.2.

**Depends on:** T8.7

**Files:** `packages/ui/src/panels/{Routine,Contracts,Intake,Flow}.tsx`, `packages/ui/src/index.ts`, `packages/app/src/game/{session,palette}.ts`

**Spec:** four panels PRD 6.2 requires were never built, and their simulation commands are consequently unreachable.
- **Routine editor** - 24-hour strip per category, drag to paint blocks, conflict strip below, per-category tabs. Sends `routine.setCategory`.
- **Contracts** - active cards with checklists and progress, available list, loan controls. Sends `contracts.accept` and `contracts.cancel`.
- **Intake** - requested counts per category, continuous toggle, capacity readout, next bus ETA. Sends `intake.setRequested`, `setContinuous` and `clearRequested`.
- **Flow (logistics)** - chain diagram for meals, laundry, cleaning, construction supply and exports, throughput at each stage, bottleneck highlighted. Remove `'flow'` from `UNBUILT_TOOLS`.

Follow the established pattern: presentational only, props in and callbacks out, `role="dialog"` with a label, empty and blocked states.

**Acceptance:** each panel opens from the dock and its commands reach the simulation.

**Tests:** one panel test each, in the style of `reports.test.tsx`.

---

### T8.10 - Inspector actions and the remaining commands

**Goal:** close the last reachability gaps against PRD 9 criterion 2.

**Depends on:** T8.9

**Files:** `packages/app/src/App.tsx`, `packages/app/src/game/session.ts`, `packages/sim/src/systems/{misconductSystem,punishmentSystem}.ts`

**Spec:**
- The app never passes `onInspectorSearch`, `onInspectorDemolish`, `onInspectorReclassify`, `onInspectorPunish`, `onInspectorProtective`, `onInspectorNeedSelect`, `onTraceFix`, `onTraceCopyReport`, `onPostsSelectPost` or `onPostsSelectPatrol`. The panels guard them correctly with `disabled`, so the whole inmate action row and both Trace affordances render greyed out rather than broken. Pass them.
- Search and demolish map to commands that exist. **Reclassify, manual punish and protective custody have no simulation command at all** - add them with CausalEvents, per PRD 6.2 and PRD 5.5's editable category.
- Also wire `program.enrol` and `withdraw`, `labour.assign` and `unassign`, `staff.fire`, and `morale.acceptPayDemand` and `refusePayDemand`.

**Acceptance:** no rendered control in the shipping app is inert. Every command handler registered in `core/game.ts` has a route from the interface.

**Tests:** a test that enumerates registered command handlers and asserts each has a caller in `packages/app`.

---

### T8.11 - Redo

**Goal:** finish the undo/redo pair PRD 3.3 requires.

**Depends on:** T8.1. **Repairs:** T1.5

**Files:** `packages/sim/src/core/undo.ts`, `packages/app/src/App.tsx`

**Spec:** `onRedo` is an empty body, masked by a hardcoded `canRedo={false}`, so the button renders permanently disabled. Implement redo over the existing `CommitLedger`.

**Acceptance:** undo then redo restores the world to its pre-undo hash, including the money movements from T8.1.

**Tests:** build, undo, redo, assert hash equality and ledger balance.

---

### T8.12 - Every failure gets a Trace

**Goal:** satisfy hard rule 5.

**Depends on:** T8.0

**Files:** `packages/sim/src/trace/causalEvent.ts`, `packages/data/traceStrings.json`, `packages/sim/src/systems/gradesSystem.ts`

**Spec:** `TRACE_KINDS` and `traceStrings.json` are exactly in sync at 52 entries, but these emitted failures have no catalogue entry, so the Trace panel cannot reconstruct their chain:

`economy.insolvencyStarted`, `insolvencyFailed`, `insolvencyCancelled`, `release.recidivismWarning`, `recidivismFailure` - **two of the seven PRD 5.15 failure conditions** - plus `pathing.unreachable`, `construction.blocked`, `supply.noDock`, `supply.noStore`, `objects.unsupplied`, `intake.noHousing`, `program.blocked`, `program.droppedOut`, `punishment.isolationOverflow`, `job.abandoned`, `intelligence.blown`, `meal.missed` and `staffNeeds.breakAbandoned`.

Separately, `GRADES_EVENTS.recomputed` is declared and never emitted, so a grade change - which gates parole - is invisible.

**Acceptance:** every emitted `warn` or `critical` kind resolves to trace copy with a suggested fix.

**Tests:** extend the existing kind-coverage test to fail when any emitted kind lacks a catalogue entry, so this cannot regress.

---

### T8.13 - Balance numbers out of code

**Goal:** satisfy hard rule 4.

**Depends on:** T8.0

**Files:** `packages/sim/src/entities/{standingOrders,combat}.ts`, `packages/sim/src/systems/logistics/supply.ts`, `packages/data/balance.json`, `packages/sim/src/data/schemas.ts`

**Spec:**
- `standingOrders.ts` hardcodes player-facing punishment durations (6/4/8/12/24/36 hours), `mealVariety` and the default punishment mapping. `balance.json` already has `misconduct` and `punishment` sections to hold them.
- `supply.ts` hardcodes carry priorities and batch size; `balance.json` already has a `jobs` section.
- `combat.ts` carries a `STUB_MELEE_DAMAGE` constant by that name.

**Acceptance:** no balance number is defined in a system or entity module.

**Tests:** schema tests for the new sections; existing system tests pass against data-sourced values.

---

### T8.14 - Dead code and duplicate state

**Goal:** remove the traps.

**Depends on:** T8.0

**Files:** `packages/sim/src/entities/{securityState,inmate}.ts`, `packages/app/src/game/session.ts`, `packages/app/src/save/index.ts`

**Spec:**
- `securityState.ts` keeps a `staffHealth` map documented as a stub "until T4.5 owns health components". T4.5 shipped as `entities/health.ts`, so staff HP has two sources of truth.
- `inmate.ts` types `programEnrolment` as the literal `null`, permanently; real enrolment lives in `ProgramRuntime`.
- `session.ts` has an `if` block whose body is only comments, including an unresolved design debate.
- `packages/app/src/save/index.ts` is a barrel nothing imports.

**Acceptance:** one source of truth for staff health; no dead conditional; no unreferenced module.

**Tests:** existing suites pass; add a staff-health test asserting the single source.

---

### T8.15 - Runtime error handling

**Goal:** fail visibly instead of silently.

**Depends on:** T8.7

**Files:** `packages/ui/src/`, `packages/app/src/{main.tsx,App.tsx}`, `packages/app/src/worker/bridge.ts`, `packages/app/src/game/session.ts`

**Spec:** the boot-error fallback in `main.tsx` is well built and is the only error handling in the app. After boot there is nothing: no error boundary, so a render throw in any panel blanks the whole app including the canvas; no `window.onerror`; no `unhandledrejection`; no worker `onerror` or `onmessageerror`. `bridge.#error` captures `sim:error` and nothing reads it, so a worker crash is swallowed. `takeSpeedOverride()` has no caller, so a worker-initiated auto-pause leaves the speed control showing a stale value. Save failures log to console and return `false` with no user-visible feedback.

**Acceptance:** a panel throw is contained and reported; a worker crash surfaces; a failed save tells the player; an IndexedDB quota error is handled.

**Tests:** error boundary containment; `sim:error` surfacing; save-failure feedback.

---

### T8.16 - Production cross-origin isolation

**Goal:** ship the fast transport.

**Depends on:** T8.0

**Files:** `packages/app/vite.config.ts`, deployment configuration

**Spec:** COOP and COEP headers are set on the dev server only, so any deployed build silently falls back from the `SharedArrayBuffer` transport to `postMessage`. The fallback is correct but it is a real performance cliff and nothing warns about it.

**Acceptance:** a production build is cross-origin isolated; when it is not, the app says so.

**Tests:** a test asserting the transport choice and that the diagnostic fires when isolation is absent.

---

### T8.17 - Modal focus management

**Goal:** finish the keyboard and VoiceOver story.

**Depends on:** T8.9

**Files:** `packages/ui/src/panels/`, `packages/ui/src/theme/shellCss.ts`

**Spec:** ARIA coverage is already strong - 44pt hit targets enforced and tested, an accessible-name audit that fails the build, correct `meter`, `tablist` and `radiogroup` roles, and colour never used as the sole channel. What is missing is a focus trap and focus restoration in every `role="dialog"` panel, and `:focus-visible` styling.

**Acceptance:** Tab cannot escape an open modal; closing it restores focus to the control that opened it; focus is always visible.

**Tests:** extend `accessibility.test.tsx` with trap and restoration cases.

---

### T8.18 - Scenario runner and the named scenarios

**Goal:** build the highest-value test asset in PRD 8.

**Depends on:** T8.6, T8.10. **Implements:** T7.1

**Files:** `tools/scenario/`

**Spec:** a headless scenario runner beside `tools/replay` and `tools/balance`, then the ten scenarios listed in T7.1, each asserting both the outcome and the expected Trace chain.

**Acceptance:** all ten pass in CI.

**Tests:** the scenarios are the tests.

---

### T8.19 - Performance gate and hotspots

**Goal:** meet PRD 7.5 and keep meeting it.

**Depends on:** T8.18. **Implements:** T6.9

**Files:** `tools/scenario/`, `.github/workflows/ci.yml`, `packages/app/src/game/session.ts`, `packages/render/src/layers/agents.ts`

**Spec:** a headless 400-agent, 1000-tick test that fails the build on a mean step-time regression over 10% from a recorded baseline. Then fix the top three hotspots. Two are known: `session.ts`'s frame callback refreshes control panels, reports, the overlay, toasts and the HUD **every frame** against a 2ms main-thread budget, rebuilding a sector-colour map as it goes; and the agent layer allocates five Pixi sprites per agent, 2000 at the target headcount, with no pool ceiling.

**Acceptance:** every budget in PRD 7.5 is met on the baseline device.

**Tests:** the CI gate itself.

---

### T8.20 - Test gaps and coverage floor

**Goal:** stop trusting untested code.

**Depends on:** T8.0

**Files:** `packages/sim/test/`, `vitest.config.ts`

**Spec:** `roomSystem.ts` has zero tests and is not imported by any test file, despite existing specifically to fix a silent room-staleness bug. `inmateAgents.ts` has none. `logistics/deliveries.ts` has no direct truck-schedule test though `batchOrdersIntoTrucks` and `nextTruckTick` are pure. `traceBuilder.ts`'s depth-8 DAG walk is untested by name. Coverage is collectable and not enforced.

**Acceptance:** every system module has a dedicated test file; a coverage threshold fails CI when breached.

**Tests:** as described.

---

### T8.21 - Capacitor packaging and device QA

**Goal:** produce an app rather than a web bundle.

**Depends on:** T8.15, T8.16. **Implements:** T6.8

**Files:** `capacitor.config.ts`, `ios/`, `package.json`

**Spec:** no Capacitor project exists - no config, no `ios/`, no `@capacitor/*` dependency - despite iPadOS being the stated ship target, and `pnpm build` produces only a web bundle. Build the Capacitor 6 iPadOS project with app icons, launch screen, landscape orientation lock with the PRD 6.1 portrait rail, safe-area handling, background and foreground autosave, and memory-warning handling. Add a `build:ios` script.

**Acceptance:** the app installs and runs on the PRD 2.2 device matrix, including Apple Silicon Macs via Designed for iPad.

**Tests:** manual device matrix; a smoke test that the iOS build command completes.

---

### T8.22 - Art pass

**Goal:** replace the placeholders without introducing a single binary asset.

**Depends on:** T8.2. **Implements:** T6.6, adapted

**Files:** `packages/render/src/sprites/`, `packages/render/src/layers/`

**Spec:** every atlas is generated at runtime and there are no image files in the repository at all, which is why hard rule 1 is trivially safe. Keep that and do a real design pass against PRD 7.7: per-object silhouettes replacing the six shared placeholder footprints and the hash-derived colours, the full 47-tile wall autotile set through the existing `autotile.ts`, a proper hinged door sweep in place of the stand-in, four-direction four-frame agent animation with the category tint on the uniform layer, and the floor material set. `sprites/palette.ts` already encodes the PRD 7.7 swatches. Remove every `PLACEHOLDER_*` table.

**Acceptance:** at default zoom a player can identify category, activity and mood at a glance. No `PLACEHOLDER_` identifier remains.

**Tests:** atlas generation determinism; autotile mask coverage across all 47 cases.

---

### T8.23 - Effects layer

**Goal:** the sixth render layer.

**Depends on:** T8.22. **Implements:** PRD 7.6 layer 6

**Files:** `packages/render/src/layers/effects.ts`, `packages/render/src/app.ts`

**Spec:** selection rings, path debug and notification pins. The renderer's own comment defers this layer to a later ticket; this is that ticket.

**Acceptance:** selecting an entity rings it; a notification pins to its subject.

**Tests:** layer test for ring placement and pin lifecycle.

---

### T8.24 - Balance pass

**Goal:** numbers that produce a game.

**Depends on:** T8.18. **Implements:** T7.2

**Files:** `packages/data/*.json`

**Spec:** **every content entry in the repository carries `_tuning: true`** - all 93 objects, 35 contraband items, 32 rooms, 22 staff roles, 19 needs, 10 contracts, 70 inmate entries and 32 of 38 balance sections. The loader deliberately surfaces the flag so a tuning pass can find them; no such pass has run. Sweep with `tools/balance` until a competent player is profitable by day 10, a neglectful player riots by day 20, and re-offending spans roughly 20% to 70% by play style. Clear each flag as its section is fixed. Expand `contracts.json`: 10 entries against a 3-concurrent cap means one playthrough sees almost the whole pool.

**Acceptance:** the three curves hold across the scenario suite. No `_tuning` flag remains.

**Tests:** scenario assertions on the three curves.

---

### T8.25 - Accessibility audit

**Goal:** verify PRD 7.9 on hardware.

**Depends on:** T8.17, T8.21. **Implements:** T6.10

**Spec:** the mechanisms exist and become reachable once T8.8 lands. Verify with VoiceOver on device, at 130% dynamic type, under each colour-blind palette, and with Reduce Motion on.

**Acceptance:** every PRD 7.9 requirement verified on device with notes.

**Tests:** verification, not construction; record findings as tickets.

---

### T8.26 - Release candidate

**Goal:** ship.

**Depends on:** every preceding Phase 8 ticket. **Implements:** T7.3

**Spec:** feature freeze, full device matrix pass, five 60-minute external playtest sessions with observation notes, blockers only.

**Acceptance:** all seven PRD 9 success criteria demonstrably met.

---

## Dependency graph summary

```
Phase 0: T0.1 -> T0.2 -> T0.3 -> T0.4 -> T0.5
                       T0.3 -> T0.6
Phase 1: T1.1 -> T1.2 -> T1.3 -> T1.4 -> T1.5
                                 T1.4 -> T1.6
Phase 2: T2.1 -> T2.2 -> T2.3 -> T2.4 -> T2.5 -> T2.6
                                 T2.4 -> T2.7 -> T2.8 -> T2.9
Phase 3: T3.1 (early, needs T2.5)
         T3.2 -> T3.3 -> T3.6 -> T3.7
         T3.2 -> T3.4 -> T3.5
         T3.3 -> T3.8
Phase 4: T4.1 -> T4.2 -> T4.3 -> T4.4 -> T4.5 -> T4.6 -> T4.7
                                                 T4.6 -> T4.8
Phase 5: T5.1 -> T5.3 -> T5.4
         T5.2 (needs T4.4)
         T5.5 (needs T1.4)
         T5.6 (needs T4.2, T5.1)
         T5.7 (needs T5.1, T3.2)
Phase 6: all tickets independent, T6.9 last
Phase 7: after Phase 6
Phase 8: T8.0 -> T8.1 -> T8.11
                T8.2 -> T8.3 -> T8.4
                T8.5 -> T8.6 -> T8.7 -> T8.8
                                T8.7 -> T8.9 -> T8.10
                                T8.7 -> T8.15 -> T8.21
                                T8.9 -> T8.17
         T8.12, T8.13, T8.14, T8.16, T8.20 independent of the chain
         T8.6 + T8.10 -> T8.18 -> T8.19
                         T8.18 -> T8.24
         T8.2 -> T8.22 -> T8.23
         T8.17 + T8.21 -> T8.25
         everything -> T8.26
```

## Rough sizing

| Phase | Tickets | Estimated agent sessions |
| --- | --- | --- |
| 0 Foundations | 6 | 8 to 12 |
| 1 Building | 6 | 10 to 14 |
| 2 Life | 9 | 16 to 22 |
| 3 Operations | 8 | 14 to 18 |
| 4 Control | 8 | 14 to 20 |
| 5 Depth | 7 | 12 to 18 |
| 6 Polish | 10 | 14 to 20 |
| 7 Release | 3 | 6 to 10 |
| 8 Remediation | 27 | 34 to 46 |
| **Total** | **84** | **128 to 180** |

Assume roughly 1.5 agent sessions per ticket on average, with the pathfinding, contraband and grading tickets being the most likely to need a second pass.

Phase 8 tickets run smaller than the average because most of them connect code that already exists and already has tests. The exceptions are T8.5 (save coverage), T8.9 (four new panels), T8.18 (scenario runner), T8.21 (Capacitor) and T8.22 (art), which are full-sized.
