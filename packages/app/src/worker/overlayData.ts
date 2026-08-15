/**
 * Builds the one-byte-per-tile payload consumed by the shader overlay.
 *
 * This runs in the simulation worker because room grades, contraband and fog
 * are authoritative world state. It only reads state: overlays cannot affect
 * determinism, commands or balance.
 */

import type { GameData, InmateWorld } from '@blockwork/sim'
import { hasFeature } from '@blockwork/sim'

export const OVERLAY_REQUEST_MODES = [
  'sectors',
  'roomGrade',
  'needs',
  'contrabandRisk',
  'power',
  'water',
  'temperature',
  'cleanliness',
  'guardCoverage',
  'fogOfWar',
] as const

export type OverlayRequestMode = (typeof OVERLAY_REQUEST_MODES)[number]

export interface OverlayDataRequest {
  readonly mode: OverlayRequestMode
  readonly needId?: string
}

/** Presentation range only; simulation temperature remains an unrestricted Int8. */
export const OVERLAY_TEMPERATURE_MIN_C = -10
export const OVERLAY_TEMPERATURE_MAX_C = 30
/** A small spatial kernel makes agent point samples legible as a heatmap. */
export const OVERLAY_HEAT_RADIUS_TILES = 4

export function encodeOverlayUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return 1 + Math.round(Math.min(1, Math.max(0, value)) * 254)
}

export function encodeOverlayTemperature(celsius: number): number {
  return encodeOverlayUnit(
    (celsius - OVERLAY_TEMPERATURE_MIN_C) / (OVERLAY_TEMPERATURE_MAX_C - OVERLAY_TEMPERATURE_MIN_C),
  )
}

/**
 * Stamps a radial maximum into a scalar heatmap. Values are 0..1 while built;
 * normalisation to the transfer byte happens once at the end.
 */
export function stampOverlayHeat(
  target: Float32Array,
  size: number,
  tx: number,
  ty: number,
  value: number,
  radius: number,
): void {
  if (value <= 0 || radius < 0) return
  const minX = Math.max(0, tx - radius)
  const maxX = Math.min(size - 1, tx + radius)
  const minY = Math.max(0, ty - radius)
  const maxY = Math.min(size - 1, ty + radius)
  const divisor = Math.max(1, radius + 1)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.abs(x - tx) + Math.abs(y - ty)
      if (distance > radius) continue
      const weighted = value * (1 - distance / divisor)
      const index = y * size + x
      if (weighted > (target[index] ?? 0)) target[index] = weighted
    }
  }
}

export function scalarOverlayBytes(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.length)
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0
    if (value <= 0) continue
    bytes[i] = encodeOverlayUnit(value)
  }
  return bytes
}

export function buildOverlayData(
  world: InmateWorld,
  data: GameData,
  request: OverlayDataRequest,
): Uint8Array {
  switch (request.mode) {
    case 'sectors':
      return sectorData(world)
    case 'roomGrade':
      return roomGradeData(world, data)
    case 'needs':
      return needsData(world, data, request.needId)
    case 'contrabandRisk':
      return contrabandRiskData(world, data)
    case 'power':
      return powerData(world)
    case 'water':
      return waterData(world)
    case 'temperature':
      return temperatureData(world)
    case 'cleanliness':
      return cleanlinessData(world)
    case 'guardCoverage':
      return guardCoverageData(world, data)
    case 'fogOfWar':
      return hasFeature(data, world.directorate, 'surveillance')
        ? fogData(world)
        : new Uint8Array(world.grid.tileCount)
  }
}

function sectorData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  const ordinalById = new Map(
    world.sectors.all().map((sector, index) => [sector.id, index + 1] as const),
  )
  for (let i = 0; i < result.length; i += 1) {
    const id = world.grid.sectorId[i] ?? 0
    result[i] = id === 0 ? 0 : (ordinalById.get(id) ?? 0)
  }
  return result
}

function roomGradeData(world: InmateWorld, data: GameData): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (const room of world.rooms.all()) {
    const grade = world.grading.breakdowns.get(room.id)
    const def = data.rooms.find(room.defId)
    if (grade === undefined || def?.gradingRules === undefined) continue
    const span = def.gradingRules.max - def.gradingRules.min
    const unit = span <= 0 ? 0 : (grade.score - def.gradingRules.min) / span
    const encoded = encodeOverlayUnit(unit)
    for (const tile of room.tiles) result[tile] = encoded
  }
  return result
}

function needsData(world: InmateWorld, data: GameData, needId: string | undefined): Uint8Array {
  const index = needId === undefined ? -1 : data.needs.indexOf(needId)
  if (index < 0) return new Uint8Array(world.grid.tileCount)

  const heat = new Float32Array(world.grid.tileCount)
  for (const entity of world.inmates.all()) {
    const value = (entity.inmate.needs[index] ?? 0) / 100
    stampOverlayHeat(heat, world.grid.size, entity.tx, entity.ty, value, OVERLAY_HEAT_RADIUS_TILES)
  }
  return scalarOverlayBytes(heat)
}

function contrabandRiskData(world: InmateWorld, data: GameData): Uint8Array {
  const raw = new Float32Array(world.grid.tileCount)
  const sourceCount = new Map<string, number>()
  for (const item of data.contraband.all) {
    for (const roomId of item.sourceRooms) {
      sourceCount.set(roomId, (sourceCount.get(roomId) ?? 0) + 1)
    }
  }

  for (const room of world.rooms.all()) {
    const count = sourceCount.get(room.defId) ?? 0
    if (count === 0) continue
    for (const tile of room.tiles) raw[tile] = (raw[tile] ?? 0) + count
  }
  for (const stash of world.contraband.stashes) {
    raw[stash.tileIndex] = (raw[stash.tileIndex] ?? 0) + 1
  }
  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.inventory.length === 0) continue
    const tile = inmate.ty * world.grid.size + inmate.tx
    raw[tile] = (raw[tile] ?? 0) + inmate.inmate.inventory.length
  }

  let max = 0
  for (const value of raw) max = Math.max(max, value)
  if (max <= 0) return new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] ?? 0) / max
  return scalarOverlayBytes(raw)
}

function powerData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (let i = 0; i < result.length; i += 1) {
    if (!world.power.hasCableAt(i)) continue
    const branch = world.grid.powerGridId[i] ?? 0
    result[i] = branch <= 0 ? 1 : world.power.isBranchShed(branch) ? 3 : 2
  }
  return result
}

function waterData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (let i = 0; i < result.length; i += 1) {
    if (!world.water.hasPipeAt(i)) continue
    const branch = world.grid.waterGridId[i] ?? 0
    result[i] = encodeOverlayUnit(world.water.useMultiplierAt(branch))
  }
  return result
}

function temperatureData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (let i = 0; i < result.length; i += 1) {
    result[i] = encodeOverlayTemperature(world.grid.temperature[i] ?? 0)
  }
  return result
}

function cleanlinessData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (let i = 0; i < result.length; i += 1) {
    const cleanliness = 1 - (world.grid.dirt[i] ?? 0) / 255
    result[i] = encodeOverlayUnit(cleanliness)
  }
  return result
}

function guardCoverageData(world: InmateWorld, data: GameData): Uint8Array {
  const heat = new Float32Array(world.grid.tileCount)
  const radius = data.balance.staff.fogRadiusTiles
  for (const officer of world.staff.withCapability(data, 'patrol')) {
    stampOverlayHeat(heat, world.grid.size, officer.tx, officer.ty, 1, radius)
  }
  return scalarOverlayBytes(heat)
}

function fogData(world: InmateWorld): Uint8Array {
  const result = new Uint8Array(world.grid.tileCount)
  for (let i = 0; i < result.length; i += 1) {
    // Category 1 is "hidden"; revealed tiles stay transparent.
    result[i] = world.fog.revealed[i] === 1 ? 0 : 1
  }
  return result
}
