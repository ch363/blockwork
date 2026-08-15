/**
 * Live control-panel summaries for Posts, Emergency and Standing Orders.
 *
 * Built on the worker from authoritative `InmateWorld` state so the main
 * thread never walks registries. Shapes match `@blockwork/ui` panel models.
 */

import {
  MISCONDUCT_KINDS,
  NO_SECTOR,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  gatingNode,
  hasFeature,
  housingCapacity,
  isContractAvailable,
  isUnlocked,
  maxConcurrentContracts,
  type GameData,
  type InmateWorld,
  type MisconductKind,
  type ReadonlyClock,
} from '@blockwork/sim'
import type {
  EmergencyLevelModel,
  EmergencyModel,
  PostsModel,
  PostsRowModel,
  SectorRowModel,
  StandingOrdersModel,
  StandingOrdersRowModel,
  StandingPunishment,
  UnfilledReasonLabel,
  DirectorateModel,
  ProgramsModel,
  IntelligenceModel,
  RoutineModel,
  RoutineBlockId,
  ContractsModel,
  ContractRowModel,
  IntakeModel,
  FlowModel,
  FlowChainModel,
  FlowStageModel,
} from '@blockwork/ui'
import { MISCONDUCT_LABELS, unfilledReasonLabel } from '@blockwork/ui'

import type { UnlockSnapshot } from '../game/palette'
import { buildDepthHud } from './depthHud'

const ACCESS_LABELS: Readonly<Record<string, string>> = {
  staffOnly: 'Staff only',
  secure: 'Secure',
  shared: 'Shared',
  open: 'Open',
}

export interface ControlHud {
  readonly posts: PostsModel
  readonly emergency: EmergencyModel
  readonly standingOrders: StandingOrdersModel
  readonly directorate: DirectorateModel
  readonly programs: ProgramsModel
  readonly intelligence: IntelligenceModel
  readonly routine: RoutineModel
  readonly contracts: ContractsModel
  readonly intake: IntakeModel
  readonly flow: FlowModel
  readonly unlocks: UnlockSnapshot
}

export function buildControlHud(
  world: InmateWorld,
  data: GameData,
  clock: ReadonlyClock,
  selectedSectorId: number | null,
  inspectedInmateId: number | null = null,
): ControlHud {
  const depth = buildDepthHud(world, data, clock, inspectedInmateId)
  return {
    posts: buildPostsModel(world, data, clock),
    emergency: buildEmergencyModel(world, data, selectedSectorId),
    standingOrders: buildStandingOrdersModel(world, data),
    directorate: depth.directorate,
    programs: depth.programs,
    intelligence: depth.intelligence,
    routine: buildRoutineModel(world, data),
    contracts: buildContractsModel(world, data),
    intake: buildIntakeModel(world, data, clock.tick),
    flow: buildFlowModel(world, data),
    unlocks: buildUnlockSnapshot(world, data),
  }
}

/** Content the trays may offer after Directorate research (T5.1). */
export function buildUnlockSnapshot(world: InmateWorld, data: GameData): UnlockSnapshot {
  const state = world.directorate
  return {
    rooms: data.rooms.all
      .filter((room) => isUnlocked(data, state, 'rooms', room.id))
      .map((room) => room.id),
    objects: data.objects.all
      .filter((object) => isUnlocked(data, state, 'objects', object.id))
      .map((object) => object.id),
    staff: data.staff.all
      .filter((member) => isUnlocked(data, state, 'staff', member.id))
      .map((member) => member.id),
  }
}

function buildPostsModel(world: InmateWorld, data: GameData, clock: ReadonlyClock): PostsModel {
  const posts: PostsRowModel[] = world.posts.posts().map((post) => ({
    id: post.id,
    name: post.name,
    detail: postDetail(post.staffRole, post.timeWindows),
    filled: post.assigned.length,
    required: post.count,
    shortfallReason: labelShortfall(post.shortfallReason),
  }))

  const patrols: PostsRowModel[] = world.posts.routes().map((route) => ({
    id: route.id,
    name: route.name,
    detail: postDetail(route.staffRole, route.timeWindows),
    filled: route.assigned.length,
    required: route.count,
    shortfallReason: labelShortfall(route.shortfallReason),
  }))

  const sectors: SectorRowModel[] = world.sectors.all().map((sector) => ({
    id: sector.id,
    name: sector.name,
    colour: sector.colour,
    access: ACCESS_LABELS[sector.access] ?? sector.access,
    categories: sector.categories.join(', '),
    tileCount: world.sectors.tilesOf(sector.id).length,
  }))

  let deployedCount = 0
  for (const post of world.posts.posts()) deployedCount += post.assigned.length
  for (const route of world.posts.routes()) deployedCount += route.assigned.length

  const hiredOfficers = countOfficers(world, data)
  const peak = peakRequirement(world, clock.hour)
  const shortfall = Math.max(0, peak.required - hiredOfficers)
  const officerDef = data.staff.find('officer')

  return {
    unfilledCount: world.posts.unfilledCount,
    deployedCount,
    hiredOfficers,
    peakRequired: peak.required,
    peakWindow: peak.window,
    posts,
    patrols,
    sectors,
    hireSuggestion: shortfall,
    hireCost: (officerDef?.hireCost ?? 0) * shortfall,
    hireWagePerHour: (officerDef?.hourlyWage ?? 0) * shortfall,
  }
}

function buildEmergencyModel(
  world: InmateWorld,
  data: GameData,
  selectedSectorId: number | null,
): EmergencyModel {
  const emergency = data.balance.emergency
  const riotWage = data.staff.get(emergency.riotSquadDefId).hourlyWage * emergency.riotSquadCount
  const state = world.emergency
  const selected =
    selectedSectorId !== null && selectedSectorId !== NO_SECTOR
      ? world.sectors.get(selectedSectorId)
      : undefined
  const sectorSelected = selected !== undefined
  const sectorLocked =
    sectorSelected && selectedSectorId !== null
      ? state.sectorLockdowns.has(selectedSectorId)
      : false

  const levels: EmergencyLevelModel[] = [
    {
      id: 'sector_lockdown',
      level: 1,
      label: 'Sector lockdown',
      costLabel: 'Free',
      sideEffect: '+suppression in that sector',
      active: sectorLocked,
      disabled: !sectorSelected,
      disabledReason: sectorSelected ? null : 'Select a sector in Posts first',
    },
    {
      id: 'full_lockdown',
      level: 2,
      label: 'Full lockdown',
      costLabel: 'Free',
      sideEffect: '+suppression prison-wide, needs go unmet',
      active: state.fullLockdown,
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'riot_squad',
      level: 3,
      label: 'Call in riot squad',
      costLabel: `$${riotWage}/hour`,
      sideEffect: 'Injuries, +fear',
      active: state.riotSquadActive,
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'free_fire',
      level: 4,
      label: 'Free fire authorisation',
      costLabel: 'Free',
      sideEffect: 'Deaths, huge re-offending and PR penalty',
      active: state.freeFireActive,
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'national_guard',
      level: 5,
      label: 'Call the national guard',
      costLabel: `$${emergency.nationalGuardCost}`,
      sideEffect: 'Prison retaken; you are almost certainly fired',
      active: state.nationalGuardActive,
      disabled: false,
      disabledReason: null,
    },
  ]

  return {
    danger: Math.max(0, Math.min(100, Math.round(world.dangerLevel))),
    riotActive: world.riotActive,
    riotingCount: world.riot.riotingInmateIds.size,
    containmentQuietMinutes: world.riotActive ? world.riot.quietMinutes : null,
    containmentNeededMinutes: data.balance.riot.containedMinutes,
    failureWarning: state.warningEmitted,
    failureAtTick: state.failureAtTick,
    playerFired: state.playerFired,
    riotSquadHourlyCost: riotWage,
    nationalGuardCost: emergency.nationalGuardCost,
    selectedSectorId: sectorSelected ? selectedSectorId : null,
    selectedSectorName: selected?.name ?? null,
    levels,
  }
}

function buildStandingOrdersModel(world: InmateWorld, data: GameData): StandingOrdersModel {
  const orders = world.standingOrders
  const rows: StandingOrdersRowModel[] = MISCONDUCT_KINDS.map((kind: MisconductKind) => {
    const order = orders.misconduct[kind]
    const punishment = order.punishment as StandingPunishment
    return {
      misconduct: kind,
      label: MISCONDUCT_LABELS[kind] ?? kind,
      punishment,
      durationHours: punishment === 'ignore' ? 0 : order.durationHours,
      search: order.search,
    }
  })

  let isolationCells = 0
  let isolationOccupied = 0
  for (const room of world.rooms.all()) {
    if (room.defId !== 'isolation') continue
    isolationCells += 1
    isolationOccupied += world.contents().occupants(room.id)
  }

  let suppressionSum = 0
  let inmateCount = 0
  for (const inmate of world.inmates.all()) {
    suppressionSum += inmate.inmate.suppression
    inmateCount += 1
  }
  const meanSuppression = inmateCount > 0 ? Math.round(suppressionSum / inmateCount) : 0

  return {
    rows,
    strictness: orders.reassignmentStrictness,
    mealQuantity: orders.mealQuantity,
    mealVariety: orders.mealVariety,
    maxMealVariety: data.balance.kitchen.maxMealVariety,
    projection: {
      meanSuppressionFrom: meanSuppression,
      meanSuppressionTo: meanSuppression,
      misconductPerDayFrom: 0,
      misconductPerDayTo: 0,
      programmeParticipationFrom: 0,
      programmeParticipationTo: 0,
      reoffendFrom: 0,
      reoffendTo: 0,
      isolationCells,
      isolationOccupied,
      isolationProjectedPeak: isolationOccupied,
    },
  }
}

function labelShortfall(
  reason: 'no-staff-hired' | 'all-staff-busy' | 'unreachable' | null,
): UnfilledReasonLabel | null {
  return unfilledReasonLabel(reason)
}

function countOfficers(world: InmateWorld, data: GameData): number {
  let count = 0
  for (const staff of world.staff.all()) {
    const def = data.staff.find(staff.staff.defId)
    if (def === undefined) continue
    if (def.id === 'officer' || def.capabilities.includes('patrol')) count += 1
  }
  return count
}

function postDetail(
  staffRole: string,
  windows: readonly { readonly startHour: number; readonly endHour: number }[],
): string {
  const role = staffRole.replace(/_/g, ' ')
  if (windows.length === 0) return `${role} · Continuous`
  const ranges = windows.map((w) => `${padHour(w.startHour)} to ${padHour(w.endHour)}`).join(', ')
  return `${role} · ${ranges}`
}

function padHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function peakRequirement(
  world: InmateWorld,
  _currentHour: number,
): { readonly required: number; readonly window: string | null } {
  let peakRequired = 0
  let peakHour = 0
  for (let hour = 0; hour < 24; hour += 1) {
    let required = 0
    for (const post of world.posts.posts()) {
      if (activeAtHour(post.timeWindows, hour)) required += post.count
    }
    for (const route of world.posts.routes()) {
      if (activeAtHour(route.timeWindows, hour)) required += route.count
    }
    if (required > peakRequired) {
      peakRequired = required
      peakHour = hour
    }
  }
  if (peakRequired === 0) return { required: 0, window: null }
  return {
    required: peakRequired,
    window: `${padHour(peakHour)} to ${padHour((peakHour + 1) % 24)}`,
  }
}

function activeAtHour(
  windows: readonly { readonly startHour: number; readonly endHour: number }[],
  hour: number,
): boolean {
  if (windows.length === 0) return true
  for (const range of windows) {
    const { startHour, endHour } = range
    if (startHour === endHour) return true
    if (startHour < endHour) {
      if (hour >= startHour && hour < endHour) return true
    } else if (hour >= startHour || hour < endHour) {
      return true
    }
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* T8.9 — Routine / Contracts / Intake / Flow                                  */
/* -------------------------------------------------------------------------- */

const ROUTINE_BLOCK_IDS = new Set<string>([
  'lockup',
  'sleep',
  'meal',
  'yard',
  'wash',
  'free',
  'work_free',
  'work_lockup',
])

function asRoutineBlock(id: string): RoutineBlockId {
  return (ROUTINE_BLOCK_IDS.has(id) ? id : 'free') as RoutineBlockId
}

function buildRoutineModel(world: InmateWorld, data: GameData): RoutineModel {
  return {
    categories: data.securityCategories.all.map((cat) => {
      const schedule = world.routines.scheduleFor(cat.id) ?? data.balance.routine.defaults[cat.id]
      const blocks = (schedule ?? Array(24).fill('free')).map((block) => asRoutineBlock(block))
      return { id: cat.id, name: cat.name, blocks }
    }),
    conflicts: [],
  }
}

function buildContractsModel(world: InmateWorld, data: GameData): ContractsModel {
  const activeIds = new Set(world.contracts.active.map((row) => row.defId))
  const active: ContractRowModel[] = []
  for (const record of world.contracts.active) {
    const def = data.contracts.find(record.defId)
    if (def === undefined) continue
    active.push(contractRow(def, record.itemPassed, true, false, null))
  }

  const available: ContractRowModel[] = []
  for (const def of data.contracts.all) {
    if (activeIds.has(def.id) || world.contracts.isFinished(def.id)) continue
    const open = isContractAvailable(def, world)
    const locked = !open
    const lockReason = locked
      ? def.hidden && !world.contracts.wasRevealed(def.id)
        ? 'Not yet revealed'
        : 'Prerequisites unmet'
      : null
    if (def.hidden && !world.contracts.wasRevealed(def.id) && locked) continue
    available.push(contractRow(def, def.todoItems.map(() => false), false, locked, lockReason))
  }

  const loanBalance = data.balance.economy.loan
  const principal = world.economy.loanPrincipal
  const creditUnlocked = hasFeature(data, world.directorate, 'credit_line')
  return {
    active,
    available,
    maxActive: maxConcurrentContracts(world),
    loan: {
      principal,
      maxPrincipal: loanBalance.maxCap,
      interestRate: loanBalance.hourlyInterestRate,
      creditRating: Math.max(0, 100 - Math.round((principal / Math.max(1, loanBalance.maxCap)) * 40)),
      available: creditUnlocked && principal < loanBalance.maxCap,
      availableReason: creditUnlocked
        ? principal >= loanBalance.maxCap
          ? 'Credit line is fully drawn'
          : null
        : 'Research Credit Line in the Directorate',
    },
  }
}

function contractRow(
  def: { readonly id: string; readonly name: string; readonly description: string; readonly advance: number; readonly completion: number; readonly todoItems: readonly { readonly label: string; readonly predicate: { readonly type: string } }[] },
  itemPassed: readonly boolean[],
  active: boolean,
  locked: boolean,
  lockReason: string | null,
): ContractRowModel {
  const doneCount = itemPassed.filter(Boolean).length
  const total = def.todoItems.length
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    advance: def.advance,
    completion: def.completion,
    todos: def.todoItems.map((item, index) => ({
      id: item.predicate.type,
      label: item.label,
      done: itemPassed[index] === true,
      current: itemPassed[index] === true ? 'done' : 'pending',
      required: '1',
    })),
    progress: total === 0 ? 0 : Math.round((doneCount / total) * 100),
    active,
    locked,
    lockReason,
  }
}

function buildIntakeModel(world: InmateWorld, data: GameData, tick: number): IntakeModel {
  let cells = 0
  let dormitories = 0
  let holdingPens = 0
  for (const room of world.rooms.all()) {
    const status = world.rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue
    if (room.defId === 'cell') cells += 1
    else if (room.defId === 'dormitory') dormitories += 1
    else if (room.defId === 'holding_pen') holdingPens += 1
  }

  const population = [...world.inmates.all()].length
  const capacity = housingCapacity(world.rooms, world.objects)
  const nextBusTick = world.intake.nextBusAtTick

  return {
    continuous: world.intake.continuous,
    categories: data.securityCategories.all.map((cat) => {
      const unlocked = isUnlocked(data, world.directorate, 'securityCategories', cat.id)
      const node = gatingNode(data, 'securityCategories', cat.id)
      return {
        id: cat.id,
        name: cat.name,
        requested: world.intake.requestedCounts.get(cat.id) ?? 0,
        locked: !unlocked,
        lockReason: unlocked ? null : node === undefined ? 'Locked' : `Requires ${node}`,
      }
    }),
    capacityModel: {
      population,
      capacity,
      housing: { cells, dormitories, holdingPens },
    },
    nextBusLabel: nextBusTick <= tick ? 'Bus arriving' : relativeTickLabel(nextBusTick, tick),
    nextBusTick,
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

function sumMap(values: ReadonlyMap<number, number> | ReadonlyMap<string, number>): number {
  let total = 0
  for (const value of values.values()) total += value
  return total
}

function stage(
  id: string,
  name: string,
  throughput: number,
  capacity: number,
  detail: string,
): FlowStageModel {
  const bottleneck = capacity > 0 && throughput < capacity
  return { id, name, throughput, capacity, bottleneck, detail }
}

function chainFrom(
  id: FlowChainModel['id'],
  name: string,
  stages: readonly FlowStageModel[],
  healthySummary: string,
  blockedSummary: string,
): FlowChainModel {
  const bottleneck = stages.some((entry) => entry.bottleneck)
  return {
    id,
    name,
    stages,
    healthy: !bottleneck,
    summary: bottleneck ? blockedSummary : healthySummary,
  }
}

function buildFlowModel(world: InmateWorld, data: GameData): FlowModel {
  const meals = world.meals
  const fridge = sumFridge(meals)
  const counters = sumMap(meals.counterMeals)
  const served = meals.mealsServed
  const missed = meals.missedMeals
  const mealNeed = served + missed
  const mealStages = [
    stage('delivery', 'Delivery', fridge, Math.max(fridge, mealNeed), fridge > 0 ? `${fridge} ingredients` : 'No ingredients in fridges'),
    stage('storage', 'Storage', fridge, Math.max(fridge, 1), `${fridge} stored`),
    stage('kitchen', 'Kitchen', served, Math.max(mealNeed, 1), missed > 0 ? `${missed} missed` : `${served} cooked`),
    stage('serving', 'Serving', served, Math.max(mealNeed, counters, 1), `${counters} on counters`),
  ]

  const dirty = sumMap(world.laundry.bedDirty) + sumMap(world.laundry.basketDirty) + sumMap(world.laundry.pendingWash)
  const washed = sumMap(world.laundry.washedReady)
  const ironed = sumMap(world.laundry.ironedReady)
  const distributed = world.laundry.uniformsDistributed
  const laundryStages = [
    stage('collect', 'Collect', dirty, Math.max(dirty, 1), `${dirty} dirty uniforms`),
    stage('wash', 'Wash', washed, Math.max(dirty + washed, 1), `${washed} washed`),
    stage('iron', 'Iron', ironed, Math.max(washed + ironed, 1), `${ironed} ironed`),
    stage('distribute', 'Distribute', distributed, Math.max(distributed, dirty, 1), `${distributed} issued`),
  ]

  let dirtTotal = 0
  const dirt = world.grid.dirt
  for (let i = 0; i < dirt.length; i += 1) dirtTotal += dirt[i] ?? 0
  const dirtMax = data.balance.logistics.dirt.max
  const meanDirt = dirt.length === 0 ? 0 : Math.round(dirtTotal / dirt.length)
  const cleaningStages = [
    stage('dirt', 'Dirt', meanDirt, dirtMax, `Mean dirt ${meanDirt}`),
    stage('clean', 'Cleaning', Math.max(0, dirtMax - meanDirt), dirtMax, meanDirt > dirtMax / 2 ? 'Falling behind' : 'Keeping up'),
  ]

  const store = sumMap(world.supply.storeStock)
  const supplyStages = [
    stage('dock', 'Dock', store, Math.max(store, 1), store > 0 ? `${store} in stores` : 'Stores empty'),
    stage('store', 'Stores', store, Math.max(store, 1), `${store} units`),
    stage('site', 'Sites', store, Math.max(store, 1), 'Construction supply'),
  ]

  const goods = sumMap(world.labour.finishedGoods)
  const exportIncome = world.labour.lifetimeExportIncome
  const exportStages = [
    stage('workshop', 'Workshop', goods, Math.max(goods, 1), `${goods} finished goods`),
    stage('dispatch', 'Dispatch', exportIncome, Math.max(exportIncome, 1), `$${exportIncome} exported`),
  ]

  return {
    chains: [
      chainFrom('meals', 'Meals', mealStages, 'Meal chain is keeping up', 'Kitchen or serving is the bottleneck'),
      chainFrom('laundry', 'Laundry', laundryStages, 'Uniforms are cycling', 'Laundry is backing up'),
      chainFrom('cleaning', 'Cleaning', cleaningStages, 'Floors are under control', 'Dirt is accumulating'),
      chainFrom('supply', 'Supply', supplyStages, 'Materials are moving', 'Stores are empty'),
      chainFrom('exports', 'Exports', exportStages, 'Workshops are shipping', 'Nothing is ready to export'),
    ],
  }
}

function sumFridge(meals: InmateWorld['meals']): number {
  let total = 0
  for (const stock of meals.fridgeStock.values()) {
    for (const units of stock.values()) total += units
  }
  return total
}

