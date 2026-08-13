/**
 * Trace reconstruction (PRD 3.1, T3.1).
 *
 * `buildTrace` walks cause ids to a depth of {@link TRACE_MAX_DEPTH}, resolves
 * human strings from the `traceStrings.json` catalogue, and attaches suggested
 * fixes declared per event kind.
 */

import { z } from 'zod'

import type { JsonObject, JsonValue } from '../core/commands'
import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  ticksToDay,
  ticksToTimeString,
} from '../core/clock'

import {
  REGISTERED_TRACE_KINDS,
  TRACE_KINDS,
  TRACE_MAX_DEPTH,
  eventDataObject,
} from './causalEvent'
import type { CausalEvent, CausalEventLog, EventId, TraceKind } from './causalEvent'

/* -------------------------------------------------------------------------- */
/* String catalogue                                                            */
/* -------------------------------------------------------------------------- */

const traceKindStringsSchema = z.strictObject({
  title: z.string().min(1),
  detail: z.string().min(1),
  meta: z.string().min(1),
})

export const traceStringsSchema = z.strictObject({
  kinds: z.record(z.string().min(1), traceKindStringsSchema),
})

export type TraceKindStrings = z.infer<typeof traceKindStringsSchema>
export type TraceStringsFile = z.infer<typeof traceStringsSchema>

/** Validated catalogue keyed by event kind. */
export type TraceStringCatalogue = ReadonlyMap<string, TraceKindStrings>

export function parseTraceStrings(raw: unknown): TraceStringCatalogue {
  const parsed = traceStringsSchema.parse(raw)
  return new Map(Object.entries(parsed.kinds))
}

/** True when every registered kind has a catalogue entry. */
export function catalogueCoversKinds(
  catalogue: TraceStringCatalogue,
  kinds: readonly string[],
): { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] } {
  const missing = kinds.filter((kind) => !catalogue.has(kind))
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/* -------------------------------------------------------------------------- */
/* Suggested fixes                                                             */
/* -------------------------------------------------------------------------- */

export interface SuggestedFix {
  readonly id: string
  readonly label: string
}

export type SuggestedFixFn = (event: CausalEvent) => readonly SuggestedFix[]

const SUGGESTED_FIXES = new Map<string, SuggestedFixFn>()

/** Registers (or replaces) the fix producer for an event kind. */
export function registerSuggestedFixes(kind: string, fn: SuggestedFixFn): void {
  SUGGESTED_FIXES.set(kind, fn)
}

/** Test / reset helper. */
export function clearSuggestedFixes(): void {
  SUGGESTED_FIXES.clear()
  registerDefaultSuggestedFixes()
}

function registerDefaultSuggestedFixes(): void {
  registerSuggestedFixes(TRACE_KINDS.kitchenUnderCapacity, (event) => {
    const data = eventDataObject(event.data)
    const cookers = numberField(data, 'cookers', 0)
    const neededCookers = numberField(data, 'neededCookers', cookers)
    const cooks = numberField(data, 'cooks', 0)
    const neededCooks = numberField(data, 'neededCooks', cooks)
    const cookerCost = numberField(data, 'cookerCost', 0)
    const addCookers = Math.max(0, neededCookers - cookers)
    const addCooks = Math.max(0, neededCooks - cooks)
    const fixes: SuggestedFix[] = []
    if (addCookers > 0) {
      const cost = addCookers * cookerCost
      fixes.push({
        id: 'add_cookers',
        label: `Add ${String(addCookers)} cookers · $${formatMoney(cost)}`,
      })
    }
    if (addCooks > 0) {
      fixes.push({
        id: 'assign_cooks',
        label: `Assign ${String(addCooks)} more inmates to kitchen work`,
      })
    }
    return fixes
  })
}

registerDefaultSuggestedFixes()

/* -------------------------------------------------------------------------- */
/* Trace tree                                                                  */
/* -------------------------------------------------------------------------- */

export interface TraceNode {
  readonly eventId: EventId
  readonly kind: string
  readonly subjectId: number
  readonly tick: number
  readonly depth: number
  readonly title: string
  readonly detail: string
  readonly meta: string
  /** True when none of this node's causes appear in the retained walk. */
  readonly isRootCause: boolean
  readonly causeIds: readonly EventId[]
}

export interface TraceView {
  readonly rootId: EventId
  /** Root first, then causes in BFS discovery order (vertical timeline). */
  readonly nodes: readonly TraceNode[]
  readonly fixes: readonly SuggestedFix[]
  /** Plain-text report for the "Copy report" control. */
  readonly reportText: string
}

export class TraceBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceBuildError'
  }
}

/**
 * Walks causes from `eventId` to at most {@link TRACE_MAX_DEPTH} levels and
 * returns a renderable timeline.
 */
export function buildTrace(
  log: CausalEventLog,
  eventId: EventId,
  catalogue: TraceStringCatalogue,
  maxDepth: number = TRACE_MAX_DEPTH,
): TraceView {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError(`maxDepth must be a non-negative integer, received ${String(maxDepth)}`)
  }

  const root = log.get(eventId)
  if (root === undefined) {
    throw new TraceBuildError(`unknown CausalEvent id ${String(eventId)}`)
  }

  const ordered: CausalEvent[] = []
  const depths = new Map<EventId, number>()
  const queue: Array<{ id: EventId; depth: number }> = [{ id: eventId, depth: 0 }]
  const enqueued = new Set<EventId>([eventId])

  while (queue.length > 0) {
    // Checked: length > 0.
    const next = queue.shift()
    if (next === undefined) break
    const event = log.get(next.id)
    if (event === undefined) continue
    ordered.push(event)
    depths.set(event.id, next.depth)

    if (next.depth >= maxDepth) continue
    for (const causeId of event.causeIds) {
      if (enqueued.has(causeId)) continue
      if (!log.has(causeId)) continue
      enqueued.add(causeId)
      queue.push({ id: causeId, depth: next.depth + 1 })
    }
  }

  const retained = new Set(ordered.map((event) => event.id))
  const nodes: TraceNode[] = ordered.map((event) => {
    const depth = depths.get(event.id) ?? 0
    const resolved = resolveStrings(event, catalogue)
    return {
      eventId: event.id,
      kind: event.kind,
      subjectId: event.subjectId,
      tick: event.tick,
      depth,
      title: resolved.title,
      detail: resolved.detail,
      meta: resolved.meta,
      isRootCause: event.causeIds.every((id) => !retained.has(id)),
      causeIds: event.causeIds,
    }
  })

  const fixes = collectFixes(ordered)
  return {
    rootId: eventId,
    nodes,
    fixes,
    reportText: formatReport(nodes, fixes),
  }
}

function collectFixes(events: readonly CausalEvent[]): readonly SuggestedFix[] {
  const out: SuggestedFix[] = []
  const seen = new Set<string>()
  // Deepest first so root-cause fixes surface before symptoms.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined) continue
    const fn = SUGGESTED_FIXES.get(event.kind)
    if (fn === undefined) continue
    for (const fix of fn(event)) {
      if (seen.has(fix.id)) continue
      seen.add(fix.id)
      out.push(fix)
    }
  }
  return out
}

function resolveStrings(event: CausalEvent, catalogue: TraceStringCatalogue): TraceKindStrings {
  const entry = catalogue.get(event.kind)
  if (entry === undefined) {
    throw new TraceBuildError(`no trace string for event kind '${event.kind}'`)
  }
  const data = eventDataObject(event.data)
  const vars = buildVars(event, data)
  return {
    title: interpolate(entry.title, vars),
    detail: interpolate(entry.detail, vars),
    meta: interpolate(entry.meta, vars),
  }
}

function buildVars(event: CausalEvent, data: JsonObject): Record<string, string> {
  const vars: Record<string, string> = {
    tick: String(event.tick),
    day: String(ticksToDay(event.tick)),
    time: ticksToTimeString(event.tick),
    subjectId: String(event.subjectId),
    kind: event.kind,
  }
  for (const [key, value] of Object.entries(data)) {
    vars[key] = jsonToDisplay(value)
  }
  if (!('cooksPlural' in vars) && 'cooks' in data) {
    const cooks = numberField(data, 'cooks', 1)
    vars['cooksPlural'] = cooks === 1 ? '' : 's'
  }
  return vars
}

function interpolate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : value
  })
}

function jsonToDisplay(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(jsonToDisplay).join(', ')
  return JSON.stringify(value)
}

function numberField(data: JsonObject, key: string, fallback: number): number {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function formatMoney(amount: number): string {
  return Math.round(amount).toLocaleString('en-GB')
}

function formatReport(nodes: readonly TraceNode[], fixes: readonly SuggestedFix[]): string {
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined) continue
    const prefix = i === 0 ? '' : '  <- '
    lines.push(`${prefix}${node.title}`)
  }
  if (fixes.length > 0) {
    lines.push(`  <- ${fixes.map((fix) => `[Fix: ${fix.label}]`).join('  ')}`)
  }
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* PRD 3.1 kitchen / starvation demo chain                                     */
/* -------------------------------------------------------------------------- */

/**
 * Numbers from the PRD 3.1 example. Balance lives in data; the demo fills them
 * into event payloads so the Trace shows the same figures without needing the
 * meal system (T3.3).
 */
export interface StarvationChainParams {
  readonly inmateId: number
  readonly kitchenSubjectId: number
  readonly messSubjectId: number
  readonly mealsPerCookerPerHour: number
  readonly cookAssistBonus: number
  readonly preparationLeadHours: number
  readonly cookerCost: number
}

export const PRD_STARVATION_EXAMPLE = {
  inmateId: 4471,
  kitchenName: 'K2',
  messName: 'West Hall',
  location: 'cell A-14',
  produced: 40,
  needed: 118,
  cookers: 2,
  cooks: 1,
  /** PRD 3.1 copy: "needs 6 for 118 meals". */
  neededCookers: 6,
  /** PRD 3.1 fix: "assign 3 more inmates" → 1 + 3 = 4. */
  neededCooks: 4,
  altCookers: 3,
  altCooks: 4,
  mealsEaten: 0,
  blocks: 3,
  foodNeed: 95,
  hours: 41,
  mealsAvailable: 0,
  mealsDelivered: 40,
  routed: 118,
  leftHungry: 78,
  missedThreePlus: 12,
  blockTimes: '07:00, 12:00 and 18:00',
  prepStart: '08:00',
  mealTime: '12:00',
  /** Day 28, 03:12 — the starvation death. */
  starvedDay: 28,
  starvedHour: 3,
  starvedMinute: 12,
  /** Day 27, 12:00 — the empty mess / shortfall. */
  mealDay: 27,
  mealHour: 12,
  mealMinute: 0,
} as const

/** Tick at day `day` (1-based), `hour`:`minute`. */
export function tickAt(day: number, hour: number, minute: number): number {
  return (day - 1) * TICKS_PER_DAY + hour * TICKS_PER_HOUR + minute * TICKS_PER_MINUTE
}

/**
 * Emits the five-node PRD 3.1 chain and returns the starvation event id.
 *
 * Cause order (root → leaf):
 *   inmate.starved ← inmate.missedMeal ← mess.emptyAtMealtime
 *     ← kitchen.producedShortfall ← kitchen.underCapacity
 */
export function emitPrdStarvationChain(
  log: CausalEventLog,
  params: StarvationChainParams,
): EventId {
  const ex = PRD_STARVATION_EXAMPLE
  const { mealsPerCookerPerHour, cookAssistBonus, preparationLeadHours, cookerCost } = params

  const assistFactor = 1 + cookAssistBonus * ex.cooks
  const mealsPerHour = ex.cookers * mealsPerCookerPerHour * assistFactor

  const starvedTick = tickAt(ex.starvedDay, ex.starvedHour, ex.starvedMinute)
  const mealTick = tickAt(ex.mealDay, ex.mealHour, ex.mealMinute)
  const prepTick = mealTick - preparationLeadHours * TICKS_PER_HOUR

  const underCapacity = log.record({
    tick: prepTick,
    kind: TRACE_KINDS.kitchenUnderCapacity,
    subjectId: params.kitchenSubjectId,
    causeIds: [],
    data: {
      kitchenName: ex.kitchenName,
      cookers: ex.cookers,
      cooks: ex.cooks,
      mealsPerCookerPerHour,
      assistFactor,
      mealsPerHour,
      needed: ex.needed,
      prepHours: preparationLeadHours,
      neededCookers: ex.neededCookers,
      neededCooks: ex.neededCooks,
      altCookers: ex.altCookers,
      altCooks: ex.altCooks,
      cookerCost,
    },
  })

  const shortfall = log.record({
    tick: mealTick,
    kind: TRACE_KINDS.kitchenProducedShortfall,
    subjectId: params.kitchenSubjectId,
    causeIds: [underCapacity.id],
    data: {
      kitchenName: ex.kitchenName,
      produced: ex.produced,
      needed: ex.needed,
      prepStart: ex.prepStart,
      mealTime: ex.mealTime,
    },
  })

  const emptyMess = log.record({
    tick: mealTick,
    kind: TRACE_KINDS.messEmptyAtMealtime,
    subjectId: params.messSubjectId,
    causeIds: [shortfall.id],
    data: {
      messName: ex.messName,
      mealsAvailable: ex.mealsAvailable,
      mealsDelivered: ex.mealsDelivered,
      routed: ex.routed,
      leftHungry: ex.leftHungry,
      missedThreePlus: ex.missedThreePlus,
      time: ex.mealTime,
    },
  })

  const missed = log.record({
    tick: mealTick,
    kind: TRACE_KINDS.inmateMissedMeal,
    subjectId: params.inmateId,
    causeIds: [emptyMess.id],
    data: {
      mealsEaten: ex.mealsEaten,
      blocks: ex.blocks,
      messName: ex.messName,
      blockTimes: ex.blockTimes,
    },
  })

  const starved = log.record({
    tick: starvedTick,
    kind: TRACE_KINDS.inmateStarved,
    subjectId: params.inmateId,
    causeIds: [missed.id],
    data: {
      inmateId: params.inmateId,
      foodNeed: ex.foodNeed,
      hours: ex.hours,
      location: ex.location,
    },
  })

  return starved.id
}

const REGISTERED_TRACE_KIND_SET: ReadonlySet<string> = new Set(REGISTERED_TRACE_KINDS)

/** Type guard for registered Trace kinds. */
export function isTraceKind(kind: string): kind is TraceKind {
  return REGISTERED_TRACE_KIND_SET.has(kind)
}
