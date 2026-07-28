# Blockwork - Product Requirements Document

**Version:** 1.0
**Target platforms:** iPadOS (primary), macOS (Apple Silicon via "Designed for iPad", plus a native wrapper later), web build for development
**Genre:** Top-down tile-based prison management simulation, freeplay only
**Working codename:** `blockwork`

Companion documents: `01-teardown.md` (research), `03-plan.md` (build tickets), `04-ui-mockups.html` (visual spec), `../CLAUDE.md` (agent instructions).

---

## 1. Vision

Blockwork is a prison management sim with the simulation depth of Prison Architect and none of its interface archaeology. You draw a prison with your fingers, watch a living population fail in legible ways, and fix it.

The three-sentence pitch: **You run a private prison. Every inmate is simultaneously your revenue and your risk. The game is about how much cruelty you are willing to trade for control, and it never lets you forget the number.**

### 1.1 Design pillars

**1. Legible causality.** Every bad outcome traces back to a cause the player can see. If a prisoner starves, the game can show you the exact broken link in the food chain. This is the single biggest improvement over the reference game.

**2. Touch-native, not touch-ported.** Designed for a finger on a 11 inch screen first. No tiny icons, no hover-dependent information, no right-click, no modifier keys. Direct manipulation, gesture-driven camera, generous hit targets.

**3. Depth through interaction, not through count.** Fewer systems, each of which talks to more of the others. Resist adding a system that only touches one other system.

**4. The moral ledger.** Re-offending rate sits beside the bank balance at all times. The game presents both without editorialising. The player decides which one they are optimising.

**5. Performance is a feature.** A 200x200 map with 400 inmates must hold 60fps on an iPad Air. This is a hard constraint that shapes the architecture, not a late optimisation pass.

### 1.2 Non-goals for v1

- Campaign or story mode
- Escape Mode / playing as a prisoner
- Multiplayer or cloud sync
- Steam Workshop style modding (but the data layer must be mod-ready)
- 3D rendering
- Female prisons, babies, nurseries (post-v1)
- Gangs (post-v1, but the data model reserves space)

### 1.3 Legal and IP boundaries

This is a "faithful systems, original expression" project. Rules are as follows and are non-negotiable for the implementing agent:

- **No asset reuse.** No sprites, sounds, fonts, UI graphics or text strings from the reference game.
- **No reference-game proper nouns.** Do not use its title, character names, grant names, program names, warden names or crime-list flavour text verbatim. Rename everything.
- **Systems and mechanics are not copyrightable and may be replicated.** Numeric balance values may be used as a starting point and should be tuned away from exact parity where it costs nothing.
- **Original naming used in this project:** the research tree is the **Directorate**, the daily schedule is the **Routine**, misconduct rules are the **Standing Orders**, and money grants are **Contracts**.

---

## 2. Target user and platform

### 2.1 Audience

Players of management sims on tablets: RimWorld, Two Point Hospital, Dwarf Fortress, Cities Skylines, Rollercoaster Tycoon Classic, Prison Architect Mobile. They accept complexity but expect a modern interface. Session length is 20 to 90 minutes, often in bed or on a sofa.

### 2.2 Device targets

| Tier | Device | Target |
| --- | --- | --- |
| Minimum | iPad (9th gen, A13), iPhone excluded | 30fps at 150x150 map, 200 agents |
| Baseline | iPad Air (M1) | 60fps at 200x200 map, 400 agents |
| High | iPad Pro (M4), Apple Silicon Mac | 60fps at 300x300 map, 800 agents |

### 2.3 Input model

| Gesture | Action |
| --- | --- |
| One finger drag on world | Pan camera |
| Two finger pinch | Zoom (4 discrete zoom levels with smooth interpolation) |
| Two finger rotate | Nothing. Camera is axis-aligned. |
| Tap on entity | Select and open inspector |
| Tap on empty world | Deselect |
| Drag with a tool active | Paint / drag-rectangle for that tool |
| Long press (400ms) | Context radial menu for the tapped entity |
| Two finger tap | Undo |
| Three finger tap | Redo |
| Trackpad / mouse (Mac) | Full parity: scroll to pan, cmd+scroll to zoom, right click for context menu, cmd+Z undo |
| Apple Pencil | Treated as a finger, with pressure ignored. Precision mode: pencil input snaps to tile centres more aggressively. |
| External keyboard | Optional shortcuts, never required |

**Hit target minimum: 44x44 points.** No exceptions in the primary UI.

---

## 3. Improvements over the reference game

This section is the actual product differentiation. Each item is a requirement, not an aspiration.

### 3.1 The Trace panel (flagship feature)

Any failure notification is tappable and opens a **Trace**: a plain-language causal chain rendered as a vertical timeline, with each node tappable to jump the camera there.

Example, for a starvation death:

```
Inmate 4471 starved at 03:12
  <- Ate 0 meals in the last 3 Eat blocks
  <- Canteen "West Hall" had 0 meals at 12:00
  <- Kitchen "K2" produced 40 meals, needed 118
  <- Kitchen "K2" has 2 cookers, needs 6 for 118 meals
  <- [Fix: add 4 cookers]  [Fix: assign 3 more inmates to kitchen work]
```

Every simulation system must emit structured `CausalEvent` records so the Trace can be reconstructed. This is an architectural requirement that touches every system, so it is designed in from Phase 1, not bolted on.

### 3.2 Blueprint mode with commit

Building is two-phase. In **Blueprint mode** you draw freely with zero cost and zero commitment: foundations, rooms, objects, utilities. The blueprint shows a running total, a validity report ("this room is not enclosed", "this cell has no bed"), and a list of every requirement that will fail. Tapping **Commit** queues the whole thing for construction and deducts money.

This kills the "misplaced an expensive foundation" problem and makes planning a real activity.

### 3.3 Full undo/redo

Every player action is a command object on an undo stack. Blueprint edits undo freely. Committed construction undoes with a partial refund if work has already started. Depth of 50.

### 3.4 Auto-routed utilities

Placing a powered object automatically proposes a cable route from the nearest live grid, shown as a dashed preview. The player can accept, or switch to manual routing. Same for pipes. Manual routing remains available for players who want it.

Multiple power stations join into a single grid without exploding. Grid capacity is the sum of all connected sources. If demand exceeds supply, the game **browns out the lowest-priority branch** rather than tripping everything, and tells you which branch and why.

### 3.5 Intent-based deployment

Instead of pinning individual guards to tiles, the player expresses **posts**:

- "Canteen West: 3 guards during Eat, 1 otherwise"
- "Max-sec corridor: continuous patrol, 2 guards"
- "Reception: 4 guards during intake"

The game assigns actual guards to satisfy posts and shows an **unfilled posts** count. Manual pinning is still available as an override. This one change removes most of the tedium in the reference game.

### 3.6 Needs drill-down

The Needs report is not a bar chart. Tapping a need shows: how many inmates have it critical, where they are on a heatmap, which facilities serve it, the total capacity of those facilities versus demand, and the specific bottleneck.

### 3.7 Graduated emergency response

Instead of four all-or-nothing buttons, an escalation ladder with clear costs:

| Level | Action | Cost | Side effect |
| --- | --- | --- | --- |
| 1 | Sector lockdown (one sector only) | free | +suppression in that sector |
| 2 | Full lockdown | free | +suppression prison-wide, needs go unmet |
| 3 | Call in riot squad | $/hour | injuries, +fear |
| 4 | Free fire authorisation | free | deaths, huge re-offending and PR penalty |
| 5 | Call the national guard | huge $ | prison retaken, you are almost certainly fired |

### 3.8 Onboarding without a campaign

A first-run **Guided Contract**: the starting contract's to-do list doubles as the tutorial, with contextual coach marks that appear only when the player is stuck (no action taken toward the current objective for 60 seconds). Fully skippable, and a "show me everything" mode for veterans.

### 3.9 Simulation speed and time

Speeds: pause, 1x, 2x, 5x, 20x. At 20x, agent animation drops to teleport-per-tick and rendering detail reduces, but the simulation remains identical. Deterministic across speeds.

### 3.10 Other quality-of-life requirements

- Persistent, searchable event log
- Named and colour-coded sectors and rooms
- Copy / paste of any built region with rotation and mirroring
- Per-room "template" saving that persists across saves
- Notification grouping and a mute-per-category control
- Autosave every 5 in-game hours plus on backgrounding, with 5 rotating slots
- Colour-blind safe palettes for all overlays
- Dynamic type support up to 130%
- Full VoiceOver labels on all controls (the world view itself is exempt in v1)

---

## 4. Core simulation specification

### 4.1 Time

- The base unit is the **tick**. The simulation runs at a **fixed 10 ticks per in-game minute** internally, but only **4 simulation steps per real second** at 1x speed.
- 1 in-game hour = 1 real minute at 1x speed. A 24 hour day is 24 real minutes at 1x.
- Speed multipliers scale steps per real second: 1x = 4, 2x = 8, 5x = 20, 20x = 80.
- All simulation state advances on integer tick counts. **No delta-time in simulation code.** Rendering interpolates between the last two simulation states.
- **Determinism is mandatory.** Given the same seed and the same ordered command list, the simulation must produce byte-identical state. This enables replay-based debugging and testing.

### 4.2 Random number generation

Single seeded PRNG (`mulberry32`), advanced only from simulation code, never from rendering or UI. Separate named streams per subsystem so adding a new system does not shift another system's rolls:

```ts
rng.stream('intake').next()
rng.stream('contraband').next()
rng.stream('combat').next()
```

### 4.3 World representation

- Square tile grid. Tile size 32 world units, rendered at 32px at zoom level 1.
- Map sizes: Small 100x100, Medium 160x160, Large 220x220, Huge 300x300.
- Land ownership: the map is fully allocated but only owned parcels are buildable. Parcels are 20x20. Unowned parcels render dimmed with a purchase price.

**Per-tile data, stored as parallel typed arrays (structure of arrays):**

```ts
interface TileGrid {
  size: number                    // width == height
  floorMaterial: Uint8Array       // index into material table
  wallMaterial: Uint8Array        // 0 = none
  roomId: Uint16Array             // 0 = unassigned
  sectorId: Uint16Array
  objectId: Uint16Array           // 0 = none, the anchor tile of a multi-tile object
  passability: Uint8Array         // bitmask: walkable, door, staff-only, secure
  dirt: Uint8Array                // 0..255
  temperature: Int8Array          // degrees C
  powerGridId: Uint16Array
  waterGridId: Uint16Array
  outdoors: Uint8Array            // boolean, derived
  owned: Uint8Array               // boolean
}
```

Typed arrays are not optional. Object-per-tile allocation is the primary cause of the reference game's memory pressure.

### 4.4 Entity model

A lightweight archetype-based ECS. Not a general-purpose ECS library, a purpose-built one.

```ts
type EntityId = number

interface Entity {
  id: EntityId
  kind: 'inmate' | 'staff' | 'object' | 'item' | 'vehicle' | 'animal'
  x: number; y: number            // world units, not tiles
  tx: number; ty: number          // cached tile coords
}
```

Components stored in separate maps keyed by `EntityId`: `Needs`, `Health`, `Pathing`, `Job`, `Inventory`, `Schedule`, `Reputation`, `Grading`, `Assignment`.

Systems run in a **fixed order every tick**. The order is part of the determinism contract and must be documented in code:

```
1.  TimeSystem
2.  RoutineSystem        (what should each agent be doing)
3.  JobAssignmentSystem  (claim work)
4.  PathingSystem        (request and consume paths)
5.  MovementSystem
6.  NeedsSystem          (decay and discharge)
7.  ActivitySystem       (using objects)
8.  LogisticsSystem      (food, laundry, materials, garbage)
9.  ConstructionSystem
10. UtilitiesSystem      (power, water, temperature propagation)
11. ContrabandSystem
12. SecuritySystem       (danger, suppression, searches)
13. CombatSystem
14. EmergencySystem      (riots, fires, escapes)
15. ProgramSystem
16. EconomySystem
17. GradingSystem        (rooms, sectors, prisoners)
18. EventSystem          (random events, notifications, CausalEvent flush)
```

Not every system runs every tick. Each declares a period:

| System | Period |
| --- | --- |
| Movement, Pathing, Combat | every tick |
| Needs, Activity, Routine | every 10 ticks (1 in-game minute) |
| Logistics, Construction, Job assignment | every 10 ticks |
| Utilities, Contraband, Security | every 60 ticks (6 in-game minutes) |
| Grading, Economy, Programs | every 600 ticks (1 in-game hour) |

### 4.5 Pathfinding

This is the make-or-break subsystem. Specification:

**Layer 1: Region graph.** The map is partitioned into **rooms and corridors** as connected components of walkable tiles bounded by doors and walls. Doors are graph edges. This graph is small (hundreds of nodes) and is incrementally rebuilt when construction changes passability.

**Layer 2: Flow fields.** For every frequently-targeted destination class (nearest canteen serving-table, nearest shower, own cell, nearest exit) the game maintains a **Dijkstra flow field** over the tile grid, computed once and shared by every agent heading there. Rebuilt lazily on a dirty-rectangle basis.

**Layer 3: Per-agent A\*.** Only for one-off destinations (a specific object, a specific tile). Budgeted: a maximum of **N A\* searches per tick** (start at 8, tune). Requests over budget queue and the agent idles for a tick. Search space is bounded by the region graph result, so A\* only ever runs within a corridor of rooms, never over the whole map.

**Access filtering.** A path must respect sector permissions for the agent's category. This is a bitmask test on `passability` plus a sector permission lookup. Filtering happens during flow-field generation, so there is one flow field per (destination, access class), not per agent.

**Local avoidance.** Agents use a simple reciprocal velocity obstacle approximation over a 3x3 tile neighbourhood. Doorways get an explicit queue: agents joining a full doorway queue wait in an ordered line rather than shoving.

**Hard requirement:** at 400 agents, pathfinding must consume under 4ms per simulation step on the baseline device.

### 4.6 Simulation and render threading

- The entire simulation runs in a **Web Worker**.
- The main thread owns rendering and UI only.
- Communication: the worker posts a **snapshot** after each simulation step into a `SharedArrayBuffer` double buffer. The renderer reads the most recent complete snapshot and interpolates.
- Player commands go worker-ward as a serialised command queue, applied at the start of the next tick. This preserves determinism.
- If `SharedArrayBuffer` is unavailable (some webview configurations), fall back to structured-clone `postMessage` of a delta snapshot. Design the snapshot format to be delta-friendly from day one.

**Snapshot contents:** entity positions and sprite states, tile visual layers that changed, notification queue, and a UI state digest. Not the full simulation state.

---

## 5. Game systems specification

Numbers below are the **starting balance**. They are all data, defined in JSON, and expected to be tuned.

### 5.1 Rooms

Room definitions are pure data:

```ts
interface RoomDef {
  id: string
  name: string
  category: 'housing' | 'inmateActivity' | 'production' | 'staff' | 'logistics' | 'medical' | 'admin'
  minTiles: number
  minWidth: number
  minHeight: number
  properties: Array<'enclosed' | 'indoors' | 'outdoors' | 'secure'>
  requiredObjects: Array<{ objectId: string; count: number; perOccupant?: number }>
  suggestedObjects: string[]
  graded: boolean
  gradingRules?: GradingRuleSet
  autoPurchase?: Array<{ itemId: string; perTile: number }>
  servesNeeds: string[]
  jobSlots?: { objectId: string; slotsPerObject: number }
  unlockedBy?: string             // Directorate node id
}
```

**v1 room list** (30 rooms). Rename per section 1.3 where the reference name is generic enough to keep, invent where it is not:

Housing: `cell`, `dormitory`, `holding_pen`, `isolation`
Inmate activity: `mess_hall`, `washroom`, `exercise_yard`, `dayroom`, `classroom`, `library`, `chapel`, `visit_hall`, `commissary`, `mail_sort`
Production: `kitchen`, `workshop`, `laundry`, `supply_closet`, `grove`
Staff and admin: `office`, `control_room`, `break_room`, `armoury`, `kennel`
Medical: `clinic`, `mortuary`
Logistics: `store`, `dock`, `dispatch`, `refuse`
Special: `intake_hall`, `hearing_room`

**Room detection algorithm:** flood fill over designated tiles bounded by walls and doors. A room is one connected component. `enclosed` is true if the flood fill never reaches an undesignated outdoor tile. `indoors` is true if every tile has a foundation. Recompute on any wall, door or designation change, scoped to the affected region only.

### 5.2 Room grading

```ts
interface GradingRuleSet {
  min: number                     // 0
  max: number                     // 10
  objectPoints: Array<{ objectIds: string[]; points: number; perCount?: number; perOccupants?: number }>
  sizeThresholds: Array<{ tiles: number; points: number }>
  windowRule?: { outdoorFacingBonus: number; nonePenalty: number; perOccupants?: number }
  materialPenalties?: Array<{ materialIds: string[]; points: number }>
  custom?: string[]               // named rule ids evaluated in code
}
```

Graded rooms in v1: `cell`, `dormitory`, `exercise_yard`, `dayroom`, `classroom`, `mess_hall`.

Rules are ported from the teardown section 4.2 with values as a starting point.

**Entitlement ladder:**
- `entitlement` starts at 2 (average) on arrival
- +1 per full day without any misconduct, capped at `max`
- Reset to 0 on any misconduct of severity >= `destruction`
- Reduced by 2 on lower-severity misconduct
- Reassignment pass runs hourly. Strictness is a Standing Orders setting: `strict` (exact match), `lenient` (within 2), `off`.
- Misconduct probability multiplier: `1 + 0.08 * (avgGrade - currentCellGrade)`, clamped to `[0.5, 2.0]`

### 5.3 Objects

```ts
interface ObjectDef {
  id: string
  name: string
  cost: number
  size: { w: number; h: number }
  rotatable: boolean
  placement: 'floor' | 'wall' | 'door' | 'ceiling'
  needsPower: number              // watts, 0 = none
  needsWater: boolean
  servesNeeds: Array<{ need: string; ratePerMinute: number; concurrentUsers: number }>
  countsForRooms: string[]
  contrabandSourceFor?: string[]  // item ids obtainable from the room containing this
  jobSlots?: number
  producesHeat?: number
  destructible: boolean
  hp: number
  unlockedBy?: string
}
```

Target: **90 objects in v1**. Grouped as beds, sanitation, seating, tables, kitchen, workshop, laundry, security, surveillance, medical, education, recreation, comfort, utility, decor.

### 5.4 Needs

```ts
interface NeedDef {
  id: string
  name: string
  fillPerMinute: number           // 0..100 scale
  decayOnUse: number              // per minute while discharging
  escalatesToViolence: boolean
  criticalBehaviour?: 'urinate' | 'starve' | 'seekWeapon' | 'digTunnel' | 'withdrawal' | 'exposure' | 'none'
  onlyWithTrait?: string
  staffAlso: boolean
  thresholds: { medium: number; high: number; critical: number }  // default 40 / 65 / 88
}
```

**v1 needs (18):** `bladder`, `sleep`, `food`, `hygiene`, `clothing`, `comfort`, `exercise`, `safety`, `freedom`, `family`, `recreation`, `environment`, `privacy`, `literacy`, `spirituality`, `narcotics`, `alcohol`, `warmth`, `luxury`.

Bowels is merged into bladder (the reference game merged them functionally anyway).

**Starting fill rates** (points per in-game minute, so 100 points = full):

| Need | Fill/min | Full in |
| --- | --- | --- |
| bladder | 0.28 | ~6h |
| sleep | 0.10 | ~16h |
| food | 0.14 | ~12h |
| hygiene | 0.07 | ~24h |
| clothing | 0.045 | ~36h |
| comfort | 0.16 | ~10h |
| exercise | 0.055 | ~30h |
| safety | driven by danger level, not time | - |
| freedom | 0.05 base, x3 while locked up | - |
| family | 0.035 | ~48h |
| recreation | 0.12 | ~14h |
| environment | driven by room dirt level | - |
| privacy | driven by nearby-inmate count | - |
| literacy | 0.03, only with `clever` | ~55h |
| spirituality | 0.03, only with `devout` or converted | ~55h |
| narcotics | 0.10 x addictionStrength, only with addiction | - |
| alcohol | 0.10 x addictionStrength, only with addiction | - |
| warmth | driven by tile temperature below 12C | - |
| luxury | 0.04 | ~40h |

**Mood** is the aggregate: `mood = 100 - weightedMean(needs)`, with violence-escalating needs weighted 1.5x.

**Misconduct roll**, evaluated per inmate every 10 in-game minutes:

```
p = base[securityCategory]
  * (1 + 0.02 * countNeedsAtCritical)
  * cellGradeModifier
  * (1 - 0.4 * suppressionNormalised)
  * (1 + 0.5 * instigatorNearby)
  * guardProximityModifier         // 0.35 if a guard is within 4 tiles
  * (violentTrait ? 1.6 : 1.0)
```

`base` per category per 10 minutes: min 0.0008, med 0.003, max 0.008, supermax 0.012.

### 5.5 Inmates

```ts
interface Inmate {
  id: EntityId
  name: string
  portraitSeed: number
  category: SecurityCategory
  convictions: Conviction[]
  sentenceHours: number
  servedHours: number
  traits: TraitId[]               // hidden
  reputations: Array<{ id: ReputationId; revealed: boolean }>
  needs: Float32Array             // indexed by need index
  addictions: Array<{ substance: 'narcotics' | 'alcohol'; strength: number }>
  suppression: number             // 0..100
  entitlement: number
  cellId: EntityId | null
  jobId: string | null
  programEnrolment: ProgramEnrolment | null
  misconductLog: MisconductRecord[]
  grades: { punishment: number; reform: number; security: number; health: number }
  reoffendChance: number          // 0..1, derived
  status: StatusEffect[]
  health: number                  // 0..100
  inventory: ItemId[]
  money: number                   // in-prison currency for contraband trade
}
```

**Security categories** (v1): `minimum`, `medium`, `maximum`, `supermax`, `protective`, `condemned`.

Criminally insane is post-v1.

| Category | Intake fee | Daily payment | Notes |
| --- | --- | --- | --- |
| minimum | $320 | $110 | No dangerous traits. Never initiates violence. |
| medium | $520 | $160 | Moderate risk. |
| maximum | $1,050 | $260 | High risk, long sentences. |
| supermax | $2,100 | $260 | Manual designation only. |
| protective | $0 | $210 | Manual designation only. |
| condemned | $2,600 | $310 | Requires Directorate: Capital Cases. |

**Traits** (hidden, derived from convictions): `clever`, `controlling`, `destructive`, `deceitful`, `lethal`, `loyal`, `dependent`, `hoarder`, `reckless`, `thief`, `driver`, `violent`, `young`, `devout`.

**Reputations** (revealed by intelligence): `notorious` (the apex tier), `strong`/`very_strong`, `hardy`/`very_hardy`, `unstable`/`very_unstable`, `stoic`, `informant`, `deadly`/`very_deadly`, `former_officer`, `officer_killer`, `fearless`, `fast`/`very_fast`, `agitator`, `trained_fighter`/`expert_fighter`, `preacher`, `supplier`, `dealer`, `grower`, `gourmand`.

**Conviction table:** 40 original crime names with `{ minYears, maxYears, riskTier, grantsTraits[] }`. **1 year = 120 in-game hours.**

**Auto-reclassification:** serious injury moves the category up one. Homicide forces `maximum` and adds 25 years.

### 5.6 Staff

```ts
interface StaffDef {
  id: string
  name: string
  hourlyWage: number
  hireCost: number
  isAdministrator: boolean
  requiresOffice: boolean
  requiresRoom?: string           // armoury for armed officers
  requiresObjectPerHead?: string  // guard locker
  unlockedBy?: string
  needs: string[]
  capabilities: StaffCapability[]
}
```

**v1 staff (16):** `warden`, `security_director`, `finance_officer`, `works_manager`, `counsellor`, `legal_officer` (administrators); `officer`, `armed_officer`, `k9_officer` + `dog`, `tower_marksman`, `riot_team` (callable); `maintenance`, `cleaner`, `groundskeeper`, `cook`, `medic`. External per-session staff: `instructor`, `chaplain`, `hearing_panel`.

**Staff needs** (optional, default on): `bladder`, `rest`, `food`, `comfort`, `safety`, `recreation`, `environment`, `warmth`.

**Morale:** prison-wide 0 to 100. Inputs: mean staff need satisfaction (60% weight), recent staff deaths (rolling 7 day, -8 each), current injuries (-2 each), wage level versus a market rate (20%), and danger level (20%). Effects: search effectiveness `0.4 + 0.6 * morale/100`, movement speed `0.7 + 0.3 * morale/100`, bribe chance `max(0, (35 - morale) / 100)`. Below 10, a strike begins: 24 hours, all non-emergency staff stop working, and a pay demand appears.

### 5.7 The Routine (daily schedule)

24 one-hour blocks per security category. Blocks:

`lockup`, `sleep`, `meal`, `yard`, `wash`, `free`, `work_free`, `work_lockup`.

Rules:
- Inmates are not forced to perform an activity, only confined to the permitted room set.
- Inmates will not sleep between 08:00 and 20:00.
- Cooks begin meal preparation 4 hours before a `meal` block.
- Consecutive `meal` blocks do not double production (fixing a reference-game trap). Production is sized to headcount, not block count.
- Programs schedule only into `work_*` blocks and require a contiguous block of the program's length.
- Visits run 08:00 to 20:00 regardless.
- Injured inmates always route to the clinic if permitted out.
- `condemned` inmates follow no routine.

**Improvement:** the Routine editor shows a live **conflict strip** underneath: "Programs need 3 contiguous work hours, longest current block is 2", "Meal capacity 80, population 140, expect a 40 minute queue".

### 5.8 The Directorate (research tree)

Same structural idea as the reference: money plus in-game time, gated by administrators who each need an office.

**Root (requires Warden hired):**

| Node | Cost | Time | Unlocks |
| --- | --- | --- | --- |
| Security Office | $500 | 6h | Security Director, control room, sector view, danger meter, Security branch |
| Welfare | $500 | 6h | Counsellor, needs report, behavioural and alcohol programs |
| Medical | $500 | 6h | Medic, clinic, mortuary, addiction treatment |
| Education | $2,000 | 12h | Classroom, instructor, two education programs |
| Legal | $5,000 | 12h | Legal Officer, Legal branch |
| Works | $500 | 6h | Works Manager, Works branch |
| Finance | $500 | 6h | Finance Officer, finance reports, Finance branch |
| Standing Orders | $1,000 | 6h | Punishment policy, meal policy |
| Delegation | $1,000 | 6h | Post scheduler, program scheduler, kitchen and laundry routing |

**Security branch:** Surveillance ($2,000/6h), Posts ($1,000/6h), Intelligence ($1,000/6h), Patrols ($1,000/6h), Canine ($1,000/6h, needs Patrols), Automation ($2,000/6h), Armoury ($2,000/12h), Stun Devices ($1,000+$400 each/6h), General Issue Stun ($5,000+$400 each/12h), Protective Vests ($1,000+$100 each/6h), Watchtowers ($5,000/18h).

**Legal branch:** Compact Cells ($10,000/24h), Indefinite Sanctions ($5,000/24h), Capital Cases ($10,000/24h), Reduced Liability ($10,000/72h), Retainer ($50,000/72h), Counsel ($50,000/3h, cancels one game over).

**Works branch:** Inmate Labour ($1,000/6h), Sanitation ($2,000/6h), Grounds ($2,000/6h).

**Finance branch:** Tax Relief ($10,000/2d), Offshore Structure ($50,000/2d), Credit Line ($500/12h), Additional Contract ($500/6h), Land Purchase ($1,000/12h).

**Improvement:** the Directorate is presented as a **visual node graph with pinch-zoom**, not a nested list. Nodes show cost, time, and a one-line "this lets you..." Each node has a **"why do I want this"** expansion that names the specific problem it solves.

### 5.9 Programs

Same structure as the teardown table, renamed. `programId`, `costPerSession`, `seats`, `sessionsRequired`, `tutorStaffId`, `roomId`, `hours`, `attendance` (`referred` | `voluntary` | `mandatory` | `queue`), `prerequisiteProgramId`, `difficulty`, `effects`.

**Effects on completion:**

| Program | Effect |
| --- | --- |
| Alcohol Recovery Group | -0.35 reoffend contribution from alcohol addiction, addiction strength -50% |
| Substance Treatment | narcotics need suppressed while enrolled, addiction strength -40% on completion |
| Anger Management | violent trait misconduct multiplier 1.6 -> 1.15 |
| Workshop Induction | unlocks workshop job |
| Joinery Apprenticeship | unlocks high-value furniture production, -0.15 reoffend |
| Kitchen Induction | unlocks kitchen job |
| Basic Literacy | -0.10 reoffend, unlocks Vocational |
| Vocational Certificate | -0.20 reoffend |
| Chaplaincy Service | applies `calmed` status for 8 hours, spreads to inmates within 3 tiles |
| Parole Hearing | possible early release |
| Officer Stun Certification | staff may carry stun devices |

**Success roll per session:**
```
p = difficultyBase                       // easy 0.85, intermediate 0.65, advanced 0.45
  * (0.5 + 0.5 * concentration)          // concentration = 1 - meanNeedLevel
  * (1 - 0.5 * suppressionNormalised)
  * aptitude                             // per inmate, 0.7..1.3, rolled at spawn
```

**Improvement:** a program that cannot run shows a **blocking reason** in the Programs panel: "No contiguous 3 hour work block in the medium-security routine", "Classroom has 6 desks, program needs 10", "No instructor hired".

### 5.10 Contraband

**Item definition:**

```ts
interface ContrabandDef {
  id: string
  category: 'weapon' | 'tool' | 'narcotic' | 'luxury'
  attackPower: number             // hp per hit, 0 = not a weapon
  rechargeMinutes: number
  range: number                   // 0 = melee
  isMetal: boolean
  isOdorous: boolean
  canDigTunnel: boolean
  canClimb: boolean
  opensDoors: boolean
  sourceRooms: string[]           // the ROOM is the source, not the object
  craftableIn: string[]
  smuggleable: boolean
  basePrice: number
}
```

**Acquisition vectors (all five must be implemented):**
1. Arrival possession, probability scaling with category
2. Visit hall smuggling, blocked by using booths rather than tables
3. Delivery contamination on ingredients, uniforms, materials and commissary goods
4. Theft from rooms during any permitted access
5. Perimeter throw-ins, arranged by phone or visit, landing within 10 tiles of the boundary with line of sight

Plus in-prison **crafting** in workshop, supply closet and gym.

**Trading:** inmates hold money and trade. Price = `basePrice * (1 + demand/supply)` clamped, recomputed hourly. Inmates steal items they do not want in order to sell them. This is important: it makes an inmate with no interest in weapons still raid the armoury.

**Detection:**

| Method | Finds | Notes |
| --- | --- | --- |
| Intake search (intake hall) | everything on arrivals | throttles intake, costs officer time |
| Metal detector | metal only, `0.55 + 0.35 * morale` chance | high power draw |
| Dog patrol | odorous only, radius 3 | |
| Manual search (inmate / cell / block) | everything | angers the inmate, +suppression |
| Standing Orders automatic search | everything on the searched target | triggered per misconduct type |
| Full shakedown | everything, prison-wide | large mood and danger penalty |
| Informant | reveals stash locations and arranged throw-ins | informants can be blown and killed |
| Phone monitor | reveals throw-ins and hidden reputations | |

### 5.11 Security, suppression and danger

**Danger level** (0 to 100), recomputed every 6 in-game minutes:

```
danger = clamp(
    0.30 * pctInmatesWithAnyCriticalNeed
  + 0.20 * (misconductLast6h / population) * 400
  + 0.15 * pctInmatesArmed * 300
  + 0.15 * (1 - staffMorale/100) * 100
  + 0.10 * (1 - guardCoverageRatio) * 100
  + 0.10 * pctMaxSecPopulation * 100
, 0, 100)
```

Danger drives the `safety` need for both inmates and staff, and gates riot probability.

**Suppression:** +1 per 30 in-game minutes on cell lockdown, +1 per 15 in solitary, +0.5 per hour within 4 tiles of an armed officer or under a watchtower. Decays 1 per hour otherwise. `stoic` inmates do not accrue it from isolation.

Suppression effects: misconduct multiplier `1 - 0.4 * (suppression/100)`, program success multiplier `1 - 0.5 * (suppression/100)`, refuses voluntary programs above 60, reform grade penalty, and above 85 a chance of psychiatric referral.

**Riots:** trigger check every 10 in-game minutes.
```
p = 0.0002 * (danger/50)^3 * (1 + agitatorsActive) * (lockdownActive ? 0.2 : 1)
```
A riot spreads to adjacent inmates within 5 tiles with probability scaling on their mood. Contained when no rioting inmates remain for 10 continuous minutes.

**Escape tunnels:** an inmate with `clever` and a digging tool, in a cell with a toilet, during `sleep` or `lockup`, digs `0.4 + 0.1*rand()` tiles per hour. Tunnels join if they meet. Detection: dog within 2 tiles of the entrance (25%/pass), cell search (100%), or a maintenance sweep. Reaching the map edge equals an escape for every inmate connected to the tunnel network.

### 5.12 Utilities

**Power.** Sources have `outputWatts`. Cables form grids by connectivity. `gridCapacity = sum(sources)`. `gridDemand = sum(connected object draw)`. If demand exceeds capacity, branches are shed in reverse priority order (player-assignable priority per branch, defaulting to: life safety > security > production > comfort). A shed branch shows a browned-out overlay and a notification naming the shortfall in watts.

**Water.** Pump station with `flowRate`. Pipes distribute. Fixtures consume. Insufficient flow means slow fixture use, not total failure. Hot water loops feed radiators for the `warmth` need.

**Auto-routing.** On placing a powered or plumbed object, run a shortest-path search from the object to the nearest live grid node over tiles where cable or pipe may be laid, and present it as a dashed preview with a cost. Accept, adjust, or switch to manual.

**Logic.** Door controls, timers, pressure pads, logic gates and status lights, composable for sally ports and timed corridors. Directional connection semantics as in the reference game, but the UI shows an arrow so the direction is never ambiguous.

### 5.13 Logistics

Every hop is a real agent carrying a real item. No teleporting resources.

**Meal chain:** dock -> store -> kitchen fridge -> cooker (cook agent) -> serving counter -> inmate -> tray -> sink -> wash -> refuse -> dispatch.
**Meal policy:** quantity (low/normal/high) and variety (1 to 5 ingredients). Higher values cost more, raise the mess hall grade, and reduce misconduct.
**Kitchen capacity formula:** `mealsPerHour = cookers * 12 * (1 + 0.25 * cooksAssigned)`. Surfaced directly in the kitchen inspector alongside required throughput.

**Laundry chain:** dirty uniform accumulates on the bed -> collected into baskets -> washing machine -> ironing board -> redistributed to beds.

**Cleaning:** dirt accrues per tile from footfall (+1 per agent pass), blood, urine and food waste. Cleaners work indoors, groundskeepers outdoors, assigned inmates work during `work_*`. `environment` need scales with mean dirt of the current room.

**Construction supply:** material orders are placed automatically when a build is committed, arrive on trucks, land in the dock, are moved to the store, and are carried to sites by maintenance staff.

**Improvement:** each logistics chain has a **flow inspector** showing throughput at every stage with the bottleneck highlighted in red.

### 5.14 Economy

**Income:** intake fees, daily per-inmate payment at midnight, contract advances and completion bonuses, export sales from workshop and grove, commissary revenue.

**Expenditure:** construction, objects, wages (hourly), program sessions, Directorate research, utility bills, loan interest, tax, contract cancellation penalties.

**Contracts** (grants, renamed). Up to 2 concurrent, 3 with Additional Contract researched. Each is `{ advance, completion, todoItems[], prerequisites[], hidden }`. Cancellation refunds the advance plus a 10% penalty.

Starting contracts: `Fit for Purpose` ($20k/$10k), `Administration` ($5k/$5k), `Duty of Care` ($10k/$10k), `Education Trial` ($15k/$40k), `Staff Welfare` ($0/$10k).

Locked and hidden contracts follow the reference structure with original names. Include a `Rescue Package` ($50k/$50k) that appears once when insolvency is imminent.

**Loans:** require Finance Officer and Credit Line. Hourly interest. Credit rating rises with payments, raising the cap from $2,500 to $250,000. Principal must be actively repaid.

### 5.15 Failure conditions

All optional at map creation. All produce a warning before the actual end, and the Counsel research cancels one.

| Condition | Trigger |
| --- | --- |
| Uncontained riot | 6 in-game hours of riot, then 6 more |
| Insolvency | negative balance and negative cash flow for 24 hours |
| Deaths | 20 in one day, then 5 more the next |
| Escapes | 20 in one day, then 5 more the next |
| Warden deaths | 3 wardens killed, then 1 more |
| Parole recidivism | 10 paroled inmates re-offend in a rolling 30 day window |
| Wrongful executions | 2 executions above the clemency tolerance, then 1 more |

---

## 6. Interface specification

The full visual spec is in `04-ui-mockups.html`, which is the source of truth for colour, typography and layout. This section defines structure and behaviour.

### 6.1 Layout (iPad landscape, 1194x834pt reference)

```
+------------------------------------------------------------------+
| TOP BAR  56pt                                                    |
| [pause/speed] [clock+day] [balance +/-hr] [danger] [alerts] [menu]|
+------------------------------------------------------------------+
|                                                    |             |
|                  WORLD VIEW                        |  INSPECTOR  |
|                  (fills remaining space)           |  360pt      |
|                                                    |  slides in  |
|                                                    |  from right |
|                                                    |             |
+------------------------------------------------------------------+
| TOOL DOCK  88pt                                                  |
| [Build] [Rooms] [Objects] [Utilities] [Staff] [Posts] [Flow]     |
| [Plan] [Reports] [Emergency]                                     |
+------------------------------------------------------------------+
```

- The world view never has UI on top of it except transient overlays and the selection ring.
- The inspector slides over the world, does not resize it, and can be dismissed with a swipe right.
- Selecting a tool expands a **secondary tray** above the dock with that tool's palette, scrollable horizontally.
- On Mac and on iPad in portrait, the dock moves to the left edge as a vertical rail and the inspector docks right.

### 6.2 Screens and panels

| Panel | Contents |
| --- | --- |
| Inspector: Inmate | Portrait, name, number, category (editable), sentence bar, needs list with drill-down, traits (known only), reputations (known only), grades, re-offend estimate, misconduct log, current activity, cell assignment, program enrolment, actions (search, punish, reclassify, protective custody) |
| Inspector: Staff | Portrait, role, wage, needs, morale contribution, current task, post assignment, equipment |
| Inspector: Room | Name (editable), type, size, requirement checklist with pass/fail, grade breakdown line by line, occupants, throughput stats if a production room, flow inspector link |
| Inspector: Object | Name, cost, power/water status, condition, needs served, contraband risk |
| Routine editor | 24-hour strip per category, drag to paint blocks, conflict strip below, per-category tabs |
| Posts (deployment) | Sector map overlay, sector access mode, security category restriction, post list with staffing requirements and time windows, unfilled posts badge |
| Flow (logistics) | Chain diagram for meals, laundry, cleaning, construction supply and exports, with throughput at each stage and the bottleneck highlighted |
| Directorate | Zoomable node graph, node detail sheet with cost, time, unlocks and "why you want this" |
| Contracts | Active contract cards with to-do checklists and progress, available contracts list, loan controls |
| Reports | Finance (income/expense breakdown, 7 day chart), Needs (drill-down), Population (category mix, sentences, arrivals, releases), Intelligence (contraband map, prices, informants), Log (searchable event history), Statistics |
| Standing Orders | Misconduct-to-punishment matrix, search triggers, cell reassignment strictness, meal quantity and variety |
| Intake | Requested counts per category, continuous intake toggle, capacity readout, next bus ETA |
| Trace | Vertical causal timeline with tappable nodes and suggested fixes |

### 6.3 Build interaction

1. Tap **Build**, choose Foundation / Wall / Floor / Room / Object.
2. All building happens in **blueprint layer** by default (blue wireframe). A toggle switches to direct-build for players who prefer it.
3. Drag a rectangle for foundations, rooms and floors. Drag a line for walls. Tap to place objects, drag to place a run.
4. The blueprint bar shows: total cost, tiles affected, and a validity list. Invalid items are tappable and pan the camera to the problem.
5. **Commit** deducts money and queues construction. **Discard** clears the blueprint.
6. Two-finger tap undoes the last blueprint operation.

### 6.4 Overlays

Toggleable, one at a time, with a legend chip in the corner: Sectors, Room grade, Needs heatmap (per selected need), Contraband risk, Power, Water, Temperature, Cleanliness, Guard coverage, Fog of war.

### 6.5 Notifications

Three severities: `info` (silent, log only), `warn` (badge on the alerts button plus a toast), `critical` (toast plus a pulse on the alerts button plus optional auto-pause).

Every notification of `warn` or above carries a `traceId` and is tappable to open the Trace panel.

Grouping: identical notifications within 60 in-game minutes collapse into one with a count.

---

## 7. Technical architecture

### 7.1 Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, `strict: true` | Agent-friendly, type errors catch schema drift |
| Renderer | PixiJS v8 (WebGL2, WebGPU where available) | Best-in-class 2D batching, mature, small |
| Build | Vite | Fast, simple, good worker support |
| UI framework | Preact + signals | Small, fast, avoids React reconciliation cost next to a 60fps canvas |
| State (UI) | Signals only, no Redux | Simulation state lives in the worker, UI state is small |
| Simulation | Plain TypeScript in a Web Worker, no engine | Full control over determinism and memory layout |
| Persistence | IndexedDB for saves, plus file export/import | Works in webview, large capacity |
| Packaging | Capacitor 6 for iPadOS. Apple Silicon Macs run the iPad build via "Designed for iPad" | Single build target for both stated platforms |
| Optional later | Tauri or Electron for a native Mac / Steam build | Only if Intel Macs or Steam matter |
| Testing | Vitest for units, Playwright for the web build, a custom deterministic replay harness for the sim | |
| Lint | ESLint + Prettier, strict import boundaries | |

### 7.2 Repository layout

```
blockwork/
  packages/
    sim/                  # zero DOM dependencies, pure TypeScript
      src/
        core/             # tick loop, rng, command queue, snapshot
        world/            # tile grid, rooms, sectors, regions
        entities/         # inmates, staff, objects, items
        systems/          # one file per system in the fixed order
        pathfinding/
        data/             # loaders and validators for definition JSON
        trace/            # CausalEvent recording
        save/             # serialise, deserialise, migrate
      test/
    render/               # PixiJS layer, consumes snapshots
      src/
        layers/           # terrain, walls, objects, agents, overlays, effects
        camera/
        sprites/
    ui/                   # Preact components
      src/
        panels/
        controls/
        theme/            # design tokens extracted from the mockups
    app/                  # composition root, worker bootstrap, Capacitor entry
    data/                 # the game definition JSON, versioned
      rooms.json
      objects.json
      needs.json
      inmates.json        # traits, reputations, convictions
      staff.json
      directorate.json
      programs.json
      contraband.json
      contracts.json
      materials.json
      balance.json
  tools/
    replay/               # deterministic replay runner for CI
    balance/              # headless simulation for tuning
```

**Import boundary rules, enforced by lint:**
- `sim` may not import from `render`, `ui` or `app`
- `render` may import from `sim` for types only (`import type`)
- `ui` may import from `sim` for types only
- Nothing imports from `app`

### 7.3 Data-driven definitions

Every balance number and content definition lives in `packages/data/*.json`, validated at load with Zod schemas. This means:
- An agent can add 20 objects by editing one JSON file
- Balance passes never touch code
- Modding support falls out for free later
- Tests can load a minimal fixture dataset

### 7.4 Save format

```ts
interface SaveFile {
  version: number                 // integer, bumped on any breaking change
  seed: number
  createdAt: string
  playedTicks: number
  mapSize: number
  settings: MapSettings
  grid: { [K in keyof TileGrid]: string }   // base64 of the typed array buffers
  entities: SerialisedEntity[]
  rooms: SerialisedRoom[]
  sectors: SerialisedSector[]
  economy: EconomyState
  directorate: DirectorateState
  contracts: ContractState[]
  routines: RoutineState
  standingOrders: StandingOrdersState
  posts: PostState[]
  log: LogEntry[]                 // capped at 2000 entries
  rngState: RngState
}
```

- Compressed with `CompressionStream('gzip')`.
- Target: under 3MB for a 220x220 map with 400 inmates, under 400ms to save.
- **Migrations are mandatory.** A `migrations/` directory with one function per version step. Loading an old save runs the chain. Never break a save silently.

### 7.5 Performance budgets

Per simulation step at 400 agents on the baseline device:

| System | Budget |
| --- | --- |
| Pathfinding (all layers) | 4.0ms |
| Movement + local avoidance | 1.5ms |
| Needs + Activity + Routine | 1.5ms |
| Logistics + Construction | 1.5ms |
| Everything else | 2.0ms |
| Snapshot write | 0.5ms |
| **Total simulation** | **11ms** |

Per rendered frame on the main thread:

| Item | Budget |
| --- | --- |
| Snapshot read + interpolation | 2ms |
| Sprite updates | 4ms |
| Draw calls (target under 40) | 5ms |
| UI (Preact) | 3ms |
| **Total frame** | **14ms** |

**Enforcement:** a CI performance test runs a headless 400-agent scenario for 1000 ticks and fails the build if the mean step time regresses more than 10% from the recorded baseline.

### 7.6 Rendering approach

- Six render layers, each a Pixi container with its own batching strategy:
  1. **Terrain** - a single tiling sprite mesh, updated only when floor tiles change, chunked into 32x32 tile chunks
  2. **Walls and doors** - chunked sprite batches, autotiled with a 47-tile bitmask ruleset
  3. **Objects** - sprite batch sorted by y for depth
  4. **Agents** - sprite batch, y-sorted, with a lightweight 4-direction 4-frame animation
  5. **Overlays** - a single shader-driven quad reading a data texture, so overlays cost one draw call regardless of map size
  6. **Effects and UI-in-world** - selection rings, path debug, notification pins
- **Culling:** only chunks intersecting the camera frustum are updated or drawn.
- **Zoom levels:** at the furthest zoom, agents render as 4px dots and object detail is dropped entirely.

### 7.7 Art direction

Original, not a reference-game pastiche. Direction:
- Clean flat vector-derived sprites at 32x32, exported as a packed atlas
- Muted institutional palette: concrete greys, sodium-light amber, cold fluorescent blue-white
- Inmates as simple 4-frame figures, colour-coded by category via a tint on the uniform layer, so one sprite serves all categories
- Readability over realism. At the default zoom the player must be able to identify category, activity and mood at a glance
- Mood indicated by a small icon above the head, not by facial detail

Placeholder art is acceptable through Phase 6 and must be replaced before any release build.

### 7.8 Audio

Deferred to Phase 8. Requirements when built: ambient loop layered by danger level, positional one-shots for doors, alarms, fights and construction, and a full mute plus separate music/SFX sliders.

### 7.9 Accessibility

- Dynamic Type support to 130% in all panels
- VoiceOver labels on every control and every inspector field
- Colour-blind palettes: all overlays must be readable in deuteranopia, protanopia and tritanopia. Never encode meaning in hue alone, always pair with a shape or a value.
- Reduce Motion: disables camera easing and panel slide animations
- A "no failure" mode that disables all failure conditions

---

## 8. Testing strategy

| Level | Tool | What |
| --- | --- | --- |
| Unit | Vitest | Pure functions: grading rules, need decay, price calculation, room detection, path region graph |
| Schema | Zod + Vitest | Every JSON definition file validates, and every cross-reference (object -> room, program -> staff) resolves |
| Determinism | Custom replay harness | Run a recorded command list against a seed twice, assert identical state hashes |
| Scenario | Custom headless runner | Named scenarios: "starvation", "riot escalation", "power brownout", "tunnel escape". Each asserts the expected outcome and the expected Trace chain |
| Performance | Headless runner in CI | 400 agents, 1000 ticks, assert step time budget |
| Visual | Playwright screenshots on the web build | Every panel at three type sizes |
| Manual | Device test matrix | iPad 9th gen, iPad Air M1, iPad Pro M4, MacBook Air M-series |

**The scenario runner is the highest-value test asset.** It lets an agent verify a system end to end without a human playing the game.

---

## 9. Success criteria

**v1 is done when:**

1. A player can start a sandbox prison, build a working facility, take in 100+ inmates, and run it for 30 in-game days without the simulation breaking.
2. Every system in section 5 is implemented and reachable through the UI.
3. Every `warn` and `critical` notification produces a correct, useful Trace.
4. The performance budgets in 7.5 are met on an iPad Air M1.
5. Save, load and migration work across at least two schema versions.
6. Five external playtesters complete a 60 minute session without needing to be told how anything works.
7. Zero reference-game assets, names or strings anywhere in the repository.

**Explicitly deferred to v1.1+:** gangs, female prisons and babies, criminally insane and psychiatric care, death row and executions beyond the basic loop, island maps and boats, temperature and weather beyond the warmth need, modding UI, Steam release.
