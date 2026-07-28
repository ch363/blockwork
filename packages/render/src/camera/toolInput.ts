/**
 * Build input: a finger on the world, in tiles (PRD 2.3, 6.3).
 *
 * "Drag a rectangle for foundations, rooms and floors. Drag a line for walls.
 * Tap to place objects, drag to place a run." All four of those are the same
 * gesture measured three ways, so this controller reports a stroke with a
 * `rect`, an axis-locked `line` and the two tiles that bound it, and lets the
 * tool decide which of them it meant.
 *
 * It coexists with `GestureController` rather than replacing it. Both listen
 * to the same canvas; the tool takes single-pointer drags (by asking the
 * gesture controller not to pan on one finger) and leaves pinch and
 * two-finger pan alone. Put a second finger down mid-stroke and the stroke
 * cancels and the camera takes over, which is what a player reaching to zoom
 * out mid-wall expects, and is why the stroke is only committed on the release
 * of the *last* pointer.
 *
 * Everything it emits is in **tile coordinates**, because every build command
 * in `packages/sim` takes tiles. Converting once, here, is what keeps the
 * pixel-to-tile arithmetic out of the app and out of the simulation.
 */

import type { Camera } from './camera'
import { TILE_SIZE } from '../tiles'

export interface TilePoint {
  readonly x: number
  readonly y: number
}

export interface TileRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface TileLine {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/** One drag in progress, or the final state of one that just ended. */
export interface ToolStroke {
  /** The tile the gesture started on. */
  readonly start: TilePoint
  /** The tile under the pointer now. */
  readonly current: TilePoint
  /** The two corners as a normalised rectangle. Never zero-sized. */
  readonly rect: TileRect
  /**
   * `start` to `current`, snapped to whichever axis moved further.
   *
   * Walls are axis-aligned (`isAxisAligned` in `world/walls.ts` enforces it),
   * and a diagonal drag has to become one of the two runs the player might
   * have meant rather than being refused.
   */
  readonly line: TileLine
  /** False until the pointer has actually left the tile it started on. */
  readonly dragged: boolean
}

export interface ToolInputHandlers {
  /** A press and release inside one tile. */
  readonly onTap?: (tile: TilePoint) => void
  /** Fires on every tile the drag crosses, for a live preview. */
  readonly onStrokeUpdate?: (stroke: ToolStroke) => void
  /** The drag ended. The tool commits its action here. */
  readonly onStrokeEnd?: (stroke: ToolStroke) => void
  /** A second pointer arrived, or the gesture was cancelled. */
  readonly onStrokeCancel?: () => void
}

export interface ToolInputOptions {
  readonly target: HTMLElement
  readonly camera: Camera
  readonly handlers?: ToolInputHandlers
  /** Tiles per axis, for clamping a drag that leaves the map. */
  readonly mapSize: number
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value
}

/** The normalised rectangle two tiles bound, inclusive of both. */
export function rectBetween(a: TilePoint, b: TilePoint): TileRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(a.x - b.x) + 1,
    height: Math.abs(a.y - b.y) + 1,
  }
}

/**
 * `a` to `b`, locked to the axis with more travel.
 *
 * Ties go to horizontal. It has to go somewhere, and a wall run that starts
 * ambiguous is more often a corridor than a partition.
 */
export function lineBetween(a: TilePoint, b: TilePoint): TileLine {
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  return dy > dx ? { x1: a.x, y1: a.y, x2: a.x, y2: b.y } : { x1: a.x, y1: a.y, x2: b.x, y2: a.y }
}

export class ToolInputController {
  /** Set true while a build tool owns single-pointer drags. */
  active = false

  handlers: ToolInputHandlers

  readonly #target: HTMLElement
  readonly #camera: Camera
  readonly #mapSize: number

  #pointerId: number | null = null
  #pointers = 0
  #start: TilePoint | null = null
  #current: TilePoint | null = null
  #originX = 0
  #originY = 0
  #attached = false

  constructor(options: ToolInputOptions) {
    this.#target = options.target
    this.#camera = options.camera
    this.#mapSize = options.mapSize
    this.handlers = options.handlers ?? {}
  }

  get attached(): boolean {
    return this.#attached
  }

  /** True while a stroke is being drawn. */
  get drawing(): boolean {
    return this.#start !== null
  }

  /** The stroke in progress, or null. */
  stroke(): ToolStroke | null {
    const start = this.#start
    const current = this.#current
    if (start === null || current === null) return null

    return {
      start,
      current,
      rect: rectBetween(start, current),
      line: lineBetween(start, current),
      dragged: start.x !== current.x || start.y !== current.y,
    }
  }

  attach(): void {
    if (this.#attached) return
    this.#attached = true

    this.#target.addEventListener('pointerdown', this.#onPointerDown)
    this.#target.addEventListener('pointermove', this.#onPointerMove)
    this.#target.addEventListener('pointerup', this.#onPointerUp)
    this.#target.addEventListener('pointercancel', this.#onPointerCancel)
  }

  detach(): void {
    if (!this.#attached) return
    this.#attached = false

    this.#target.removeEventListener('pointerdown', this.#onPointerDown)
    this.#target.removeEventListener('pointermove', this.#onPointerMove)
    this.#target.removeEventListener('pointerup', this.#onPointerUp)
    this.#target.removeEventListener('pointercancel', this.#onPointerCancel)

    this.#reset()
  }

  /** The tile under a canvas-relative screen point. */
  tileAt(screenX: number, screenY: number): TilePoint {
    const world = this.#camera.screenToWorld(screenX, screenY)
    return {
      x: clamp(Math.floor(world.x / TILE_SIZE), this.#mapSize - 1),
      y: clamp(Math.floor(world.y / TILE_SIZE), this.#mapSize - 1),
    }
  }

  #reset(): void {
    this.#pointerId = null
    this.#start = null
    this.#current = null
  }

  #cancel(): void {
    if (this.#start === null) {
      this.#reset()
      return
    }
    this.#reset()
    this.handlers.onStrokeCancel?.()
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    this.#pointers += 1

    // A second finger means the player wants the camera, not a wall.
    if (this.#pointers > 1) {
      this.#cancel()
      return
    }
    if (!this.active) return

    const rect = this.#target.getBoundingClientRect()
    this.#originX = rect.left
    this.#originY = rect.top

    const tile = this.tileAt(event.clientX - this.#originX, event.clientY - this.#originY)
    this.#pointerId = event.pointerId
    this.#start = tile
    this.#current = tile

    const stroke = this.stroke()
    if (stroke !== null) this.handlers.onStrokeUpdate?.(stroke)
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#pointerId || this.#start === null) return

    const tile = this.tileAt(event.clientX - this.#originX, event.clientY - this.#originY)
    const current = this.#current
    // Tile granularity, so a preview rebuild costs one event per tile crossed
    // rather than one per pixel.
    if (current !== null && current.x === tile.x && current.y === tile.y) return

    this.#current = tile
    const stroke = this.stroke()
    if (stroke !== null) this.handlers.onStrokeUpdate?.(stroke)
  }

  readonly #onPointerUp = (event: PointerEvent): void => {
    this.#pointers = Math.max(0, this.#pointers - 1)
    if (event.pointerId !== this.#pointerId) return

    const stroke = this.stroke()
    this.#reset()
    if (stroke === null) return

    if (stroke.dragged) this.handlers.onStrokeEnd?.(stroke)
    else this.handlers.onTap?.(stroke.start)
  }

  readonly #onPointerCancel = (event: PointerEvent): void => {
    this.#pointers = Math.max(0, this.#pointers - 1)
    if (event.pointerId !== this.#pointerId) return
    this.#cancel()
  }
}
