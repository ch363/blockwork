/**
 * The blueprint overlay: staged build intent drawn over the world (T1.6, PRD
 * 3.2, mockup §2).
 *
 * A blueprint lives on the **main thread**, not in the simulation
 * (`core/blueprint.ts`). This layer therefore takes a list of rectangles the
 * UI already knows about — it does not project or validate anything itself.
 * Validity arrives as a flag per item because the Trace-facing issue list and
 * the amber tiles must agree, and that agreement is cheapest when both read
 * the same `BlueprintReport`.
 *
 * ## Look
 *
 * From `docs/04-ui-mockups.html`: valid items are `--info` blue wireframe with
 * a soft fill; invalid items are `--warn` amber with the same treatment. The
 * stroke is dashed so the overlay never reads as committed structure sitting
 * on top of the real walls.
 *
 * One `Graphics` path for valid and one for invalid keeps the cost at two
 * draw calls regardless of how large the staged wing is, which matters for
 * the ticket's under-40 budget.
 */

import { Container, Graphics } from 'pixi.js'

import { TILE_SIZE } from '../tiles'

/** `--info` from `docs/04-ui-mockups.html`. */
export const BLUEPRINT_VALID_COLOUR = 0x4c9be8

/** `--warn` amber: the distinct invalid state T1.6 asks for. */
export const BLUEPRINT_INVALID_COLOUR = 0xe8a33d

/** Soft fill alpha matching the mockup's `rgba(76,155,232,.16)`. */
export const BLUEPRINT_FILL_ALPHA = 0.16

/** Stroke alpha: solid enough to read over terrain, soft enough not to shout. */
export const BLUEPRINT_STROKE_ALPHA = 0.92

/** Dash pattern in world units, scaled so it stays readable at zoom 1. */
export const BLUEPRINT_DASH = [9, 6] as const

/** A tile rectangle the overlay should draw. */
export interface BlueprintRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** False draws amber; true (or omitted) draws blue. */
  readonly valid?: boolean
}

export interface BlueprintLayerOptions {
  /** Map edge in tiles. Used only to clip runaway rectangles. */
  readonly mapSize: number
}

export class BlueprintLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #valid: Graphics
  readonly #invalid: Graphics

  #items: readonly BlueprintRect[] = []
  #strokeWidth = 0

  constructor(options: BlueprintLayerOptions) {
    const { mapSize } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.#valid = new Graphics({ label: 'blueprint-valid' })
    this.#invalid = new Graphics({ label: 'blueprint-invalid' })
    this.container = new Container({ label: 'blueprint' })
    this.container.addChild(this.#valid, this.#invalid)
    this.container.visible = false
  }

  get itemCount(): number {
    return this.#items.length
  }

  /** Replaces the overlay contents. An empty list hides the layer. */
  setItems(items: readonly BlueprintRect[]): void {
    this.#items = items
    this.container.visible = items.length > 0
    this.#strokeWidth = 0
    this.#redraw(3)
  }

  clear(): void {
    this.setItems([])
  }

  /**
   * Keeps the stroke roughly one CSS pixel thick as the camera zooms. Only
   * redraws when the width changes enough to notice.
   */
  update(zoom: number): void {
    if (this.#items.length === 0) return
    const width = 2 / Math.max(zoom, 0.01)
    if (this.#strokeWidth > 0 && Math.abs(width / this.#strokeWidth - 1) <= 1e-3) return
    this.#redraw(width)
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }

  #redraw(strokeWidth: number): void {
    this.#strokeWidth = strokeWidth
    this.#valid.clear()
    this.#invalid.clear()

    for (const item of this.#items) {
      const clipped = clipRect(item, this.mapSize)
      if (clipped === undefined) continue

      const target = item.valid === false ? this.#invalid : this.#valid
      const colour = item.valid === false ? BLUEPRINT_INVALID_COLOUR : BLUEPRINT_VALID_COLOUR
      const left = clipped.x * TILE_SIZE
      const top = clipped.y * TILE_SIZE
      const width = clipped.width * TILE_SIZE
      const height = clipped.height * TILE_SIZE

      target.rect(left, top, width, height)
      target.fill({ color: colour, alpha: BLUEPRINT_FILL_ALPHA })
      strokeDashedRect(target, left, top, width, height)
      target.stroke({
        width: strokeWidth,
        color: colour,
        alpha: BLUEPRINT_STROKE_ALPHA,
      })
    }
  }
}

function clipRect(
  rect: BlueprintRect,
  mapSize: number,
): { x: number; y: number; width: number; height: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(mapSize, rect.x + rect.width)
  const bottom = Math.min(mapSize, rect.y + rect.height)
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function strokeDashedRect(
  graphics: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const [dash, gap] = BLUEPRINT_DASH
  const edges: readonly (readonly [number, number, number, number])[] = [
    [x, y, x + width, y],
    [x + width, y, x + width, y + height],
    [x + width, y + height, x, y + height],
    [x, y + height, x, y],
  ]

  for (const [x1, y1, x2, y2] of edges) {
    strokeDashedLine(graphics, x1, y1, x2, y2, dash, gap)
  }
}

function strokeDashedLine(
  graphics: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash: number,
  gap: number,
): void {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (length <= 0) return

  const ux = dx / length
  const uy = dy / length
  let travelled = 0
  let drawing = true

  while (travelled < length) {
    const segment = Math.min(drawing ? dash : gap, length - travelled)
    const fromX = x1 + ux * travelled
    const fromY = y1 + uy * travelled
    const toX = x1 + ux * (travelled + segment)
    const toY = y1 + uy * (travelled + segment)
    if (drawing) {
      graphics.moveTo(fromX, fromY)
      graphics.lineTo(toX, toY)
    }
    travelled += segment
    drawing = !drawing
  }
}
