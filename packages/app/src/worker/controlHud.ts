/**
 * Live control-panel summaries for Posts, Emergency and Standing Orders.
 *
 * Built on the worker from authoritative `InmateWorld` state so the main
 * thread never walks registries. Shapes match `@blockwork/ui` panel models.
 */

import {
  MISCONDUCT_KINDS,
  NO_SECTOR,
  isUnlocked,
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
  const ranges = windows
    .map((w) => `${padHour(w.startHour)} to ${padHour(w.endHour)}`)
    .join(', ')
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
