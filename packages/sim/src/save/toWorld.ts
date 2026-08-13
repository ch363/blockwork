/**
 * Restore Phase 4 (+ economy / contracts / routines) snapshots into a live
 * `InmateWorld` after the grid has been deserialised.
 *
 * Derived pathfinding state is rebuilt at the end — never trusted from the
 * file (PRD 7.4).
 */

import type { JsonObject, JsonValue } from '../core/commands'
import type { GameData } from '../data/loader'
import type { LedgerCategory } from '../entities/economy'
import { LEDGER_CATEGORIES } from '../entities/economy'
import type { PunishmentKind, ReassignmentStrictness, StatusEffectId } from '../data/schemas'
import { MISCONDUCT_KINDS, ROOM_PROPERTIES } from '../data/schemas'
import type { MealPolicyQuantity } from '../entities/standingOrders'
import { createDefaultStandingOrders, setMisconductOrder } from '../entities/standingOrders'
import { createInmateShell } from '../entities/inmate'
import type { InmateComponent } from '../entities/inmate'
import type { StaffDuty, StaffEntity } from '../entities/staff'
import type { ObjectEntity } from '../entities/objects'
import { isRotation } from '../entities/objects'
import { isSectorAccessMode } from '../world/sectors'
import { refreshPassabilityRect } from '../world/construction'
import type { RoomPropertySet } from '../world/rooms'
import type { InmateWorld } from '../systems/intakeSystem'

import { parseUnfilledReason } from './fromWorld'
import type { SaveState } from './state'

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
  // Advance nextId past every restored room without a public setter.
  while (world.rooms.nextId < state.nextRoomId) {
    world.rooms.allocateId()
  }
}

function restoreMinimalInmates(world: InmateWorld, state: SaveState, data: GameData): void {
  for (const entity of world.inmates.all()) {
    world.inmates.remove(entity.id)
  }
  let maxId = 0
  for (const entry of state.entities) {
    if (entry.kind !== 'inmate') continue
    maxId = Math.max(maxId, entry.id)
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

    const inmate: InmateComponent = {
      name: stringField(entry, 'name', `Inmate ${entry.id}`),
      portraitSeed: numberField(entry, 'portraitSeed', entry.id),
      category: stringField(entry, 'category', 'medium'),
      convictions: [],
      sentenceHours: numberField(entry, 'sentenceHours'),
      servedHours: numberField(entry, 'servedHours'),
      traits: Array.isArray(entry['traits'])
        ? entry['traits'].filter((t): t is string => typeof t === 'string')
        : [],
      reputations: [],
      needs,
      addictions: [],
      suppression: numberField(entry, 'suppression'),
      entitlement: numberField(entry, 'entitlement'),
      cellId: numberField(entry, 'cellId'),
      jobId: null,
      programEnrolment: null,
      misconductLog: [],
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
  while (world.inmates.nextId <= maxId) {
    world.inmates.allocateId()
  }
}

function restoreMinimalStaff(world: InmateWorld, state: SaveState, data: GameData): void {
  for (const entity of world.staff.all()) {
    world.staff.remove(entity.id)
  }
  let maxId = 0
  for (const entry of state.entities) {
    if (entry.kind !== 'staff') continue
    maxId = Math.max(maxId, entry.id)
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
  while (world.staff.nextId <= maxId) {
    world.staff.allocateId()
  }
}

function restoreMinimalObjects(world: InmateWorld, state: SaveState): void {
  for (const entity of world.objects.all()) {
    world.objects.remove(entity.id)
  }
  let maxId = 0
  for (const entry of state.entities) {
    if (entry.kind !== 'object') continue
    maxId = Math.max(maxId, entry.id)
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
  while (world.objects.nextId <= maxId) {
    world.objects.allocateId()
  }
}

/**
 * Applies a `SaveState` onto an `InmateWorld` whose grid already matches the
 * save. Rebuilds sector indexes and pathfinding afterwards.
 */
export function restoreInmateWorld(world: InmateWorld, state: SaveState, data: GameData): void {
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

  // Research first: everything below is restored through registries rather
  // than through the gated command paths, but a system that ticks immediately
  // after the load must see the unlocks the player actually owns.
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
  world.emergency.restore(state.emergency)
  world.escapes.restore(state.escapes)
  world.combat.restore(state.combat)
  world.punishments.restore(state.punishments)

  world.power.hasCable.fill(0)
  for (const tile of state.utilities.cableTiles) {
    if (tile >= 0 && tile < world.power.hasCable.length) world.power.hasCable[tile] = 1
  }
  world.water.hasPipe.fill(0)
  for (const tile of state.utilities.pipeTiles) {
    if (tile >= 0 && tile < world.water.hasPipe.length) world.water.hasPipe[tile] = 1
  }

  world.misconductWindow.restore(state.misconductWindowTicks)
  world.dangerLevel = state.dangerLevel
  world.riotActive = state.riotActive
  world.lockdownActive = state.lockdownActive

  restoreRooms(world, state)
  restoreMinimalInmates(world, state, data)
  restoreMinimalStaff(world, state, data)
  restoreMinimalObjects(world, state)

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
