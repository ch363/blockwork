/**
 * Control overlays: sectors, fire/smoke, and discovered tunnels (Phase 4 interim).
 *
 * Full PRD 6.4 overlays land in T6.1. This layer paints translucent tile fills
 * from host-supplied data so Posts paint mode and emergencies are visible.
 */

import { Container, Graphics } from 'pixi.js'

import type { Camera } from '../camera/camera'
import { TILE_SIZE } from '../tiles'

export type OverlayMode = 'off' | 'sectors' | 'fire' | 'tunnels'

export interface OverlayFireTile {
  readonly index: number
  readonly intensity: number
  readonly smoke: number
}

export interface OverlayTunnel {
  readonly id: number
  readonly originTile: number
  readonly tiles: readonly number[]
}

export interface OverlayLayerOptions {
  readonly mapSize: number
}

const SECTOR_FILL_ALPHA = 0.28
const FIRE_FILL_ALPHA = 0.45
const SMOKE_FILL_ALPHA = 0.22
const TUNNEL_FILL_ALPHA = 0.35
const TUNNEL_COLOUR = 0x6b5344

export class OverlayLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #gfx: Graphics
  #mode: OverlayMode = 'off'
  #sectorIds: Uint16Array | null = null
  #sectorColours = new Map<number, number>()
  #fire: readonly OverlayFireTile[] = []
  #tunnels: readonly OverlayTunnel[] = []
  #dirty = true

  constructor(options: OverlayLayerOptions) {
    const { mapSize } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }
    this.mapSize = mapSize
    this.#gfx = new Graphics({ label: 'overlay-fill' })
    this.container = new Container({ label: 'overlay' })
    this.container.addChild(this.#gfx)
    this.container.visible = false
  }

  setMode(mode: OverlayMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    this.container.visible = mode !== 'off'
    this.#dirty = true
  }

  get mode(): OverlayMode {
    return this.#mode
  }

  setSectorIds(sectorIds: Uint16Array): void {
    this.#sectorIds = sectorIds
    this.#dirty = true
  }

  setSectorColours(colours: ReadonlyMap<number, number> | Readonly<Record<number, number>>): void {
    this.#sectorColours = new Map(
      colours instanceof Map ? colours.entries() : Object.entries(colours).map(([k, v]) => [Number(k), v]),
    )
    this.#dirty = true
  }

  setFire(tiles: readonly OverlayFireTile[]): void {
    this.#fire = tiles
    this.#dirty = true
  }

  setTunnels(tunnels: readonly OverlayTunnel[]): void {
    this.#tunnels = tunnels
    this.#dirty = true
  }

  markDirty(): void {
    this.#dirty = true
  }

  /** Rebuilds when dirty. Camera is reserved for future frustum culling. */
  sync(_camera: Camera): void {
    if (!this.#dirty || this.#mode === 'off') return
    this.#dirty = false
    this.#gfx.clear()

    if (this.#mode === 'sectors') this.#drawSectors()
    else if (this.#mode === 'fire') this.#drawFire()
    else if (this.#mode === 'tunnels') this.#drawTunnels()
  }

  #drawSectors(): void {
    const ids = this.#sectorIds
    if (ids === null) return
    const size = this.mapSize
    const total = size * size
    for (let i = 0; i < total && i < ids.length; i += 1) {
      const id = ids[i] ?? 0
      if (id === 0) continue
      const colour = this.#sectorColours.get(id) ?? defaultSectorColour(id)
      const x = (i % size) * TILE_SIZE
      const y = Math.floor(i / size) * TILE_SIZE
      this.#gfx.rect(x, y, TILE_SIZE, TILE_SIZE)
      this.#gfx.fill({ color: colour, alpha: SECTOR_FILL_ALPHA })
    }
  }

  #drawFire(): void {
    const size = this.mapSize
    for (const tile of this.#fire) {
      const x = (tile.index % size) * TILE_SIZE
      const y = Math.floor(tile.index / size) * TILE_SIZE
      if (tile.intensity > 0) {
        const t = Math.min(1, tile.intensity / 255)
        const colour = 0xff0000 | (Math.round((1 - t) * 0x80) << 8)
        this.#gfx.rect(x, y, TILE_SIZE, TILE_SIZE)
        this.#gfx.fill({ color: colour, alpha: FIRE_FILL_ALPHA * (0.4 + 0.6 * t) })
      }
      if (tile.smoke > 0) {
        const s = Math.min(1, tile.smoke / 255)
        this.#gfx.rect(x, y, TILE_SIZE, TILE_SIZE)
        this.#gfx.fill({ color: 0x888888, alpha: SMOKE_FILL_ALPHA * s })
      }
    }
  }

  #drawTunnels(): void {
    const size = this.mapSize
    for (const tunnel of this.#tunnels) {
      for (const index of tunnel.tiles) {
        const x = (index % size) * TILE_SIZE
        const y = Math.floor(index / size) * TILE_SIZE
        this.#gfx.rect(x, y, TILE_SIZE, TILE_SIZE)
        this.#gfx.fill({ color: TUNNEL_COLOUR, alpha: TUNNEL_FILL_ALPHA })
      }
      const ox = (tunnel.originTile % size) * TILE_SIZE
      const oy = Math.floor(tunnel.originTile / size) * TILE_SIZE
      this.#gfx.rect(ox + 4, oy + 4, TILE_SIZE - 8, TILE_SIZE - 8)
      this.#gfx.stroke({ width: 2, color: 0xc4a574, alpha: 0.9 })
    }
  }
}

function defaultSectorColour(id: number): number {
  const palette = [0xc44c4c, 0x4c9be8, 0x4ca86b, 0xe8a33d, 0x9b6bca, 0x4caaaa]
  return palette[(id - 1) % palette.length] ?? 0x4c9be8
}

/** Parses `#rgb` / `#rrggbb` into `0xRRGGBB`, or null. */
export function parseCssColour(value: string): number | null {
  const raw = value.trim()
  if (!raw.startsWith('#')) return null
  const hex = raw.slice(1)
  if (hex.length === 3) {
    const r = Number.parseInt(hex[0]! + hex[0]!, 16)
    const g = Number.parseInt(hex[1]! + hex[1]!, 16)
    const b = Number.parseInt(hex[2]! + hex[2]!, 16)
    if (![r, g, b].every(Number.isFinite)) return null
    return (r << 16) | (g << 8) | b
  }
  if (hex.length === 6) {
    const n = Number.parseInt(hex, 16)
    return Number.isFinite(n) ? n : null
  }
  return null
}
