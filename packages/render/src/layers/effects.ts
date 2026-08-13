/**
 * Effects layer: layer 6 of PRD 7.6 — selection rings, path debug, notification
 * pins, and other UI-in-world overlays.
 *
 * This layer draws **over** agents and objects but **under** the grid, so a
 * selection ring surrounds its subject without obscuring it, and a notification
 * pin hovers above the entity it concerns.
 *
 * ## Selection rings
 *
 * When an entity is selected, a ring animates around it. The ring pulses
 * gently so it is always visible but never distracting. Selection state is
 * pushed from the host via `setSelection`; the layer does not track clicks.
 *
 * ## Path debug
 *
 * For development and replay inspection, the layer can draw a path as a series
 * of chevrons showing direction. Hidden by default.
 *
 * ## Notification pins
 *
 * A notification that references an entity pins to it: a small icon above the
 * subject that pulses and clears when the notification is dismissed or the
 * subject is destroyed. Pins are keyed by notification id so the host can add,
 * update, and remove them independently.
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import {
  createSpriteCanvas,
  cssColour,
  greyColour,
  sliceAtlas,
  spriteAtlasFromCanvas,
} from '../sprites/atlas'
import type { SpriteAtlas } from '../sprites/atlas'
import { TILE_SIZE } from '../tiles'

import type { Camera } from '../camera/camera'

/** Selection ring colour — matches `--accent` from the mockups. */
export const EFFECT_SELECTION_COLOUR = 0xf0a93b

/** Notification pin colours by severity. */
export const EFFECT_PIN_COLOURS = {
  info: 0x4a90d9,
  warn: 0xd9a34a,
  critical: 0xd94a4a,
} as const

export type EffectPinSeverity = keyof typeof EFFECT_PIN_COLOURS

/** Atlas cell size in pixels. */
export const EFFECT_ATLAS_CELL_PX = 32

/** Number of pulse frames for animated effects. */
export const EFFECT_PULSE_FRAMES = 8

/** Selection ring's world-unit radius relative to TILE_SIZE. */
export const SELECTION_RING_RADIUS = TILE_SIZE * 0.55

/** How high a notification pin floats above its subject. */
export const PIN_HOVER_OFFSET = TILE_SIZE * 0.6

/** A selected entity for the effects layer to ring. */
export interface EffectSelection {
  readonly id: number
  readonly x: number
  readonly y: number
  /** World-unit radius override. Defaults to SELECTION_RING_RADIUS. */
  readonly radius?: number
}

/** A path segment for debug visualization. */
export interface EffectPathSegment {
  readonly fromX: number
  readonly fromY: number
  readonly toX: number
  readonly toY: number
}

/** A notification pin attached to an entity. */
export interface EffectPin {
  /** Notification id — the layer's key for add/update/remove. */
  readonly id: string
  readonly subjectId: number
  readonly x: number
  readonly y: number
  readonly severity: EffectPinSeverity
  /** Icon index into the pin atlas row, or -1 for generic exclamation. */
  readonly iconIndex?: number
}

export interface EffectsLayerOptions {
  readonly mapSize: number
  readonly atlas?: SpriteAtlas
}

/**
 * Atlas layout (row-major cells):
 *
 *   row 0   selection ring pulse frames (EFFECT_PULSE_FRAMES cells)
 *   row 1   notification pin: info severity (icon + EFFECT_PULSE_FRAMES)
 *   row 2   notification pin: warn severity
 *   row 3   notification pin: critical severity
 *   row 4   path debug chevron (4 directions)
 */
const ATLAS_ROWS = 5
const ATLAS_COLUMNS = Math.max(EFFECT_PULSE_FRAMES, 8)

/** Creates the effects atlas with selection rings, pins, and path debug. */
export function createEffectsAtlas(cellPx: number = EFFECT_ATLAS_CELL_PX): SpriteAtlas {
  if (!Number.isInteger(cellPx) || cellPx < 8) {
    throw new RangeError(`effects atlas cellPx must be an integer >= 8, received ${cellPx}`)
  }

  const { canvas, context } = createSpriteCanvas(ATLAS_COLUMNS * cellPx, ATLAS_ROWS * cellPx)

  // Row 0: Selection ring pulse frames
  for (let frame = 0; frame < EFFECT_PULSE_FRAMES; frame += 1) {
    const x = frame * cellPx
    const y = 0
    const pulse = 0.7 + 0.3 * Math.sin((frame / EFFECT_PULSE_FRAMES) * Math.PI * 2)
    drawSelectionRing(context, x, y, cellPx, pulse)
  }

  // Rows 1-3: Notification pins by severity
  const severities: EffectPinSeverity[] = ['info', 'warn', 'critical']
  for (const [severityIndex, severity] of severities.entries()) {
    const y = (severityIndex + 1) * cellPx
    const colour = EFFECT_PIN_COLOURS[severity]

    // First cell: static icon
    drawNotificationPin(context, 0, y, cellPx, colour, 1)

    // Pulse frames
    for (let frame = 0; frame < EFFECT_PULSE_FRAMES; frame += 1) {
      const x = (frame + 1) * cellPx
      const pulse = 0.75 + 0.25 * Math.sin((frame / EFFECT_PULSE_FRAMES) * Math.PI * 2)
      drawNotificationPin(context, x, y, cellPx, colour, pulse)
    }
  }

  // Row 4: Path debug chevrons (4 directions)
  const chevronRow = 4
  const directions = [
    { dx: 0, dy: -1 }, // North
    { dx: 1, dy: 0 },  // East
    { dx: 0, dy: 1 },  // South
    { dx: -1, dy: 0 }, // West
  ]
  for (const [dirIndex, dir] of directions.entries()) {
    const x = dirIndex * cellPx
    const y = chevronRow * cellPx
    drawPathChevron(context, x, y, cellPx, dir.dx, dir.dy)
  }

  return spriteAtlasFromCanvas(canvas, {
    cellPx,
    columns: ATLAS_COLUMNS,
    rows: ATLAS_ROWS,
    label: 'blockwork-effects',
  })
}

function drawSelectionRing(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellPx: number,
  pulse: number,
): void {
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  const radius = cellPx * 0.38

  // Outer glow
  context.strokeStyle = cssColour(EFFECT_SELECTION_COLOUR, 0.25 * pulse)
  context.lineWidth = Math.max(4, cellPx * 0.14)
  context.beginPath()
  context.arc(cx, cy, radius, 0, Math.PI * 2)
  context.stroke()

  // Inner ring
  context.strokeStyle = cssColour(EFFECT_SELECTION_COLOUR, pulse)
  context.lineWidth = Math.max(2, cellPx * 0.07)
  context.beginPath()
  context.arc(cx, cy, radius, 0, Math.PI * 2)
  context.stroke()
}

function drawNotificationPin(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellPx: number,
  colour: number,
  pulse: number,
): void {
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  const pinRadius = cellPx * 0.28 * pulse

  // Pin background disc
  context.fillStyle = cssColour(0x1a1f27, 0.92)
  context.beginPath()
  context.arc(cx, cy, pinRadius + 2, 0, Math.PI * 2)
  context.fill()

  // Coloured disc
  context.fillStyle = cssColour(colour, pulse)
  context.beginPath()
  context.arc(cx, cy, pinRadius, 0, Math.PI * 2)
  context.fill()

  // Exclamation mark
  context.fillStyle = greyColour(255, pulse)
  const bangWidth = cellPx * 0.06
  const bangHeight = pinRadius * 0.55
  context.fillRect(cx - bangWidth / 2, cy - bangHeight, bangWidth, bangHeight)
  context.beginPath()
  context.arc(cx, cy + pinRadius * 0.25, bangWidth * 0.7, 0, Math.PI * 2)
  context.fill()
}

function drawPathChevron(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellPx: number,
  dx: number,
  dy: number,
): void {
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  const size = cellPx * 0.3

  context.save()
  context.translate(cx, cy)
  context.rotate(Math.atan2(dy, dx) + Math.PI / 2)

  context.strokeStyle = cssColour(0x4a90d9, 0.8)
  context.lineWidth = Math.max(2, cellPx * 0.08)
  context.lineCap = 'round'
  context.lineJoin = 'round'

  context.beginPath()
  context.moveTo(-size, size * 0.5)
  context.lineTo(0, -size * 0.5)
  context.lineTo(size, size * 0.5)
  context.stroke()

  context.restore()
}

/** Atlas cell indices. */
export function effectsSelectionCell(frame: number): number {
  return (frame % EFFECT_PULSE_FRAMES)
}

export function effectsPinCell(severity: EffectPinSeverity, frame: number): number {
  const severities: EffectPinSeverity[] = ['info', 'warn', 'critical']
  const row = severities.indexOf(severity) + 1
  const col = (frame % EFFECT_PULSE_FRAMES) + 1
  return row * ATLAS_COLUMNS + col
}

export function effectsChevronCell(directionIndex: number): number {
  return 4 * ATLAS_COLUMNS + (directionIndex % 4)
}

export class EffectsLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #atlas: SpriteAtlas
  readonly #textures: readonly Texture[]
  readonly #selectionContainer: Container
  readonly #pinsContainer: Container
  readonly #pathContainer: Container

  readonly #selections = new Map<number, EffectSelection>()
  readonly #selectionSprites = new Map<number, Sprite>()
  readonly #pins = new Map<string, EffectPin>()
  readonly #pinSprites = new Map<string, Sprite>()
  #pathDebugEnabled = false
  readonly #pathGraphics: Graphics

  #tick = 0

  constructor(options: EffectsLayerOptions) {
    const { mapSize, atlas } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.#atlas = atlas ?? createEffectsAtlas()
    this.#textures = sliceAtlas(this.#atlas)

    this.container = new Container({ label: 'effects' })

    this.#selectionContainer = new Container({ label: 'effects-selection' })
    this.#pinsContainer = new Container({ label: 'effects-pins' })
    this.#pathContainer = new Container({ label: 'effects-path' })
    this.#pathGraphics = new Graphics({ label: 'path-debug' })
    this.#pathContainer.addChild(this.#pathGraphics)
    this.#pathContainer.visible = false

    this.container.addChild(this.#selectionContainer, this.#pinsContainer, this.#pathContainer)
  }

  get selectionCount(): number {
    return this.#selections.size
  }

  get pinCount(): number {
    return this.#pins.size
  }

  get pathDebugEnabled(): boolean {
    return this.#pathDebugEnabled
  }

  /** Replaces the entire selection set. */
  setSelections(selections: Iterable<EffectSelection>): void {
    for (const id of [...this.#selectionSprites.keys()]) {
      this.#destroySelectionSprite(id)
    }
    this.#selections.clear()
    for (const sel of selections) {
      this.#selections.set(sel.id, sel)
    }
  }

  /** Adds or updates a single selection. */
  setSelection(selection: EffectSelection): void {
    this.#selections.set(selection.id, selection)
  }

  /** Removes a selection by entity id. */
  removeSelection(id: number): void {
    if (!this.#selections.delete(id)) return
    this.#destroySelectionSprite(id)
  }

  /** Clears all selections. */
  clearSelections(): void {
    for (const id of [...this.#selectionSprites.keys()]) {
      this.#destroySelectionSprite(id)
    }
    this.#selections.clear()
  }

  /** Adds or updates a notification pin. */
  setPin(pin: EffectPin): void {
    this.#pins.set(pin.id, pin)
  }

  /** Removes a pin by notification id. */
  removePin(id: string): void {
    if (!this.#pins.delete(id)) return
    this.#destroyPinSprite(id)
  }

  /** Clears all pins. */
  clearPins(): void {
    for (const id of [...this.#pinSprites.keys()]) {
      this.#destroyPinSprite(id)
    }
    this.#pins.clear()
  }

  /** Removes all pins for a given subject entity. */
  removePinsForSubject(subjectId: number): void {
    for (const [id, pin] of this.#pins) {
      if (pin.subjectId === subjectId) {
        this.removePin(id)
      }
    }
  }

  /** Enables or disables path debug visualization. */
  setPathDebugEnabled(enabled: boolean): void {
    this.#pathDebugEnabled = enabled
    this.#pathContainer.visible = enabled
  }

  /** Sets the path to visualize for debug. */
  setDebugPath(segments: readonly EffectPathSegment[]): void {
    this.#pathGraphics.clear()
    if (segments.length === 0) return

    this.#pathGraphics.setStrokeStyle({ width: 2, color: 0x4a90d9, alpha: 0.7 })
    for (const segment of segments) {
      this.#pathGraphics.moveTo(segment.fromX, segment.fromY)
      this.#pathGraphics.lineTo(segment.toX, segment.toY)
    }
    this.#pathGraphics.stroke()

    // Draw chevrons at each segment midpoint
    for (const segment of segments) {
      const mx = (segment.fromX + segment.toX) / 2
      const my = (segment.fromY + segment.toY) / 2
      const dx = segment.toX - segment.fromX
      const dy = segment.toY - segment.fromY
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 0.01) continue

      const angle = Math.atan2(dy, dx)
      const chevSize = Math.min(8, len * 0.3)

      this.#pathGraphics.moveTo(
        mx - Math.cos(angle - 0.5) * chevSize,
        my - Math.sin(angle - 0.5) * chevSize,
      )
      this.#pathGraphics.lineTo(mx, my)
      this.#pathGraphics.lineTo(
        mx - Math.cos(angle + 0.5) * chevSize,
        my - Math.sin(angle + 0.5) * chevSize,
      )
      this.#pathGraphics.stroke()
    }
  }

  /** Clears the debug path. */
  clearDebugPath(): void {
    this.#pathGraphics.clear()
  }

  /** Frame update: animate pulse effects and cull off-screen items. */
  update(camera: Camera, deltaMs: number): void {
    this.#tick += deltaMs

    const pulseFrame = Math.floor(this.#tick / 120) % EFFECT_PULSE_FRAMES
    const rect = camera.visibleRect()

    // Update selections
    for (const [id, sel] of this.#selections) {
      let sprite = this.#selectionSprites.get(id)
      if (sprite === undefined) {
        sprite = this.#createSelectionSprite(id)
        this.#selectionSprites.set(id, sprite)
      }

      const texture = this.#textures[effectsSelectionCell(pulseFrame)]
      if (texture !== undefined) {
        sprite.texture = texture
      }

      const radius = sel.radius ?? SELECTION_RING_RADIUS
      const size = radius * 2.6
      sprite.setSize(size, size)
      sprite.position.set(sel.x, sel.y)

      const onScreen =
        sel.x + size / 2 >= rect.left &&
        sel.x - size / 2 <= rect.right &&
        sel.y + size / 2 >= rect.top &&
        sel.y - size / 2 <= rect.bottom
      sprite.visible = onScreen
    }

    // Update pins
    for (const [id, pin] of this.#pins) {
      let sprite = this.#pinSprites.get(id)
      if (sprite === undefined) {
        sprite = this.#createPinSprite(id)
        this.#pinSprites.set(id, sprite)
      }

      const texture = this.#textures[effectsPinCell(pin.severity, pulseFrame)]
      if (texture !== undefined) {
        sprite.texture = texture
      }

      const pinSize = TILE_SIZE * 0.5
      sprite.setSize(pinSize, pinSize)
      sprite.position.set(pin.x, pin.y - PIN_HOVER_OFFSET)

      const onScreen =
        pin.x >= rect.left - TILE_SIZE &&
        pin.x <= rect.right + TILE_SIZE &&
        pin.y >= rect.top - TILE_SIZE &&
        pin.y <= rect.bottom + TILE_SIZE
      sprite.visible = onScreen
    }

    this.#tick += 1
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const texture of this.#textures) {
      texture.destroy(false)
    }
    this.#atlas.destroy()
    this.#selections.clear()
    this.#selectionSprites.clear()
    this.#pins.clear()
    this.#pinSprites.clear()
  }

  #createSelectionSprite(id: number): Sprite {
    const sprite = new Sprite({ label: `sel-${String(id)}` })
    sprite.anchor.set(0.5, 0.5)
    this.#selectionContainer.addChild(sprite)
    return sprite
  }

  #destroySelectionSprite(id: number): void {
    const sprite = this.#selectionSprites.get(id)
    if (sprite === undefined) return
    this.#selectionSprites.delete(id)
    this.#selectionContainer.removeChild(sprite)
    sprite.destroy()
  }

  #createPinSprite(id: string): Sprite {
    const sprite = new Sprite({ label: `pin-${id}` })
    sprite.anchor.set(0.5, 0.5)
    this.#pinsContainer.addChild(sprite)
    return sprite
  }

  #destroyPinSprite(id: string): void {
    const sprite = this.#pinSprites.get(id)
    if (sprite === undefined) return
    this.#pinSprites.delete(id)
    this.#pinsContainer.removeChild(sprite)
    sprite.destroy()
  }
}
