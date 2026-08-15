/**
 * World fixtures for named scenarios (T8.18). Prefer mutating `ctx.game.world`
 * over waiting in-game days.
 */

import {
  createInmateShell,
  designateRoom,
  generateInmate,
  hireStaff,
  initialLockState,
  placeObject,
  refreshPassability,
  Rng,
  NO_ROOM,
  NO_STAFF,
  type EventSink,
  type GameData,
  type InmateWorld,
  type ObjectDeps,
  type Rect,
  type RoomDeps,
  type StaffEntity,
} from '@blockwork/sim'

export function fillOwned(world: InmateWorld): void {
  world.grid.fill('owned', 1)
}

export function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

export function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

export function putDoor(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

export function putRoomShell(world: InmateWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) putWall(world, x, y)
      else putFloor(world, x, y)
    }
  }
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1)
}

export function interiorOf(rect: Rect): Rect {
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
}

export function roomDeps(world: InmateWorld, events: EventSink, tick = 0): RoomDeps {
  return { world, data: world.data, events, tick }
}

export function objectDeps(world: InmateWorld, events: EventSink, tick = 0): ObjectDeps {
  return { world, data: world.data, events, tick }
}

export function spawnInmate(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
  seed: number,
  category = 'medium',
): number {
  const component = generateInmate({
    data,
    rng: new Rng(seed >>> 0).stream('intake'),
    category,
  })
  const id = world.inmates.allocateId()
  world.inmates.add(
    createInmateShell({
      id,
      data,
      inmate: component,
      tx,
      ty,
    }),
  )
  return id
}

/** Dogs need a kennel to hire; scenarios place the entity directly. */
export function placeDog(world: InmateWorld, tx: number, ty: number): StaffEntity {
  const id = world.staff.allocateId()
  if (id === NO_STAFF) throw new Error('staff id exhausted')
  const units = world.data.balance.map.tileWorldUnits
  const entity: StaffEntity = {
    id,
    kind: 'staff',
    x: (tx + 0.5) * units,
    y: (ty + 0.5) * units,
    tx,
    ty,
    staff: {
      defId: world.data.balance.tunnels.dogStaffRoleId,
      name: `Patrol Dog ${String(id)}`,
      officeRoomId: NO_ROOM,
      assignedAreaId: 0,
      pinnedTile: -1,
      duty: { kind: 'idle' },
      wanderCooldown: 0,
      needs: new Float32Array(world.data.needs.size),
      breakPending: false,
      breakCooldownMinutes: 0,
    },
  }
  world.staff.add(entity)
  return entity
}

/** Kitchen + mess with a single cooker — undersized for a large population. */
export function buildUndersizedKitchen(
  world: InmateWorld,
  events: EventSink,
  data: GameData,
): { kitchenId: number; messId: number } {
  const kitchenShell = { x: 2, y: 2, width: 10, height: 8 }
  const messShell = { x: 14, y: 2, width: 10, height: 8 }
  putRoomShell(world, kitchenShell)
  putRoomShell(world, messShell)
  designateRoom(roomDeps(world, events), interiorOf(kitchenShell), 'kitchen')
  designateRoom(roomDeps(world, events), interiorOf(messShell), 'mess_hall')

  const kitchen = [...world.rooms.all()].find((room) => room.defId === 'kitchen')
  const mess = [...world.rooms.all()].find((room) => room.defId === 'mess_hall')
  if (kitchen === undefined || mess === undefined) throw new Error('kitchen/mess missing')

  const ki = interiorOf(kitchenShell)
  const mi = interiorOf(messShell)
  const cooker = placeObject(objectDeps(world, events), { x: ki.x, y: ki.y + 1 }, 'cooker', 0)
  const fridge = placeObject(objectDeps(world, events), { x: ki.x, y: ki.y + 3 }, 'fridge', 0)
  const counter = placeObject(objectDeps(world, events), { x: mi.x, y: mi.y + 1 }, 'serving_counter', 0)
  if (cooker === undefined || fridge === undefined || counter === undefined) {
    throw new Error('kitchen objects failed to place')
  }
  hireStaff({ world, defId: 'cook', events, tick: 0, tx: ki.x + 2, ty: ki.y + 2 })

  const types = data.balance.kitchen.ingredientTypes
  for (const type of types) {
    world.meals.stockFridge(fridge.id, type, 50_000)
  }
  return { kitchenId: kitchen.id, messId: mess.id }
}
