/**
 * The tile grid overlay, and the map boundary.
 *
 * A tile game needs a visible lattice or the player cannot tell where a wall
 * will land, but a lattice drawn over a whole 220x220 map at the furthest zoom
 * is 440 hairlines in a 1180pt viewport — moiré, not information. So the grid
 * does two things:
 *
 *   - it **fades out below zoom 1**, where a tile is under 32 CSS pixels and
 *     the lines carry no useful precision;
 *   - it **only spans the camera rectangle**, rebuilt when the visible tile
 *     range or the zoom changes, so the geometry is a few dozen lines at any
 *     zoom rather than a few hundred at one and a thousand at another.
 *
 * Line width is specified in world units as `1 / zoom`, which is exactly one
 * CSS pixel however far in the camera is. Without that, a hairline at zoom 4
 * would be drawn four pixels thick.
 *
 * The whole overlay is one `Graphics` path plus one boundary rectangle, so it
 * costs two draw calls regardless of map size.
 */

import { Container, Graphics } from 'pixi.js'

import { TILE_SIZE } from '../tiles'

import type { Camera } from '../camera/camera'

/** Below this zoom the grid is invisible; above `GRID_FULL_ZOOM` it is solid. */
export const GRID_FADE_ZOOM = 0.75
export const GRID_FULL_ZOOM = 1.5

/** `--border-subtle` and `--border-strong` from `docs/04-ui-mockups.html`. */
export const GRID_LINE_COLOUR = 0x2a313d
export const GRID_BOUNDARY_COLOUR = 0x4b5666

/** The grid is a guide, never a feature. It stays under half opacity. */
const GRID_MAX_ALPHA = 0.45

/** Zoom changes below this ratio do not justify rebuilding the path. */
const ZOOM_REBUILD_EPSILON = 1e-3

export interface GridLayerOptions {
  /** Map edge in tiles. */
  readonly mapSize: number
}

export class GridLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #lines: Graphics
  readonly #boundary: Graphics

  #firstColumn = -1
  #lastColumn = -1
  #firstRow = -1
  #lastRow = -1
  #builtAtZoom = 0
  #boundaryZoom = 0

  constructor(options: GridLayerOptions) {
    const { mapSize } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.#lines = new Graphics({ label: 'grid-lines' })
    this.#boundary = new Graphics({ label: 'grid-boundary' })

    this.container = new Container({ label: 'grid' })
    this.container.addChild(this.#lines, this.#boundary)
  }

  /** 0 when the grid is faded out entirely. */
  get alpha(): number {
    return this.#lines.visible ? this.#lines.alpha : 0
  }

  update(camera: Camera): void {
    const zoom = camera.zoom
    const alpha = gridAlpha(zoom)

    this.#drawBoundary(zoom)

    if (alpha <= 0) {
      this.#lines.visible = false
      return
    }

    this.#lines.visible = true
    this.#lines.alpha = alpha

    const rect = camera.visibleRect()
    const worldSize = this.mapSize * TILE_SIZE
    const firstColumn = Math.max(0, Math.floor(rect.left / TILE_SIZE))
    const lastColumn = Math.min(this.mapSize, Math.ceil(rect.right / TILE_SIZE))
    const firstRow = Math.max(0, Math.floor(rect.top / TILE_SIZE))
    const lastRow = Math.min(this.mapSize, Math.ceil(rect.bottom / TILE_SIZE))

    const zoomChanged = Math.abs(zoom / this.#builtAtZoom - 1) > ZOOM_REBUILD_EPSILON
    if (
      !zoomChanged &&
      firstColumn === this.#firstColumn &&
      lastColumn === this.#lastColumn &&
      firstRow === this.#firstRow &&
      lastRow === this.#lastRow
    ) {
      return
    }

    this.#firstColumn = firstColumn
    this.#lastColumn = lastColumn
    this.#firstRow = firstRow
    this.#lastRow = lastRow
    this.#builtAtZoom = zoom

    const top = Math.max(0, Math.min(rect.top, worldSize))
    const bottom = Math.max(0, Math.min(rect.bottom, worldSize))
    const left = Math.max(0, Math.min(rect.left, worldSize))
    const right = Math.max(0, Math.min(rect.right, worldSize))

    this.#lines.clear()
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const x = column * TILE_SIZE
      this.#lines.moveTo(x, top).lineTo(x, bottom)
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = row * TILE_SIZE
      this.#lines.moveTo(left, y).lineTo(right, y)
    }
    this.#lines.stroke({ width: 1 / zoom, color: GRID_LINE_COLOUR, alignment: 0.5 })
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }

  /**
   * The only zoom-dependent property of the boundary is its line width, so it
   * is redrawn on a zoom change and left alone while panning.
   */
  #drawBoundary(zoom: number): void {
    if (Math.abs(zoom / this.#boundaryZoom - 1) <= ZOOM_REBUILD_EPSILON) return
    this.#boundaryZoom = zoom

    const worldSize = this.mapSize * TILE_SIZE
    this.#boundary.clear()
    this.#boundary
      .rect(0, 0, worldSize, worldSize)
      .stroke({ width: 2 / zoom, color: GRID_BOUNDARY_COLOUR, alignment: 1 })
  }
}

/** Ramps the grid in between `GRID_FADE_ZOOM` and `GRID_FULL_ZOOM`. */
export function gridAlpha(zoom: number): number {
  if (zoom <= GRID_FADE_ZOOM) return 0
  if (zoom >= GRID_FULL_ZOOM) return GRID_MAX_ALPHA
  return ((zoom - GRID_FADE_ZOOM) / (GRID_FULL_ZOOM - GRID_FADE_ZOOM)) * GRID_MAX_ALPHA
}
