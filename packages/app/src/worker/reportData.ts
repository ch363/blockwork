/**
 * Worker-authoritative report aggregation (T6.2).
 *
 * Every input is live simulation state. The main thread receives a finished,
 * structured snapshot and never walks registries or re-applies thresholds.
 */

import {
  FINANCE_CHART_DAYS,
  HOURS_PER_DAY,
  MAX_SAVED_LOG_ENTRIES,
  NOTIFICATION_SEVERITY,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  housingCapacity,
  gatingNode,
  hasFeature,
  eventDataObject,
  isOperational,
  isTraceKind,
  ticksToDay,
  ticksToTimeString,
} from '@blockwork/sim'
import type {
  CausalEvent,
  CausalEventLog,
  GameData,
  InmateWorld,
  JsonValue,
  NotificationSeverity,
  ReadonlyClock,
  Room,
} from '@blockwork/sim'
import type {
  FinanceReportModel,
  NeedBottleneckModel,
  NeedFacilityModel,
  NeedLocationModel,
  NeedReportRowModel,
  NeedsReportModel,
  PopulationReportModel,
  ReportCategoryAmount,
  ReportLogRowModel,
  ReportSeverity,
  ReportsModel,
  SentenceBandModel,
  StatisticMetricModel,
} from '@blockwork/ui'

import { buildDepthHud } from './depthHud'

export type ReportSeverityResolver = (kind: string) => NotificationSeverity

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  intake_fee: 'Intake fees',
  inmate_payment: 'Inmate payments',
  wages: 'Staff wages',
  hire: 'Hiring',
  construction: 'Construction',
  construction_refund: 'Construction refunds',
  utilities: 'Utilities',
  loan_interest: 'Loan interest',
  loan_principal: 'Loan principal',
  tax: 'Tax',
  contract: 'Contracts',
  export: 'Exports',
  commissary: 'Commissary',
  program: 'Programmes',
  research: 'Directorate research',
  emergency: 'Emergency response',
  other: 'Other',
}

/** Sentence progress buckets are a report layout, not simulation balance. */
const SENTENCE_PROGRESS_BANDS: readonly {
  readonly id: string
  readonly label: string
  readonly from: number
  readonly to: number
}[] = [
  { id: 'opening', label: 'Under 25% served', from: 0, to: 0.25 },
  { id: 'early', label: '25–50% served', from: 0.25, to: 0.5 },
  { id: 'late', label: '50–75% served', from: 0.5, to: 0.75 },
  { id: 'closing', label: 'Over 75% served', from: 0.75, to: Number.POSITIVE_INFINITY },
]

const ROOM_EVENT_CATEGORIES = new Set([
  'kitchen',
  'mess',
  'laundry',
  'cleaning',
  'room',
  'utilities',
])

export interface BuildReportsOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly clock: ReadonlyClock
  readonly log: CausalEventLog
  readonly severityForKind: ReportSeverityResolver
}

export function buildReportsModel(options: BuildReportsOptions): ReportsModel {
  const { world, data, clock, log, severityForKind } = options
  // PRD 7.4 caps the persistent event history at the same 2,000 rows written
  // into SaveFile.log. The report mirrors that persisted window exactly.
  const retained = newestCausalEvents(log.retainedEvents(), MAX_SAVED_LOG_ENTRIES)
  const financeUnlocked = hasFeature(data, world.directorate, 'finance_reports')
  const needsUnlocked = hasFeature(data, world.directorate, 'needs_report')
  const intelligenceUnlocked = hasFeature(data, world.directorate, 'intelligence_panel')
  const intelligence = intelligenceUnlocked
    ? buildDepthHud(world, data, clock, null).intelligence
    : null

  return {
    tick: clock.tick,
    day: ticksToDay(clock.tick),
    population: world.inmates.size,
    finance: financeUnlocked ? buildFinance(world, clock.tick) : null,
    needs: needsUnlocked ? buildNeeds(world, data, clock.tick, retained) : null,
    access: {
      finance: reportAccess(data, 'finance_reports', financeUnlocked),
      needs: reportAccess(data, 'needs_report', needsUnlocked),
      intelligence: reportAccess(data, 'intelligence_panel', intelligenceUnlocked),
    },
    populationReport: buildPopulation(world, data, clock.tick),
    intelligence,
    log: buildEventLog(world, data, retained, severityForKind),
    statistics: {
      metrics: buildStatistics(world, data, clock.tick, retained),
    },
  }
}

/**
 * Returns the newest events in chronological order.
 *
 * `CausalEventLog.retainedEvents()` deliberately lists its ring before
 * pinned-but-evicted traces, so callers that persist a time window must sort
 * before slicing or one ancient pinned trace can displace a recent event.
 */
export function newestCausalEvents(events: readonly CausalEvent[], limit: number): CausalEvent[] {
  return [...events].sort((a, b) => a.tick - b.tick || a.id - b.id).slice(-Math.max(0, limit))
}

function reportAccess(
  data: GameData,
  featureId: string,
  unlocked: boolean,
): { readonly unlocked: boolean; readonly requirement: string | null } {
  if (unlocked) return { unlocked: true, requirement: null }
  const nodeId = gatingNode(data, 'features', featureId)
  const name = nodeId === undefined ? null : (data.directorate.find(nodeId)?.name ?? nodeId)
  return { unlocked: false, requirement: name }
}

function buildFinance(world: InmateWorld, tick: number): FinanceReportModel {
  const report = world.economy.buildFinanceReport(tick)
  const income: ReportCategoryAmount[] = []
  const expenses: ReportCategoryAmount[] = []

  for (const row of report.breakdownByCategory) {
    if (row.amount === 0) continue
    const display: ReportCategoryAmount = {
      id: row.category,
      label: CATEGORY_LABELS[row.category] ?? sentenceCase(row.category),
      amount: Math.abs(row.amount),
    }
    if (row.amount > 0) income.push(display)
    else expenses.push(display)
  }
  income.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
  expenses.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))

  return {
    balance: report.balance,
    loanPrincipal: report.loanPrincipal,
    cashFlow24h: report.cashFlow24h,
    projectedDailyNet: report.projectedDailyNet,
    last7Days: report.last7Days.map((row) => ({ ...row })),
    income,
    expenses,
  }
}

function buildNeeds(
  world: InmateWorld,
  data: GameData,
  tick: number,
  events: readonly CausalEvent[],
): NeedsReportModel {
  const inmates = world.inmates.all()
  const rows: NeedReportRowModel[] = []
  const inmatesWithCritical = new Set<number>()
  let weightedNeedTotal = 0
  let weightTotal = 0

  for (let needIndex = 0; needIndex < data.needs.all.length; needIndex += 1) {
    const def = data.needs.all[needIndex]
    if (def === undefined) continue

    const bands = { satisfied: 0, medium: 0, high: 0, critical: 0 }
    const criticalByRoom = new Map<number, number>()
    let demand = 0

    for (const inmate of inmates) {
      const value = inmate.inmate.needs[needIndex] ?? 0
      const weight = def.escalatesToViolence ? data.balance.needs.violenceWeightMultiplier : 1
      weightedNeedTotal += value * weight
      weightTotal += weight

      if (value >= def.thresholds.critical) {
        bands.critical += 1
        demand += 1
        inmatesWithCritical.add(inmate.id)
        const roomId = roomOfInmate(world, inmate.tx, inmate.ty, inmate.inmate.cellId)
        criticalByRoom.set(roomId, (criticalByRoom.get(roomId) ?? 0) + 1)
      } else if (value >= def.thresholds.high) {
        bands.high += 1
        demand += 1
      } else if (value >= def.thresholds.medium) {
        bands.medium += 1
        demand += 1
      } else {
        bands.satisfied += 1
      }
    }

    const facilities = facilitiesForNeed(world, data, def.id)
    const capacity = facilities.reduce((sum, facility) => sum + facility.operationalCapacity, 0)
    const locations: NeedLocationModel[] = [...criticalByRoom.entries()]
      .map(([roomId, count]) => ({
        roomId,
        roomName: roomDisplayName(world, data, roomId),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.roomId - b.roomId)

    rows.push({
      id: def.id,
      name: def.name,
      bands,
      demand,
      capacity,
      facilities,
      criticalLocations: locations,
      bottleneck: bottleneckForNeed(world, data, def.id, demand, facilities),
    })
  }

  rows.sort(
    (a, b) =>
      b.bands.critical - a.bands.critical ||
      b.bands.high - a.bands.high ||
      a.name.localeCompare(b.name),
  )

  const misconductFrom = tick - TICKS_PER_DAY
  const misconduct24h = events.filter(
    (event) => event.tick > misconductFrom && event.kind === 'misconduct.committed',
  ).length

  return {
    population: inmates.length,
    inmatesWithCriticalNeed: inmatesWithCritical.size,
    meanMood:
      weightTotal === 0 ? 100 : Math.max(0, Math.round(100 - weightedNeedTotal / weightTotal)),
    misconduct24h,
    rows,
  }
}

function roomOfInmate(world: InmateWorld, tx: number, ty: number, cellId: number): number {
  if (tx >= 0 && ty >= 0 && tx < world.grid.size && ty < world.grid.size) {
    const roomId = world.grid.roomId[ty * world.grid.size + tx] ?? 0
    if (roomId > 0) return roomId
  }
  return cellId
}

function facilitiesForNeed(
  world: InmateWorld,
  data: GameData,
  needId: string,
): NeedFacilityModel[] {
  const byRoom = new Map<number, { capacity: number; operational: number }>()

  // Activity only claims fixtures from a room whose definition serves this
  // need. Corridor fixtures and objects in unrelated rooms are not capacity.
  for (const room of world.rooms.all()) {
    const roomDef = data.rooms.find(room.defId)
    if (roomDef?.servesNeeds.includes(needId) !== true) continue
    const functional = world.rooms.statusOf(room.id)?.functional === true
    const totals = { capacity: 0, operational: 0 }
    for (const object of world.objects.inRoom(room.id)) {
      const objectDef = data.objects.find(object.object.defId)
      const service = objectDef?.servesNeeds.find((entry) => entry.need === needId)
      if (service === undefined) continue
      totals.capacity += service.concurrentUsers
      if (functional && isOperational(object)) totals.operational += service.concurrentUsers
    }
    byRoom.set(room.id, totals)
  }

  return [...byRoom.entries()]
    .map(([roomId, totals]) => ({
      roomId,
      roomName: roomDisplayName(world, data, roomId),
      capacity: totals.capacity,
      operationalCapacity: totals.operational,
    }))
    .sort((a, b) => a.roomId - b.roomId)
}

function bottleneckForNeed(
  world: InmateWorld,
  data: GameData,
  needId: string,
  demand: number,
  facilities: readonly NeedFacilityModel[],
): NeedBottleneckModel | null {
  if (demand === 0) return null

  const servingDefs = data.objects.all.filter((def) =>
    def.servesNeeds.some((entry) => entry.need === needId),
  )
  // Danger- and time-driven needs with no facility concept must not invent a
  // zero-capacity building problem.
  if (servingDefs.length === 0 && facilities.length === 0) return null

  const total = facilities.reduce((sum, facility) => sum + facility.capacity, 0)
  const operational = facilities.reduce((sum, facility) => sum + facility.operationalCapacity, 0)
  if (operational >= demand) return null

  const blockedFacility = [...facilities].sort(
    (a, b) =>
      b.capacity - b.operationalCapacity - (a.capacity - a.operationalCapacity) ||
      a.roomId - b.roomId,
  )[0]
  if (
    blockedFacility !== undefined &&
    blockedFacility.capacity > blockedFacility.operationalCapacity
  ) {
    const offlineByDef = new Map<string, number>()
    const roomFunctional = world.rooms.statusOf(blockedFacility.roomId)?.functional === true
    for (const object of world.objects.inRoom(blockedFacility.roomId)) {
      if (roomFunctional && isOperational(object)) continue
      const def = data.objects.find(object.object.defId)
      const service = def?.servesNeeds.find((entry) => entry.need === needId)
      if (def === undefined || service === undefined) continue
      offlineByDef.set(def.id, (offlineByDef.get(def.id) ?? 0) + service.concurrentUsers)
    }
    const offline = [...offlineByDef.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]
    const offlineName =
      offline === undefined
        ? 'facility'
        : (data.objects.find(offline[0])?.name ?? sentenceCase(offline[0]))
    const offlineCapacity = offline?.[1] ?? blockedFacility.capacity
    return {
      title: `Bottleneck: ${blockedFacility.roomName} ${offlineName}`,
      detail: `${String(offlineCapacity)} places are offline in ${blockedFacility.roomName}. Prison-wide operational capacity is ${String(operational)} for demand of ${String(demand)}.`,
    }
  }

  const fixture = servingDefs[0]?.name ?? 'serving fixtures'
  const tightest = [...facilities].sort(
    (a, b) => a.operationalCapacity - b.operationalCapacity || a.roomId - b.roomId,
  )[0]
  return {
    title: `Bottleneck: ${tightest?.roomName ?? 'no serving room'} ${fixture}`,
    detail: `${String(total)} places are installed and ${String(operational)} are operational for demand of ${String(demand)}.`,
  }
}

function buildPopulation(world: InmateWorld, data: GameData, tick: number): PopulationReportModel {
  const inmates = world.inmates.all()
  const byCategory = new Map<string, number>()
  for (const inmate of inmates) {
    byCategory.set(inmate.inmate.category, (byCategory.get(inmate.inmate.category) ?? 0) + 1)
  }

  const categories = data.securityCategories.all.map((def) => ({
    id: def.id,
    name: def.name,
    count: byCategory.get(def.id) ?? 0,
  }))

  const sentenceBands: SentenceBandModel[] = SENTENCE_PROGRESS_BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    count: 0,
  }))
  for (const inmate of inmates) {
    const total = inmate.inmate.sentenceHours
    const progress = total <= 0 ? 1 : inmate.inmate.servedHours / total
    const index = SENTENCE_PROGRESS_BANDS.findIndex(
      (band) => progress >= band.from && progress < band.to,
    )
    const row = sentenceBands[index < 0 ? sentenceBands.length - 1 : index]
    if (row !== undefined) {
      sentenceBands[index < 0 ? sentenceBands.length - 1 : index] = {
        ...row,
        count: row.count + 1,
      }
    }
  }

  const releaseWindowHours = FINANCE_CHART_DAYS * HOURS_PER_DAY
  let next7Days = 0
  for (const inmate of inmates) {
    if (
      inmate.inmate.sentenceHours > 0 &&
      inmate.inmate.sentenceHours - inmate.inmate.servedHours <= releaseWindowHours
    ) {
      next7Days += 1
    }
  }

  const releaseFrom = tick - FINANCE_CHART_DAYS * TICKS_PER_DAY
  let last7Days = 0
  let parole = 0
  let sentenceServed = 0
  for (const record of world.release.released) {
    if (record.releasedTick >= releaseFrom) last7Days += 1
    if (record.reason === 'parole') parole += 1
    else sentenceServed += 1
  }

  const requested = data.securityCategories.all
    .map((def) => ({
      id: def.id,
      name: def.name,
      requested: world.intake.requestedCounts.get(def.id) ?? 0,
    }))
    .filter((row) => row.requested > 0)

  return {
    total: inmates.length,
    capacity: housingCapacity(world.rooms, world.objects),
    categories,
    sentenceBands,
    arrivals: {
      continuous: world.intake.continuous,
      nextBusLabel: relativeTickLabel(world.intake.nextBusAtTick, tick),
      requested,
    },
    releases: {
      next7Days,
      last7Days,
      lifetime: world.release.lifetimeReleased,
      parole,
      sentenceServed,
    },
  }
}

function relativeTickLabel(targetTick: number, tick: number): string {
  const remaining = Math.max(0, targetTick - tick)
  const hours = Math.floor(remaining / TICKS_PER_HOUR)
  const minutes = Math.floor((remaining % TICKS_PER_HOUR) / TICKS_PER_MINUTE)
  if (hours <= 0) return `in ${String(minutes)}m`
  if (minutes <= 0) return `in ${String(hours)}h`
  return `in ${String(hours)}h ${String(minutes)}m`
}

function buildEventLog(
  world: InmateWorld,
  data: GameData,
  events: readonly CausalEvent[],
  severityForKind: ReportSeverityResolver,
): ReportLogRowModel[] {
  return events
    .map((event) => {
      const presentation = resolveEventPresentation(event, severityForKind)
      const entity = eventEntity(event)
      return {
        id: event.id,
        tick: event.tick,
        timeLabel: `Day ${String(ticksToDay(event.tick))} · ${ticksToTimeString(event.tick)}`,
        severity: presentation.reportSeverity,
        category: eventCategory(event.kind),
        entityId: entity.id,
        entityKey: `${entity.kind}:${String(entity.id)}`,
        entityName: entityName(world, data, event, entity),
        title: eventTitle(event.kind),
        detail: summariseEventData(event.data),
        traceId: presentation.traceId,
      }
    })
    .reverse()
}

export interface EventPresentation {
  readonly reportSeverity: ReportSeverity
  readonly notificationSeverity: NotificationSeverity
  readonly traceId: number | null
}

/** One severity/Trace decision shared by Reports and persisted log rows. */
export function resolveEventPresentation(
  event: CausalEvent,
  severityForKind: ReportSeverityResolver,
): EventPresentation {
  const explicit = stringFromData(event.data, 'severity')
  const notificationSeverity =
    explicit === 'critical'
      ? NOTIFICATION_SEVERITY.CRITICAL
      : explicit === 'warn'
        ? NOTIFICATION_SEVERITY.WARN
        : explicit === 'info'
          ? NOTIFICATION_SEVERITY.INFO
          : severityForKind(event.kind)
  return {
    reportSeverity: reportSeverity(notificationSeverity),
    notificationSeverity,
    traceId:
      notificationSeverity === NOTIFICATION_SEVERITY.INFO || !isTraceKind(event.kind)
        ? null
        : event.id,
  }
}

function reportSeverity(severity: NotificationSeverity): ReportSeverity {
  if (severity === NOTIFICATION_SEVERITY.CRITICAL) return 'critical'
  if (severity === NOTIFICATION_SEVERITY.WARN) return 'warn'
  return 'info'
}

function eventCategory(kind: string): string {
  return kind.split('.')[0] ?? 'other'
}

function eventTitle(kind: string): string {
  const [, action = kind] = kind.split('.', 2)
  return sentenceCase(action)
}

function sentenceCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return words.length === 0 ? 'Event' : words.charAt(0).toUpperCase() + words.slice(1)
}

function summariseEventData(data: JsonValue): string {
  if (data === null) return ''
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return String(data)
  }
  if (Array.isArray(data)) return data.map((entry) => summariseEventData(entry)).join(', ')
  return Object.entries(data)
    .map(([key, value]) => `${sentenceCase(key)}: ${summariseEventData(value)}`)
    .join(' · ')
}

interface EventEntity {
  readonly id: number
  readonly kind: 'inmate' | 'staff' | 'object' | 'room' | 'unknown'
}

function eventEntity(event: CausalEvent): EventEntity {
  // Prefer registry-qualified ids carried by the event payload. Registry ids
  // overlap (inmate 1, staff 1, object 1), while subjectId is intentionally
  // generic and therefore cannot safely drive the entity filter on its own.
  const candidates: readonly {
    readonly key: string
    readonly kind: EventEntity['kind']
  }[] = [
    { key: 'inmateId', kind: 'inmate' },
    { key: 'staffId', kind: 'staff' },
    { key: 'objectId', kind: 'object' },
    { key: 'roomId', kind: 'room' },
    { key: 'kitchenRoomId', kind: 'room' },
    { key: 'messRoomId', kind: 'room' },
  ]
  for (const candidate of candidates) {
    const id = numberFromData(event.data, candidate.key)
    if (id > 0) return { id, kind: candidate.kind }
  }

  const agentId = numberFromData(event.data, 'agentId')
  if (agentId > 0) {
    const agentKind =
      entityKindFromData(event.data, 'agentKind') ?? entityKindFromData(event.data, 'claimantKind')
    if (agentKind === 'inmate' || agentKind === 'staff') {
      return { id: agentId, kind: agentKind }
    }
  }

  const entityId = numberFromData(event.data, 'entityId')
  if (entityId > 0) {
    const kind =
      entityKindFromData(event.data, 'entityKind') ??
      entityKindFromData(event.data, 'kind') ??
      entityKindFromEventPrefix(event.kind)
    return { id: entityId, kind: kind ?? 'unknown' }
  }
  if (event.subjectId > 0) {
    return {
      id: event.subjectId,
      kind: ROOM_EVENT_CATEGORIES.has(eventCategory(event.kind)) ? 'room' : 'unknown',
    }
  }
  return { id: 0, kind: 'unknown' }
}

function entityKindFromData(data: JsonValue, key: string): EventEntity['kind'] | null {
  const value = stringFromData(data, key)
  if (value === 'inmate' || value === 'staff' || value === 'object' || value === 'room') {
    return value
  }
  return null
}

function entityKindFromEventPrefix(kind: string): EventEntity['kind'] | null {
  const prefix = eventCategory(kind)
  if (prefix === 'inmate') return 'inmate'
  if (prefix === 'staff') return 'staff'
  if (prefix === 'object' || prefix === 'objects') return 'object'
  if (prefix === 'room' || prefix === 'rooms') return 'room'
  return null
}

function numberFromData(data: JsonValue, key: string): number {
  const value = eventDataObject(data)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

function stringFromData(data: JsonValue, key: string): string | null {
  const value = eventDataObject(data)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function entityName(
  world: InmateWorld,
  data: GameData,
  event: CausalEvent,
  entity: EventEntity,
): string {
  if (entity.id <= 0) return 'Prison-wide'
  const category = eventCategory(event.kind)

  if (
    entity.kind === 'room' ||
    (entity.kind === 'unknown' && ROOM_EVENT_CATEGORIES.has(category))
  ) {
    const room = world.rooms.get(entity.id)
    if (room !== undefined) return roomDisplayNameFromRoom(world, data, room)
  }
  if (entity.kind === 'inmate' || entity.kind === 'unknown') {
    const inmate = world.inmates.get(entity.id)
    if (inmate !== undefined) return `${inmate.inmate.name} · #${String(inmate.id)}`
  }
  if (entity.kind === 'staff' || entity.kind === 'unknown') {
    const staff = world.staff.get(entity.id)
    if (staff !== undefined) return `${staff.staff.name} · #${String(staff.id)}`
  }
  if (entity.kind === 'object' || entity.kind === 'unknown') {
    const object = world.objects.get(entity.id)
    if (object !== undefined) {
      const name = data.objects.find(object.object.defId)?.name ?? object.object.defId
      return `${name} · #${String(object.id)}`
    }
  }
  if (entity.kind === 'room' || entity.kind === 'unknown') {
    const room = world.rooms.get(entity.id)
    if (room !== undefined) return roomDisplayNameFromRoom(world, data, room)
  }
  const frozenName =
    stringFromData(event.data, 'name') ??
    stringFromData(event.data, 'inmateName') ??
    stringFromData(event.data, 'staffName') ??
    stringFromData(event.data, 'roomName') ??
    stringFromData(event.data, 'kitchenName') ??
    stringFromData(event.data, 'messName')
  return frozenName === null
    ? `Entity #${String(entity.id)}`
    : `${frozenName} · #${String(entity.id)}`
}

function roomDisplayName(world: InmateWorld, data: GameData, roomId: number): string {
  if (roomId <= 0) return 'Unassigned areas'
  const room = world.rooms.get(roomId)
  return room === undefined ? `Room ${String(roomId)}` : roomDisplayNameFromRoom(world, data, room)
}

function roomDisplayNameFromRoom(world: InmateWorld, data: GameData, room: Room): string {
  const custom = world.meals.roomNames.get(room.id)
  if (custom !== undefined) return custom
  const name = data.rooms.find(room.defId)?.name ?? sentenceCase(room.defId)
  return `${name} ${String(room.id)}`
}

function buildStatistics(
  world: InmateWorld,
  data: GameData,
  tick: number,
  events: readonly CausalEvent[],
): StatisticMetricModel[] {
  const releases = world.release.statistics(data, tick)
  const inmates = world.inmates.all()
  const meanReoffend =
    inmates.length === 0
      ? 0
      : inmates.reduce((sum, inmate) => sum + inmate.inmate.reoffendChance, 0) / inmates.length
  const totalCompletions = [...world.programs.completions.values()].reduce(
    (sum, completed) => sum + completed.size,
    0,
  )
  const deaths = countKinds(events, new Set(['combat.died']))
  const escapes = countKinds(events, new Set(['escape.inmateEscaped']))
  const misconduct = countKinds(events, new Set(['misconduct.committed']))
  const fires = countKinds(events, new Set(['fire.ignited']))

  return [
    metric(
      'population',
      'Current population',
      String(inmates.length),
      `${String(housingCapacity(world.rooms, world.objects))} housing places`,
    ),
    metric('staff', 'Staff employed', String(world.staff.size), 'All roles'),
    metric(
      'reoffend',
      'Estimated re-offending',
      `${String(Math.round(meanReoffend * 100))}%`,
      'Mean across current inmates',
      meanReoffend >= 0.5 ? 'warn' : 'neutral',
    ),
    metric(
      'released',
      'People released',
      String(releases.lifetimeReleased),
      `${String(releases.lifetimeReoffended)} later re-offended`,
    ),
    metric(
      'reoffended',
      'Lifetime re-offences',
      String(releases.lifetimeReoffended),
      `${String(releases.lifetimeReleased)} people released`,
      releases.lifetimeReoffended > 0 ? 'warn' : 'ok',
    ),
    metric(
      'recidivism',
      'Rolling re-offending rate',
      `${String(Math.round(releases.rate * 100))}%`,
      `${String(releases.reoffended)} of ${String(releases.released)} in the reporting window`,
      releases.rate > 0 ? 'warn' : 'ok',
    ),
    metric(
      'programs',
      'Current completion records',
      String(totalCompletions),
      'Successful records still held on site',
      'ok',
    ),
    metric(
      'misconduct',
      'Misconduct recorded',
      String(misconduct),
      'Saved event-log window',
      misconduct > 0 ? 'warn' : 'neutral',
    ),
    metric(
      'deaths',
      'Deaths recorded',
      String(deaths),
      'Saved event-log window',
      deaths > 0 ? 'danger' : 'ok',
    ),
    metric(
      'escapes',
      'Escapes recorded',
      String(escapes),
      'Saved event-log window',
      escapes > 0 ? 'danger' : 'ok',
    ),
    metric(
      'fires',
      'Fires recorded',
      String(fires),
      'Saved event-log window',
      fires > 0 ? 'warn' : 'ok',
    ),
    metric(
      'meals',
      'Meals served',
      String(world.meals.mealsServed),
      `${String(world.meals.missedMeals)} missed meals`,
      world.meals.missedMeals > 0 ? 'warn' : 'ok',
    ),
    metric(
      'balance',
      'Balance',
      formatMoney(world.economy.balance),
      `${formatMoney(world.economy.cashFlowSince(tick))} over 24h`,
      world.economy.balance < 0 ? 'danger' : 'neutral',
    ),
  ]
}

function countKinds(events: readonly CausalEvent[], kinds: ReadonlySet<string>): number {
  let count = 0
  for (const event of events) {
    if (kinds.has(event.kind)) count += 1
  }
  return count
}

function metric(
  id: string,
  label: string,
  value: string,
  detail: string,
  tone: StatisticMetricModel['tone'] = 'neutral',
): StatisticMetricModel {
  return { id, label, value, detail, tone }
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-GB')}`
}
