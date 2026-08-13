/**
 * Opening layout for a brand-new prison (T8.4).
 *
 * A fresh map has no dock and no store, so with `stubMaterialDelivery: false`
 * the first foundation never receives materials. This module lays down what
 * the teardown describes as the starting plot: a delivery zone (dock), an
 * approach road, a starter maintenance crew, and seed stock that becomes
 * useful once the player designates a Store.
 *
 * First-order grace — materials auto-filling until a Store exists — lives on
 * `world.settings.firstOrderGrace` and is applied by `constructionSystem`.
 */

import type { EventSink } from '../core/simulation'
import type { GameData } from '../data/loader'
import { placeObject } from '../entities/objects'
import { hireStaff } from '../entities/staff'
import type { InmateWorld } from '../systems/intakeSystem'
import { refreshPassability } from './construction'
import { designateRoom } from './roomDetection'

const DOCK_ROOM = 'dock'
const DOCK_MARKER = 'dock_marker'
const MAINTENANCE = 'maintenance'
const STORE_ROOM = 'store'

/** True while first-order grace should still fill construction bills. */
export function firstOrderGraceActive(world: InmateWorld): boolean {
  if (!world.settings.firstOrderGrace) return false
  for (const room of world.rooms.all()) {
    if (room.defId === STORE_ROOM) return false
  }
  return true
}

/** Clears the grace flag once a Store exists (idempotent). */
export function syncFirstOrderGrace(world: InmateWorld): void {
  if (!world.settings.firstOrderGrace) return
  if (firstOrderGraceActive(world)) return
  world.settings.firstOrderGrace = false
}

/**
 * Places the south-edge delivery zone, approach road, starter crew and stock.
 *
 * Idempotent enough for tests: skips hire/stock when a dock already exists.
 */
export function applyOpeningLayout(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  options: { readonly firstOrderGrace: boolean },
): void {
  world.settings.firstOrderGrace = options.firstOrderGrace

  const opening = data.balance.opening
  const size = world.grid.size
  const margin = Math.min(opening.edgeMargin, Math.max(0, size - 4))
  const dockWidth = Math.min(opening.dockWidth, Math.max(1, size - margin * 2))
  const dockHeight = Math.min(opening.dockHeight, Math.max(3, size - margin - 1))
  const dockX = Math.max(0, Math.floor((size - dockWidth) / 2))
  const dockY = Math.max(0, size - margin - dockHeight)

  const alreadyHasDock = [...world.rooms.all()].some((room) => room.defId === DOCK_ROOM)
  if (!alreadyHasDock) {
    const dockRect = { x: dockX, y: dockY, width: dockWidth, height: dockHeight }
    for (let y = dockRect.y; y < dockRect.y + dockRect.height; y += 1) {
      for (let x = dockRect.x; x < dockRect.x + dockRect.width; x += 1) {
        const index = world.grid.idx(x, y)
        world.grid.setAt('outdoors', index, 1)
        refreshPassability(world, data, index)
        world.structureChanged(index)
      }
    }
    designateRoom({ world, data, events, tick: 0 }, dockRect, DOCK_ROOM)
    placeObject(
      { world, data, events, tick: 0 },
      { x: dockRect.x, y: dockRect.y },
      DOCK_MARKER,
      0,
    )
  }

  paintApproachRoad(world, data, {
    dockX,
    dockY,
    dockWidth,
    roadLength: opening.roadLength,
    roadWidth: opening.roadWidth,
    roadMaterial: opening.roadMaterial,
  })

  for (const entry of opening.starterStock) {
    if (world.supply.storeUnits(entry.itemId) > 0) continue
    world.supply.addStoreStock(entry.itemId, entry.units)
  }

  const maintenanceHired = world.staff
    .all()
    .filter((entity) => entity.staff.defId === MAINTENANCE).length
  const toHire = Math.max(0, opening.starterMaintenanceCount - maintenanceHired)
  const spawnX = dockX + Math.floor(dockWidth / 2)
  const spawnY = Math.max(0, dockY - 1)
  for (let i = 0; i < toHire; i += 1) {
    hireStaff({
      world,
      defId: MAINTENANCE,
      events,
      tick: 0,
      tx: Math.min(size - 1, spawnX + (i % 3)),
      ty: Math.max(0, spawnY - Math.floor(i / 3)),
    })
  }
}

function paintApproachRoad(
  world: InmateWorld,
  data: GameData,
  layout: {
    readonly dockX: number
    readonly dockY: number
    readonly dockWidth: number
    readonly roadLength: number
    readonly roadWidth: number
    readonly roadMaterial: string
  },
): void {
  const materialIndex = world.materials.tryIndexOf(layout.roadMaterial)
  if (materialIndex === undefined) return

  const size = world.grid.size
  const roadWidth = Math.min(layout.roadWidth, layout.dockWidth)
  const roadX = layout.dockX + Math.floor((layout.dockWidth - roadWidth) / 2)
  const roadLength = Math.min(layout.roadLength, layout.dockY)
  const roadY0 = Math.max(0, layout.dockY - roadLength)

  for (let y = roadY0; y < layout.dockY; y += 1) {
    for (let x = roadX; x < roadX + roadWidth && x < size; x += 1) {
      const index = world.grid.idx(x, y)
      world.grid.setAt('floorMaterial', index, materialIndex)
      // Approach stays outdoors so it does not read as a building.
      world.grid.setAt('outdoors', index, 1)
      refreshPassability(world, data, index)
      world.structureChanged(index)
    }
  }
}
