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
| **Total** | **57** | **94 to 134** |

Assume roughly 1.5 agent sessions per ticket on average, with the pathfinding, contraband and grading tickets being the most likely to need a second pass.
