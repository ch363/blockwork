/**
 * Restore a captured `SaveState` into a live `InmateWorld` after the grid has
 * been deserialised (save v5).
 *
 * Derived pathfinding state is rebuilt at the end — never trusted from the
 * file (PRD 7.4).
 */

import type { JsonObject, JsonValue } from '../core/commands'
import type { GameData } from '../data/loader'
import type { LedgerCategory } from '../entities/economy'
import { LEDGER_CATEGORIES } from '../entities/economy'
import type { PunishmentKind, ReassignmentStrictness, StatusEffectId, MisconductKind } from '../data/schemas'
import { MISCONDUCT_KINDS, PUNISHMENT_KINDS, ROOM_PROPERTIES } from '../data/schemas'
import type { MealPolicyQuantity } from '../entities/standingOrders'
import { createDefaultStandingOrders, setMisconductOrder } from '../entities/standingOrders'
import { createInmateShell } from '../entities/inmate'
import type {
  AddictionSubstance,
  InmateAddiction,
  InmateComponent,
  InmateConviction,
  InmateReputation,
} from '../entities/inmate'
import { ADDICTION_SUBSTANCES } from '../entities/inmate'
import type { MisconductRecord } from '../entities/misconduct'
import type { StaffDuty, StaffEntity } from '../entities/staff'
import type { ObjectEntity } from '../entities/objects'
import { isRotation } from '../entities/objects'
import { isSectorAccessMode } from '../world/sectors'
import { refreshPassabilityRect } from '../world/construction'
import type { RoomPropertySet } from '../world/rooms'
import type { InmateWorld } from '../systems/intakeSystem'
import type { LabourSnapshot } from '../systems/labourSystem'
import type { MoraleSnapshot, StrikePhase } from '../entities/morale'
import type { JobPoolSnapshot } from '../entities/job'
import type { NeedsRuntimeSnapshot } from '../entities/needs'
import type { RoutineRuntimeSnapshot } from '../world/routine'
import type { MealLogisticsSnapshot } from '../systems/logistics/mealChain'
import type { SupplyLogisticsSnapshot } from '../systems/logistics/supply'
import type { DeliveryScheduleSnapshot } from '../systems/logistics/deliveries'
import type { EscortQueueSnapshot } from '../entities/staff'
import type { ConstructionQueueSnapshot } from '../world/construction'

import { parseUnfilledReason } from './fromWorld'
import type { EmergencyStateSnapshot } from './format'
import type { SaveState } from './state'

type LegacyEmergencySnapshot = EmergencyStateSnapshot & {
  readonly staffHealth?: readonly { readonly id: number; readonly hp: number }[]
}

/**
 * Pre-T8.14 saves stored callable-staff HP on `emergency.staffHealth`. Merge any
 * entries that are not already on `combat.staffHealth` before restore.
 */
export function consolidateLegacyStaffHealth(state: SaveState): SaveState {
  const emergency = state.emergency as LegacyEmergencySnapshot
  const legacy = emergency.staffHealth
  if (legacy === undefined || legacy.length === 0) {
    return state
  }

  const combatHealth = new Map(state.combat.staffHealth.map((entry) => [entry.key, entry.hp]))
  for (const entry of legacy) {
    const key = `staff:${entry.id}`
    if (!combatHealth.has(key)) {
      combatHealth.set(key, entry.hp)
    }
  }

  const { staffHealth: _legacy, ...emergencyWithoutLegacy } = emergency
  return {
    ...state,
    emergency: emergencyWithoutLegacy,
    combat: {
      ...state.combat,
      staffHealth: [...combatHealth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, hp]) => ({ key, hp })),
    },
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberField(object: JsonObject, key: string, fallback = 0): number {
  const value = object[key]
  return typeof value === 'number' ? value : fallback
}

function stringField(object: JsonObject, key: string, fallback: string): string {
  const value = object[key]
  return typeof value === 'string' ? value : fallback
}

function isLedgerCategory(value: string): value is LedgerCategory {
  return (LEDGER_CATEGORIES as readonly string[]).includes(value)
}

function parseConvictions(value: JsonValue | undefined): InmateConviction[] {
  if (!Array.isArray(value)) return []
  const out: InmateConviction[] = []
  for (const entry of value) {
    if (!isJsonObject(entry) || typeof entry['id'] !== 'string') continue
    out.push({
      id: entry['id'],
      years: typeof entry['years'] === 'number' ? entry['years'] : 0,
    })
  }
  return out
}

function parseReputations(value: JsonValue | undefined): InmateReputation[] {
  if (!Array.isArray(value)) return []
  const out: InmateReputation[] = []
  for (const entry of value) {
    if (!isJsonObject(entry) || typeof entry['id'] !== 'string') continue
    out.push({
      id: entry['id'],
      revealed: entry['revealed'] === true,
    })
  }
  return out
}

function isAddictionSubstance(value: string): value is AddictionSubstance {
  return (ADDICTION_SUBSTANCES as readonly string[]).includes(value)
}

function parseAddictions(value: JsonValue | undefined): InmateAddiction[] {
  if (!Array.isArray(value)) return []
  const out: InmateAddiction[] = []
  for (const entry of value) {
    if (!isJsonObject(entry)) continue
    const substance = entry['substance']
    if (typeof substance !== 'string' || !isAddictionSubstance(substance)) continue
    out.push({
      substance,
      strength: typeof entry['strength'] === 'number' ? entry['strength'] : 0,
    })
  }
  return out
}

function isMisconductKind(value: string): value is MisconductKind {
  return (MISCONDUCT_KINDS as readonly string[]).includes(value)
}

function isPunishmentKind(value: string): value is PunishmentKind {
  return (PUNISHMENT_KINDS as readonly string[]).includes(value)
}

function parseMisconductLog(value: JsonValue | undefined): MisconductRecord[] {
  if (!Array.isArray(value)) return []
  const out: MisconductRecord[] = []
  for (const entry of value) {
    if (!isJsonObject(entry)) continue
    const kind = typeof entry['kind'] === 'string' ? entry['kind'] : ''
    const punishment = typeof entry['punishment'] === 'string' ? entry['punishment'] : ''
    if (!isMisconductKind(kind) || !isPunishmentKind(punishment)) continue
    out.push({
      tick: typeof entry['tick'] === 'number' ? entry['tick'] : 0,
      kind,
      punishment,
      durationHours: typeof entry['durationHours'] === 'number' ? entry['durationHours'] : 0,
    })
  }
  return out
}

function restoreStandingOrders(world: InmateWorld, state: SaveState): void {
  const defaults = createDefaultStandingOrders(world.data)
  const saved = state.standingOrders
  world.standingOrders.reassignmentStrictness =
    (saved.reassignmentStrictness as ReassignmentStrictness) || defaults.reassignmentStrictness
  world.standingOrders.mealQuantity =
    (saved.mealQuantity as MealPolicyQuantity) || defaults.mealQuantity
  world.standingOrders.mealVariety =
    typeof saved.mealVariety === 'number' ? saved.mealVariety : defaults.mealVariety

  for (const kind of MISCONDUCT_KINDS) {
    const entry = saved.misconduct[kind]
    const fallback = defaults.misconduct[kind]
    if (entry === undefined) {
      setMisconductOrder(world.standingOrders, kind, fallback)
      continue
    }
    setMisconductOrder(world.standingOrders, kind, {
      punishment: (entry.punishment as PunishmentKind) || fallback.punishment,
      durationHours:
        typeof entry.durationHours === 'number' ? entry.durationHours : fallback.durationHours,
      search: typeof entry.search === 'boolean' ? entry.search : fallback.search,
    })
  }
}

function restoreRoutines(world: InmateWorld, state: SaveState): void {
  for (const [categoryId, blocks] of Object.entries(state.routines)) {
    if (!Array.isArray(blocks) || blocks.length !== 24) continue
    world.routines.setCategory(categoryId, blocks)
  }
}

function restoreRooms(world: InmateWorld, state: SaveState): void {
  for (const room of world.rooms.all()) {
    world.rooms.remove(room.id)
  }
  for (const entry of state.rooms) {
    const properties = {} as Record<string, boolean>
    for (const property of ROOM_PROPERTIES) {
      properties[property] = Boolean(entry.properties[property])
    }
    world.rooms.set({
      id: entry.id,
      defId: entry.defId,
      tiles: [...entry.tiles],
      bounds: { ...entry.bounds },
      properties: properties as RoomPropertySet,
    })
  }
  while (world.rooms.nextId < state.nextRoomId) {
    world.rooms.allocateId()
  }
}

function restoreInmates(world: InmateWorld, state: SaveState, data: GameData): void {
  for (const entity of world.inmates.all()) {
    world.inmates.remove(entity.id)
  }
  for (const entry of state.entities) {
    if (entry.kind !== 'inmate') continue
    const needsLength = data.needs.size
    const needs = new Float32Array(needsLength)
    const rawNeeds = entry['needs']
    if (Array.isArray(rawNeeds)) {
      for (let i = 0; i < needsLength && i < rawNeeds.length; i += 1) {
        const value = rawNeeds[i]
        needs[i] = typeof value === 'number' ? value : 0
      }
    }
    const gradesRaw = entry['grades']
    const grades = isJsonObject(gradesRaw)
      ? {
          punishment: numberField(gradesRaw, 'punishment'),
          reform: numberField(gradesRaw, 'reform'),
          security: numberField(gradesRaw, 'security'),
          health: numberField(gradesRaw, 'health'),
        }
      : { punishment: 0, reform: 0, security: 0, health: 0 }

    const jobRaw = entry['jobId']
    const inmate: InmateComponent = {
      name: stringField(entry, 'name', `Inmate ${entry.id}`),
      portraitSeed: numberField(entry, 'portraitSeed', entry.id),
      category: stringField(entry, 'category', 'medium'),
      convictions: parseConvictions(entry['convictions']),
      sentenceHours: numberField(entry, 'sentenceHours'),
      servedHours: numberField(entry, 'servedHours'),
      traits: Array.isArray(entry['traits'])
        ? entry['traits'].filter((t): t is string => typeof t === 'string')
        : [],
      reputations: parseReputations(entry['reputations']),
      needs,
      addictions: parseAddictions(entry['addictions']),
      suppression: numberField(entry, 'suppression'),
      entitlement: numberField(entry, 'entitlement'),
      cellId: numberField(entry, 'cellId'),
      jobId: typeof jobRaw === 'string' ? jobRaw : null,
      misconductLog: parseMisconductLog(entry['misconductLog']),
      grades,
      reoffendChance: numberField(entry, 'reoffendChance'),
      status: Array.isArray(entry['status'])
        ? (entry['status'].filter((t): t is string => typeof t === 'string') as StatusEffectId[])
        : [],
      health: numberField(entry, 'health', 100),
      inventory: Array.isArray(entry['inventory'])
        ? entry['inventory'].filter((t): t is string => typeof t === 'string')
        : [],
      money: numberField(entry, 'money'),
      aptitude: numberField(entry, 'aptitude', 1),
    }

    const tx = numberField(entry, 'tx')
    const ty = numberField(entry, 'ty')
    const shell = createInmateShell({ id: entry.id, data, inmate, tx, ty })
    if (typeof entry['x'] === 'number') shell.x = entry['x']
    if (typeof entry['y'] === 'number') shell.y = entry['y']
    if (typeof entry['accessMask'] === 'number') shell.accessMask = entry['accessMask']
    world.inmates.add(shell)
  }
  while (world.inmates.nextId < state.entityRegistry.nextInmateId) {
    world.inmates.allocateId()
  }
}

function restoreStaff(world: InmateWorld, state: SaveState, data: GameData): void {
  for (const entity of world.staff.all()) {
    world.staff.remove(entity.id)
  }
  for (const entry of state.entities) {
    if (entry.kind !== 'staff') continue
    const needs = new Float32Array(data.needs.size)
    const rawNeeds = entry['needs']
    if (Array.isArray(rawNeeds)) {
      for (let i = 0; i < needs.length && i < rawNeeds.length; i += 1) {
        const value = rawNeeds[i]
        needs[i] = typeof value === 'number' ? value : 0
      }
    }
    const dutyRaw = entry['duty']
    const duty: StaffDuty =
      isJsonObject(dutyRaw) && typeof dutyRaw['kind'] === 'string'
        ? (dutyRaw as unknown as StaffDuty)
        : { kind: 'idle' }

    const staff: StaffEntity = {
      id: entry.id,
      kind: 'staff',
      x: numberField(entry, 'x'),
      y: numberField(entry, 'y'),
      tx: numberField(entry, 'tx'),
      ty: numberField(entry, 'ty'),
      staff: {
        defId: stringField(entry, 'defId', 'officer'),
        name: stringField(entry, 'name', `Staff ${entry.id}`),
        officeRoomId: numberField(entry, 'officeRoomId'),
        assignedAreaId: numberField(entry, 'assignedAreaId'),
        pinnedTile: numberField(entry, 'pinnedTile', -1),
        duty,
        wanderCooldown: numberField(entry, 'wanderCooldown'),
        needs,
        breakPending: entry['breakPending'] === true,
        breakCooldownMinutes: numberField(entry, 'breakCooldownMinutes'),
      },
    }
    world.staff.add(staff)
  }
  while (world.staff.nextId < state.entityRegistry.nextStaffId) {
    world.staff.allocateId()
  }
  world.staff.restoreHireCounts(state.entityRegistry.staffHireCounts)
}

function restoreObjects(world: InmateWorld, state: SaveState): void {
  for (const entity of world.objects.all()) {
    world.objects.remove(entity.id)
  }
  for (const entry of state.entities) {
    if (entry.kind !== 'object') continue
    const footprintRaw = entry['footprint']
    const footprint = isJsonObject(footprintRaw)
      ? {
          x: numberField(footprintRaw, 'x'),
          y: numberField(footprintRaw, 'y'),
          width: numberField(footprintRaw, 'width', 1),
          height: numberField(footprintRaw, 'height', 1),
        }
      : { x: 0, y: 0, width: 1, height: 1 }
    const tiles = Array.isArray(entry['tiles'])
      ? entry['tiles'].filter((t): t is number => typeof t === 'number')
      : []
    const rotationValue = entry['rotation']
    const object: ObjectEntity = {
      id: entry.id,
      kind: 'object',
      tileIndex: numberField(entry, 'tileIndex'),
      tx: numberField(entry, 'tx'),
      ty: numberField(entry, 'ty'),
      object: {
        defId: stringField(entry, 'defId', ''),
        rotation:
          typeof rotationValue === 'number' && isRotation(rotationValue) ? rotationValue : 0,
        footprint,
        tiles,
        roomId: numberField(entry, 'roomId'),
        hasPower: entry['hasPower'] !== false,
        hasWater: entry['hasWater'] !== false,
        hp: numberField(entry, 'hp', 1),
      },
    }
    world.objects.add(object)
  }
  while (world.objects.nextId < state.entityRegistry.nextObjectId) {
    world.objects.allocateId()
  }
}

function restoreFog(world: InmateWorld, state: SaveState): void {
  world.fog.revealed.fill(0)
  for (const tile of state.fog.revealedTiles) {
    if (tile >= 0 && tile < world.fog.revealed.length) world.fog.revealed[tile] = 1
  }
}

function restoreOffices(world: InmateWorld, state: SaveState): void {
  for (const claim of world.offices.all()) {
    world.offices.releaseRoom(claim.roomId)
  }
  for (const claim of state.offices.claims) {
    world.offices.claim(claim.roomId, claim.staffId, claim.displayName)
  }
}

function restoreLaundry(world: InmateWorld, state: SaveState): void {
  const laundry = world.laundry
  laundry.uniformsDistributed = state.laundry.uniformsDistributed
  laundry.lastAccrualDay = state.laundry.lastAccrualDay
  laundry.routingOverrides.clear()
  for (const route of state.laundry.routingOverrides) {
    laundry.routingOverrides.set(route.laundryId, route.housingId)
  }
  const restoreMap = (
    target: Map<number, number>,
    entries: readonly { readonly key: number; readonly value: number }[],
  ): void => {
    target.clear()
    for (const entry of entries) target.set(entry.key, entry.value)
  }
  restoreMap(laundry.uniformDirtiness, state.laundry.uniformDirtiness)
  restoreMap(laundry.bedDirty, state.laundry.bedDirty)
  restoreMap(laundry.basketDirty, state.laundry.basketDirty)
  restoreMap(laundry.pendingWash, state.laundry.pendingWash)
  restoreMap(laundry.washedReady, state.laundry.washedReady)
  restoreMap(laundry.ironedReady, state.laundry.ironedReady)
  restoreMap(laundry.bedClean, state.laundry.bedClean)
}

function restoreSettings(world: InmateWorld, state: SaveState): void {
  world.settings.staffNeeds = state.staffNeedsEnabled
  const settings = state.settings
  if (typeof settings['firstOrderGrace'] === 'boolean') {
    world.settings.firstOrderGrace = settings['firstOrderGrace']
  }
  if (typeof settings['randomEvents'] === 'boolean') {
    world.settings.randomEvents = settings['randomEvents']
  }
  if (typeof settings['staffNeeds'] === 'boolean') {
    world.settings.staffNeeds = settings['staffNeeds']
  }
}

function restoreIncomeAndSpend(world: InmateWorld, state: SaveState): void {
  world.takeIncome()
  if (state.incomeOwed > 0) world.addIncome(state.incomeOwed)

  world.takeSpend()
  if (state.construction.spendOwed > 0) world.addSpend(state.construction.spendOwed)

  world.takeRefunds()
  if (state.construction.refundsOwed > 0) world.addRefund(state.construction.refundsOwed)
}

function isStrikePhase(value: string): value is StrikePhase {
  return value === 'none' || value === 'active' || value === 'cooldown'
}

/**
 * Applies a `SaveState` onto an `InmateWorld` whose grid already matches the
 * save. Rebuilds sector indexes and pathfinding afterwards.
 */
export function restoreInmateWorld(world: InmateWorld, state: SaveState, data: GameData): void {
  const consolidated = consolidateLegacyStaffHealth(state)
  world.sectors.restore(data, {
    nextSectorId: state.sectors.nextSectorId,
    sectors: state.sectors.sectors.map((sector) => ({
      id: sector.id,
      name: sector.name,
      colour: sector.colour,
      access: isSectorAccessMode(sector.access)
        ? sector.access
        : data.balance.sectors.defaultAccess,
      categories: [...sector.categories],
    })),
  })

  world.posts.restore({
    nextPostId: state.posts.nextPostId,
    nextRouteId: state.posts.nextRouteId,
    posts: state.posts.posts.map((post) => ({
      id: post.id,
      name: post.name,
      sectorId: post.sectorId,
      objectId: post.objectId,
      staffRole: post.staffRole,
      count: post.count,
      timeWindows: post.timeWindows.map((w) => ({ ...w })),
      assigned: [...post.assigned],
      shortfallReason: parseUnfilledReason(post.shortfallReason),
      lastReportedTick: post.lastReportedTick,
    })),
    routes: state.posts.routes.map((route) => ({
      id: route.id,
      name: route.name,
      staffRole: route.staffRole,
      count: route.count,
      waypoints: [...route.waypoints],
      timeWindows: route.timeWindows.map((w) => ({ ...w })),
      assigned: [...route.assigned],
      shortfallReason: parseUnfilledReason(route.shortfallReason),
      lastReportedTick: route.lastReportedTick,
    })),
  })

  world.directorate.restore(state.directorate)
  world.grading.restore(state.grading)
  world.programs.restore(state.programs, data)
  world.grades.restore(state.grades)
  world.parole.restore(state.parole)
  world.release.restore(state.release)
  world.intelligence.restore(state.intelligence)
  world.averageCellGrade = state.grading.averageCellGrade

  restoreStandingOrders(world, state)
  restoreRoutines(world, state)

  world.economy.restore({
    balance: state.economy.balance,
    loanPrincipal: state.economy.loanPrincipal,
    insolvencyDeadlineTick: state.economy.insolvencyDeadlineTick,
    insolvencyStartedTick: state.economy.insolvencyStartedTick ?? null,
    entries: state.economy.entries.map((entry) => ({
      tick: entry.tick,
      category: isLedgerCategory(entry.category) ? entry.category : 'starting_funds',
      amount: entry.amount,
      reason: entry.reason,
      sourceEntityId: entry.sourceEntityId,
    })),
  })

  world.contracts.restore({
    active: state.contracts.active.map((c) => ({
      defId: c.defId,
      acceptedTick: c.acceptedTick,
      advancePaid: c.advancePaid,
      itemPassed: [...c.itemPassed],
    })),
    finished: state.contracts.finished.map((f) => ({
      defId: f.defId,
      lifecycle: f.lifecycle === 'cancelled' ? 'cancelled' : 'completed',
      settledTick: f.settledTick,
      advancePaid: f.advancePaid,
      cancellationDebit: f.cancellationDebit,
      completionCredit: f.completionCredit,
    })),
    revealed: [...state.contracts.revealed],
  })

  world.contraband.restore(state.contraband)
  world.fire.restore(state.fire)
  world.riot.restore(state.riot)
  world.emergency.restore(consolidated.emergency)
  world.escapes.restore(state.escapes)
  world.combat.restore(consolidated.combat)
  world.punishments.restore(state.punishments)

  world.power.hasCable.fill(0)
  for (const tile of state.utilities.cableTiles) {
    if (tile >= 0 && tile < world.power.hasCable.length) world.power.hasCable[tile] = 1
  }
  world.water.hasPipe.fill(0)
  for (const tile of state.utilities.pipeTiles) {
    if (tile >= 0 && tile < world.water.hasPipe.length) world.water.hasPipe[tile] = 1
  }
  world.power.shedBranches.clear()
  for (const branchId of state.utilities.shedBranches) {
    world.power.shedBranches.add(branchId)
  }
  world.water.useMultiplierByBranch.clear()
  for (const entry of state.utilities.waterMultipliers) {
    world.water.useMultiplierByBranch.set(entry.branchId, entry.multiplier)
  }

  world.misconductWindow.restore(state.misconductWindowTicks)
  world.dangerLevel = state.dangerLevel
  world.riotActive = state.riotActive
  world.lockdownActive = state.lockdownActive

  restoreRooms(world, state)
  restoreInmates(world, state, data)
  restoreStaff(world, state, data)
  restoreObjects(world, state)

  world.doors.restore(state.doors.doors)
  world.sites.restore({
    nextId: state.construction.nextSiteId,
    sites: state.construction.sites.map((site) => ({ ...site })),
  } satisfies ConstructionQueueSnapshot)

  world.intake.continuous = state.intake.continuous
  world.intake.nextBusAtTick = state.intake.nextBusAtTick
  world.intake.requestedCounts.clear()
  for (const entry of state.intake.requestedCounts) {
    world.intake.requestedCounts.set(entry.category, entry.count)
  }

  world.cellGrades.clear()
  for (const entry of state.cellGrades.grades) {
    world.cellGrades.set(entry.roomId, entry.grade)
  }

  world.staffOnlyRoomIds.clear()
  for (const roomId of state.staffOnlyRoomIds) world.staffOnlyRoomIds.add(roomId)

  world.intakeSearchedInmateIds.clear()
  for (const id of state.intakeSearchedInmateIds) world.intakeSearchedInmateIds.add(id)

  restoreSettings(world, state)
  restoreIncomeAndSpend(world, state)
  restoreFog(world, state)
  restoreOffices(world, state)

  world.escorts.restore(state.escorts as EscortQueueSnapshot)
  // Hash fingerprints path length, not tiles — restore a placeholder so length
  // matches until the next escort tick rebuilds a real path.
  for (const job of world.escorts.all()) {
    const saved = state.escorts.jobs.find((entry) => entry.id === job.id)
    if (saved === undefined || saved.pathLength <= 0) continue
    job.path = Array.from({ length: saved.pathLength }, () => 0)
    job.pathIndex = saved.pathIndex
  }

  world.jobs.restore(state.jobs as JobPoolSnapshot)
  world.labour.restore(state.labour as LabourSnapshot)
  const moraleStrike = state.morale.strike
  world.morale.restore({
    ...state.morale,
    strike: {
      phase: isStrikePhase(moraleStrike.phase) ? moraleStrike.phase : 'none',
      endsAtTick: moraleStrike.endsAtTick,
      cooldownUntilTick: moraleStrike.cooldownUntilTick,
      refuseCount: moraleStrike.refuseCount,
      payDemandOpen: moraleStrike.payDemandOpen,
      demandedRaise: moraleStrike.demandedRaise,
    },
  } satisfies MoraleSnapshot)
  world.needsRuntime.restore(state.needsRuntime as NeedsRuntimeSnapshot)
  world.routineRuntime.restore(state.routineRuntime as RoutineRuntimeSnapshot)
  world.meals.restore(state.meals as MealLogisticsSnapshot)
  world.supply.restore(state.supply as SupplyLogisticsSnapshot)
  world.deliveries.restore(state.deliveries as DeliveryScheduleSnapshot)

  world.cleaning.cleanRemainder = state.cleaning.cleanRemainder
  world.cleaning.noCleanersNotified = state.cleaning.noCleanersNotified
  world.cleaning.dirtRemoved = state.cleaning.dirtRemoved
  restoreLaundry(world, state)

  world.meals.standingOrders.quantity = world.standingOrders.mealQuantity
  world.meals.standingOrders.variety = world.standingOrders.mealVariety

  refreshPassabilityRect(world, data)
  world.sectors.reindex(data, world.grid)
  world.regions.rebuildAll(world.grid, world.doors, data, world.sectors)
  world.flowFields.refreshStandardGoals({
    grid: world.grid,
    objects: world.objects,
    rooms: world.rooms,
    materials: world.materials,
    data,
  })
  world.grid.markAllDirty()
}
