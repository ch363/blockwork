/**
 * The Directorate: research state and the unlock gate (T5.1, PRD 5.8).
 *
 * Two halves that belong together.
 *
 * **The state** is what the player has bought: a set of completed node ids and
 * the nodes currently in progress. Progress is counted in ticks, not hours, so
 * a node's remaining time is exact at any tick and a save that lands mid-node
 * resumes where it stopped. `directorateSystem` owns the advance; this module
 * owns the shape and the rules about what may start.
 *
 * **The gate** is what that state makes legal. Rooms, objects, staff, programs,
 * materials, doors and security categories each declare their own
 * `unlockedBy`, and `loadGameData` turns those back-references into
 * `data.unlocks` keyed by node. Features have no definition of their own, so
 * the node lists them directly. Either way the question a system asks is the
 * same — "may the player use this yet?" — and it is answered here, from data,
 * rather than by each system hardcoding which node it waits for.
 *
 * That inversion is what makes the acceptance test possible: enumerate every
 * unlock every node declares, and assert the gate refuses it while the node is
 * outstanding. A feature that no gate consults would show up as a gap in the
 * enumeration rather than as a bug a player finds.
 */

import type { JsonObject, JsonValue } from '../core/commands'
import { TICKS_PER_HOUR } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { CommandHandler } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { DirectorateNode } from '../data/schemas'

/**
 * `NO_ROOM` restated rather than imported: `ConstructionWorld` owns the state
 * below, and `world/rooms` already imports `ConstructionWorld`, so importing
 * back would close a module cycle for one number.
 */
const UNCLAIMED_OFFICE = 0

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const DIRECTORATE_EVENTS = {
  started: 'directorate.started',
  paused: 'directorate.paused',
  resumed: 'directorate.resumed',
  completed: 'directorate.completed',
  rejected: 'directorate.rejected',
} as const

/** Why a `StartResearch` was refused. */
export type DirectorateRejection =
  | 'wrong-world'
  | 'invalid-payload'
  | 'unknown-node'
  | 'already-complete'
  | 'already-active'
  | 'missing-prerequisite'
  | 'no-administrator'
  | 'no-office'
  | 'insufficient-funds'
  /** The node's branch has not been opened by its root node. */
  | 'branch-locked'

/**
 * Why an in-progress node is not advancing.
 *
 * PRD 5.8 gates a node on its owning administrator, and the acceptance
 * criterion is that firing the Security Director pauses Security branch
 * research **and says so** — so the reason is part of the state, not a
 * transient computed at render time.
 */
export type ResearchPauseReason = 'no-administrator' | 'no-office'

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** One node the player has paid for and is waiting on. */
export interface ActiveResearch {
  readonly nodeId: string
  readonly startedTick: number
  /** Ticks of *progress*, which excludes every tick spent paused. */
  elapsedTicks: number
  /** Null while advancing. */
  pausedReason: ResearchPauseReason | null
}

export interface DirectorateSnapshot extends JsonObject {
  readonly completed: readonly string[]
  readonly active: readonly {
    readonly nodeId: string
    readonly startedTick: number
    readonly elapsedTicks: number
    readonly pausedReason: string | null
  }[]
}

/**
 * Completed nodes plus work in progress.
 *
 * Lives on `ConstructionWorld` rather than on `InmateWorld` because the two
 * earliest gates — designating a room and placing an object — run against the
 * construction world, both from the command handlers and from a blueprint
 * commit. Putting the state any higher up the chain would mean those paths
 * could not see it and "locked" would only be enforced in the UI.
 */
export class DirectorateState {
  readonly #completed = new Set<string>()
  readonly #active = new Map<string, ActiveResearch>()

  get completedCount(): number {
    return this.#completed.size
  }

  get activeCount(): number {
    return this.#active.size
  }

  isComplete(nodeId: string): boolean {
    return this.#completed.has(nodeId)
  }

  isActive(nodeId: string): boolean {
    return this.#active.has(nodeId)
  }

  activeResearch(nodeId: string): ActiveResearch | undefined {
    return this.#active.get(nodeId)
  }

  /** Completed ids in a stable (sorted) order. */
  completed(): readonly string[] {
    return [...this.#completed].sort()
  }

  /** In-progress research sorted by node id, so iteration order is content. */
  active(): readonly ActiveResearch[] {
    return [...this.#active.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))
  }

  begin(nodeId: string, tick: number): ActiveResearch {
    const research: ActiveResearch = {
      nodeId,
      startedTick: tick,
      elapsedTicks: 0,
      pausedReason: null,
    }
    this.#active.set(nodeId, research)
    return research
  }

  complete(nodeId: string): void {
    this.#active.delete(nodeId)
    this.#completed.add(nodeId)
  }

  /**
   * Marks a node complete without paying for it.
   *
   * The map-creation path (T6.5's "start with everything researched" option)
   * and tests that are about some other system both need a prison where the
   * tree is not in the way.
   */
  grant(nodeId: string): void {
    this.complete(nodeId)
  }

  /** Every node in the tree, completed. */
  grantAll(data: GameData): void {
    for (const node of data.directorate.all) this.complete(node.id)
  }

  serialise(): DirectorateSnapshot {
    return {
      completed: this.completed(),
      active: this.active().map((research) => ({
        nodeId: research.nodeId,
        startedTick: research.startedTick,
        elapsedTicks: research.elapsedTicks,
        pausedReason: research.pausedReason,
      })),
    }
  }

  restore(snapshot: DirectorateSnapshot): void {
    this.#completed.clear()
    this.#active.clear()
    for (const nodeId of snapshot.completed) this.#completed.add(nodeId)
    for (const entry of snapshot.active) {
      this.#active.set(entry.nodeId, {
        nodeId: entry.nodeId,
        startedTick: entry.startedTick,
        elapsedTicks: entry.elapsedTicks,
        pausedReason: isPauseReason(entry.pausedReason) ? entry.pausedReason : null,
      })
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    const completed = this.completed()
    hasher.writeUint32(completed.length)
    for (const nodeId of completed) hasher.writeString(nodeId)

    const active = this.active()
    hasher.writeUint32(active.length)
    for (const research of active) {
      hasher.writeString(research.nodeId)
      hasher.writeUint32(research.startedTick)
      hasher.writeUint32(research.elapsedTicks)
      hasher.writeString(research.pausedReason ?? '')
    }
  }
}

function isPauseReason(value: string | null): value is ResearchPauseReason {
  return value === 'no-administrator' || value === 'no-office'
}

/** Total ticks a node takes, from its `durationHours`. */
export function nodeDurationTicks(node: DirectorateNode): number {
  return node.durationHours * TICKS_PER_HOUR
}

/** Progress 0..1 of an in-progress node, for the panel. */
export function researchProgress(node: DirectorateNode, research: ActiveResearch): number {
  const total = nodeDurationTicks(node)
  if (total <= 0) return 1
  const fraction = research.elapsedTicks / total
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
}

/* -------------------------------------------------------------------------- */
/* The unlock gate                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of thing a Directorate node can gate.
 *
 * These are exactly the keys of `DirectorateUnlocks`, which is what makes the
 * enumeration test total: a new unlock kind added to the loader without a gate
 * here is a compile error, not a silent hole.
 */
export const UNLOCK_KINDS = [
  'rooms',
  'objects',
  'staff',
  'programs',
  'materials',
  'doors',
  'securityCategories',
  'features',
] as const

export type UnlockKind = (typeof UNLOCK_KINDS)[number]

type UnlockIndex = Readonly<Record<UnlockKind, ReadonlyMap<string, string>>>

/**
 * Reverse of `data.unlocks`: which node must complete before this id is legal.
 *
 * Cached per `GameData` because the map is derived, immutable, and asked for on
 * every placement.
 */
const INDEX_CACHE = new WeakMap<GameData, UnlockIndex>()

function unlockIndex(data: GameData): UnlockIndex {
  const cached = INDEX_CACHE.get(data)
  if (cached !== undefined) return cached

  const index = Object.fromEntries(
    UNLOCK_KINDS.map((kind) => [kind, new Map<string, string>()]),
  ) as Record<UnlockKind, Map<string, string>>

  for (const [nodeId, unlocks] of data.unlocks) {
    for (const kind of UNLOCK_KINDS) {
      for (const id of unlocks[kind]) {
        // First writer wins. The loader rejects a second `unlockedBy`, so a
        // collision here would be a data bug that never reaches this far.
        if (!index[kind].has(id)) index[kind].set(id, nodeId)
      }
    }
  }

  const frozen = index as UnlockIndex
  INDEX_CACHE.set(data, frozen)
  return frozen
}

/**
 * The node that gates `id`, or undefined when nothing does.
 *
 * An id no node mentions is available from the first tick — that is how the
 * starting set of rooms, objects and staff stays playable before any research.
 */
export function gatingNode(data: GameData, kind: UnlockKind, id: string): string | undefined {
  return unlockIndex(data)[kind].get(id)
}

/** Everything of one kind that is gated, for tests and the panel. */
export function gatedIds(data: GameData, kind: UnlockKind): readonly string[] {
  return [...unlockIndex(data)[kind].keys()].sort()
}

/** Whether the player may use `id` yet. */
export function isUnlocked(
  data: GameData,
  state: DirectorateState,
  kind: UnlockKind,
  id: string,
): boolean {
  const nodeId = gatingNode(data, kind, id)
  if (nodeId === undefined) return true
  return state.isComplete(nodeId)
}

/** Convenience for the many callers that only ask about a named feature. */
export function hasFeature(data: GameData, state: DirectorateState, featureId: string): boolean {
  return isUnlocked(data, state, 'features', featureId)
}

/**
 * The feature a branch's root node unlocks, by the `<branch>_branch`
 * convention `directorate.json` follows, or undefined for `root` and for any
 * branch that has not declared one.
 */
export function branchFeatureId(data: GameData, branch: string): string | undefined {
  if (branch === 'root') return undefined
  const featureId = `${branch}_branch`
  return data.balance.features.includes(featureId) ? featureId : undefined
}

/**
 * Every gated feature and where its gate lives.
 *
 * PRD 5.8's unlocks fall into two halves. Rooms, objects, staff, programmes
 * and categories are gated by `isUnlocked` at the one place each is created,
 * and the enumeration test can drive that call site directly. Features have no
 * definition to point at, so this table is the index of them: it names the
 * mechanic each one governs, which is what lets a test assert that no feature
 * in `balance.features` is merely decorative.
 *
 * `pending` is the honest half. A feature whose mechanic has not been built
 * yet cannot be gated, and saying so here is better than a gate that guards
 * nothing.
 */
export interface FeatureGate {
  readonly featureId: string
  /** Module and call site the gate is enforced at. */
  readonly enforcedIn: string
  /** Set when the mechanic does not exist yet; names the ticket that adds it. */
  readonly pending?: string
}

export const FEATURE_GATES: readonly FeatureGate[] = [
  // Branch roots — `checkStartResearch` refuses a node whose branch is shut.
  { featureId: 'security_branch', enforcedIn: 'entities/directorate:checkStartResearch' },
  { featureId: 'legal_branch', enforcedIn: 'entities/directorate:checkStartResearch' },
  { featureId: 'works_branch', enforcedIn: 'entities/directorate:checkStartResearch' },
  { featureId: 'finance_branch', enforcedIn: 'entities/directorate:checkStartResearch' },

  // Deployment and sectors.
  { featureId: 'sector_view', enforcedIn: 'world/sectorCommands:sectorCommandHandlers' },
  { featureId: 'posts', enforcedIn: 'systems/postSystem:postCommandHandlers' },
  { featureId: 'patrol_routes', enforcedIn: 'systems/postSystem:postCommandHandlers' },
  { featureId: 'post_scheduler', enforcedIn: 'systems/postSystem:postCommandHandlers' },

  // Standing Orders.
  { featureId: 'punishment_policy', enforcedIn: 'systems/searchSystem:searchCommandHandlers' },
  { featureId: 'meal_policy', enforcedIn: 'systems/searchSystem:searchCommandHandlers' },
  {
    featureId: 'indefinite_sanctions',
    enforcedIn: 'systems/searchSystem:searchCommandHandlers',
  },

  // Delegation routing.
  { featureId: 'kitchen_routing', enforcedIn: 'systems/logistics/mealChain:advanceKitchen' },
  { featureId: 'laundry_routing', enforcedIn: 'systems/logistics/laundry:redistribute' },

  // Finance.
  {
    featureId: 'additional_contract',
    enforcedIn: 'systems/contractSystem:maxConcurrentContracts',
  },
  { featureId: 'tax_relief', enforcedIn: 'systems/economySystem:effectiveTaxRate' },
  { featureId: 'offshore_structure', enforcedIn: 'systems/economySystem:effectiveTaxRate' },

  // Intake.
  { featureId: 'capital_cases', enforcedIn: 'systems/intakeSystem:handleSetRequested' },

  // Phase 5 tickets that land later in this phase.
  { featureId: 'program_scheduler', enforcedIn: 'systems/programSystem:pinSession' },
  { featureId: 'intelligence_panel', enforcedIn: 'systems/intelligenceSystem:recruitInformant' },
  { featureId: 'inmate_labour', enforcedIn: 'systems/labourSystem:assignLabour' },
  { featureId: 'sanitation_jobs', enforcedIn: 'systems/labourSystem:assignLabour' },
  { featureId: 'grounds_jobs', enforcedIn: 'systems/labourSystem:assignLabour' },

  // Reports are assembled and gated in the worker before their data crosses
  // to the UI (T6.2).
  { featureId: 'finance_reports', enforcedIn: 'app/worker/reportData:buildReportsModel' },
  { featureId: 'needs_report', enforcedIn: 'app/worker/reportData:buildReportsModel' },

  // Mechanics that do not exist yet. Each is a flagged gap, not a silent one.
  { featureId: 'danger_meter', enforcedIn: 'systems/dangerSystem' },
  { featureId: 'surveillance', enforcedIn: 'app/worker/overlayData:fogData' },
  { featureId: 'door_automation', enforcedIn: '-', pending: 'T5.5 logic follow-up' },
  { featureId: 'stun_devices', enforcedIn: '-', pending: 'staff equipment, unscheduled' },
  { featureId: 'general_issue_stun', enforcedIn: '-', pending: 'staff equipment, unscheduled' },
  { featureId: 'protective_vests', enforcedIn: 'entities/staff:hireStaff' },
  { featureId: 'compact_cells', enforcedIn: 'world/rooms:evaluateRoom' },
  { featureId: 'reduced_liability', enforcedIn: '-', pending: 'legal liability, unscheduled' },
  { featureId: 'retainer', enforcedIn: '-', pending: 'legal liability, unscheduled' },
  { featureId: 'counsel_reprieve', enforcedIn: '-', pending: 'T6.x failure reprieve' },
  { featureId: 'credit_line', enforcedIn: 'systems/contractSystem:handleTakeLoan' },
  { featureId: 'land_purchase', enforcedIn: '-', pending: 'T6.5 map expansion' },
]

/** A world that carries research state. Narrower than importing the world type. */
export interface DirectorateWorldView {
  readonly directorate: DirectorateState
}

function hasDirectorate(world: object): world is DirectorateWorldView {
  return (
    'directorate' in world &&
    (world as DirectorateWorldView).directorate instanceof DirectorateState
  )
}

/**
 * Wraps a handler map so listed commands are refused while their feature is
 * locked.
 *
 * A wrapper rather than a line inside each handler because the gate is the
 * same sentence every time — "the player has not bought this yet" — and
 * because the mapping from command to feature is then readable in one place
 * instead of scattered through argument parsing. The wrapped handler never
 * runs, so a locked command cannot half-apply.
 */
export function featureGatedHandlers(
  data: GameData,
  handlers: Readonly<Record<string, CommandHandler>>,
  featureByCommand: Readonly<Record<string, string>>,
): Readonly<Record<string, CommandHandler>> {
  const wrapped: Record<string, CommandHandler> = { ...handlers }

  for (const [commandType, featureId] of Object.entries(featureByCommand)) {
    const inner = handlers[commandType]
    if (inner === undefined) continue
    wrapped[commandType] = (command, context) => {
      const world = context.world
      if (hasDirectorate(world) && !hasFeature(data, world.directorate, featureId)) {
        context.events.emit({
          tick: context.clock.tick,
          kind: DIRECTORATE_EVENTS.rejected,
          causeIds: [],
          data: {
            reason: 'feature-locked',
            command: commandType,
            featureId,
            nodeId: gatingNode(data, 'features', featureId) ?? '',
          },
        })
        return
      }
      inner(command, context)
    }
  }

  return wrapped
}

/* -------------------------------------------------------------------------- */
/* Start rules                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the administrator check saw.
 *
 * Split from the boolean so the pause event can name the reason, which is the
 * whole point of the acceptance criterion: the player is told the Security
 * Director is gone, not merely that nothing is happening.
 */
export function administratorStatus(
  world: AdministratorWorldView,
  data: GameData,
  administratorId: string,
): ResearchPauseReason | null {
  let hired = false
  for (const entity of world.staff.all()) {
    if (entity.staff.defId !== administratorId) continue
    hired = true
    const def = data.staff.find(administratorId)
    if (def === undefined || !def.requiresOffice) return null
    const officeRoomId = entity.staff.officeRoomId
    if (officeRoomId === UNCLAIMED_OFFICE) continue
    const status = world.rooms.statusOf(officeRoomId)
    if (status !== undefined && status.functional) return null
  }
  return hired ? 'no-office' : 'no-administrator'
}

/** The slice of the world the administrator check reads. */
export interface AdministratorWorldView {
  readonly staff: {
    readonly all: () => readonly {
      readonly staff: { readonly defId: string; readonly officeRoomId: number }
    }[]
  }
  readonly rooms: {
    readonly statusOf: (roomId: number) => { readonly functional: boolean } | undefined
  }
}

/** Prerequisite ids the node still lacks, ascending. */
export function missingPrerequisites(
  state: DirectorateState,
  node: DirectorateNode,
): readonly string[] {
  return node.prerequisites
    .filter((id) => !state.isComplete(id))
    .slice()
    .sort()
}

export interface StartResearchCheck {
  readonly ok: boolean
  readonly reason?: DirectorateRejection
  readonly detail?: JsonObject
}

/**
 * Every rule that decides whether research may begin, in one place so the
 * command handler and the panel's "why is this greyed out" agree.
 *
 * Cost is checked, not paid: the caller debits, because only it holds the
 * ledger and the tick.
 */
export function checkStartResearch(options: {
  readonly data: GameData
  readonly state: DirectorateState
  readonly world: AdministratorWorldView
  readonly nodeId: string
  readonly balance: number
}): StartResearchCheck {
  const { data, state, world, nodeId } = options
  const node = data.directorate.find(nodeId)
  if (node === undefined) return { ok: false, reason: 'unknown-node', detail: { nodeId } }
  if (state.isComplete(nodeId)) return { ok: false, reason: 'already-complete', detail: { nodeId } }
  if (state.isActive(nodeId)) return { ok: false, reason: 'already-active', detail: { nodeId } }

  // Branches open as a unit: PRD 5.8 gives each one a root node whose unlock
  // is the branch itself, so a Security node needs Security Office finished
  // even where its own prerequisite list would already have said so.
  const branchFeature = branchFeatureId(data, node.branch)
  if (
    branchFeature !== undefined &&
    !state.isComplete(gatingNode(data, 'features', branchFeature) ?? '')
  ) {
    return { ok: false, reason: 'branch-locked', detail: { nodeId, branch: node.branch } }
  }

  const missing = missingPrerequisites(state, node)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing-prerequisite',
      detail: { nodeId, missing: [...missing] as JsonValue },
    }
  }

  const pause = administratorStatus(world, data, node.administrator)
  if (pause !== null) {
    return {
      ok: false,
      reason: pause === 'no-administrator' ? 'no-administrator' : 'no-office',
      detail: { nodeId, administrator: node.administrator },
    }
  }

  if (options.balance < node.cost) {
    return {
      ok: false,
      reason: 'insufficient-funds',
      detail: { nodeId, cost: node.cost, balance: options.balance },
    }
  }

  return { ok: true }
}
