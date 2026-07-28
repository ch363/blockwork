/**
 * The camera: the single source of truth for where the world sits on screen.
 *
 * Everything here is pure arithmetic over numbers. No Pixi, no DOM, no timers.
 * That is deliberate — the camera is the part of the renderer with real logic
 * in it, so it is the part that has to be unit-testable without a GPU, and
 * `app.ts` is left with nothing to do but copy `zoom` and `centre` onto a
 * container transform every frame.
 *
 * Three coordinate spaces, and confusing them is the classic renderer bug:
 *
 *   - **world units** — what the map is measured in. A tile is `TILE_SIZE`
 *     units (PRD 4.3), so a 220x220 map is 7040 units square.
 *   - **screen (CSS) pixels** — what a pointer event reports, relative to the
 *     top-left of the canvas. Not device pixels: the device pixel ratio is the
 *     Pixi renderer's business and never reaches the camera.
 *   - **zoom stops** — the four discrete levels of PRD 2.3.
 *
 * `zoom` is CSS pixels per world unit, so a tile is 32px at zoom 1 and 16px at
 * zoom 0.5. The camera's position is the world point under the centre of the
 * viewport, which makes clamping symmetric and makes a viewport resize keep
 * the same thing on screen.
 *
 * **Time.** `update(elapsedMs)` takes real elapsed milliseconds. That is not a
 * violation of CLAUDE.md rule 3: the rule binds `packages/sim`, whose ticks are
 * integers. Camera easing is presentation, it must run at display rate, and
 * nothing it computes is ever read back into the simulation.
 */

/**
 * The four zoom levels of PRD 2.3, ascending. Pinch and wheel move
 * continuously between them; everything else steps stop to stop.
 */
export const ZOOM_STOPS = [0.5, 1, 2, 4] as const

export const MIN_ZOOM: number = ZOOM_STOPS[0]
export const MAX_ZOOM: number = ZOOM_STOPS[3]

/**
 * How far past the map edge the view may travel, in world units. Three tiles:
 * enough that the boundary reads as an edge rather than a wall the camera is
 * pinned against, and little enough that the map never floats in a void.
 */
export const DEFAULT_CAMERA_MARGIN = 96

/**
 * Time constants for the two eased quantities, in milliseconds. Each is the
 * time to close roughly 63% of the remaining distance, so zoom settles in
 * about a sixth of a second and a flick coasts for about half of one.
 */
const ZOOM_TAU_MS = 60
const MOMENTUM_TAU_MS = 140

/** Below this, in world units per millisecond, a flick has stopped. */
const MIN_MOMENTUM_SPEED = 0.02

/**
 * The largest frame the easing integrator will accept. A backgrounded tab
 * resumes with a multi-second `elapsedMs`, and without this the first frame
 * back would teleport the camera to the end of every animation at once.
 */
const MAX_FRAME_MS = 100

/** Ratio at which an eased zoom is close enough to snap to its target. */
const ZOOM_SNAP_EPSILON = 1e-4

export interface Vec2 {
  readonly x: number
  readonly y: number
}

/** An axis-aligned rectangle in world units. */
export interface WorldRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface CameraOptions {
  /** Map width in world units, normally `mapSize * TILE_SIZE`. */
  readonly worldWidth: number
  readonly worldHeight: number
  /** Viewport size in CSS pixels. */
  readonly viewportWidth: number
  readonly viewportHeight: number
  /** Overscroll past the map edge in world units. */
  readonly margin?: number
  /** Starting zoom. Clamped into the stop range; need not be a stop. */
  readonly zoom?: number
  /** Starting centre in world units. Defaults to the middle of the map. */
  readonly centre?: Vec2
  /**
   * Whether zoom and momentum ease. PRD 7.9's Reduce Motion setting turns this
   * off, which makes every movement immediate rather than merely faster.
   */
  readonly easing?: boolean
}

/** Where a zoom is pivoting: a screen point and the world point beneath it. */
interface ZoomAnchor {
  readonly screenX: number
  readonly screenY: number
  readonly worldX: number
  readonly worldY: number
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, received ${value}`)
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number > 0, received ${value}`)
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** The zoom stop closest to `zoom`, measured on a log scale so 0.7 picks 0.5. */
export function nearestZoomStop(zoom: number): number {
  const target = clampNumber(zoom, MIN_ZOOM, MAX_ZOOM)

  let best: number = ZOOM_STOPS[0]
  let bestDistance = Infinity
  for (const stop of ZOOM_STOPS) {
    const distance = Math.abs(Math.log(target / stop))
    if (distance < bestDistance) {
      bestDistance = distance
      best = stop
    }
  }
  return best
}

/**
 * The stop `steps` places along from the one nearest `zoom`, saturating at the
 * ends of the ladder. `zoomStopFrom(1.4, +1)` is 2, because 1.4 rounds to 1.
 */
export function zoomStopFrom(zoom: number, steps: number): number {
  const nearest = nearestZoomStop(zoom)
  const from = ZOOM_STOPS.findIndex((stop) => stop === nearest)
  const index = clampNumber(from + steps, 0, ZOOM_STOPS.length - 1)
  // `index` is clamped to the tuple's own bounds, so this cannot be undefined.
  return ZOOM_STOPS[index] as number
}

export class Camera {
  /** Turns easing off wholesale, for PRD 7.9's Reduce Motion. */
  easing: boolean

  #worldWidth: number
  #worldHeight: number
  #viewportWidth: number
  #viewportHeight: number
  #margin: number

  #x: number
  #y: number
  #zoom: number
  #targetZoom: number
  #anchor: ZoomAnchor | null = null

  /** Momentum, in world units per millisecond. */
  #velocityX = 0
  #velocityY = 0

  constructor(options: CameraOptions) {
    assertPositive(options.worldWidth, 'worldWidth')
    assertPositive(options.worldHeight, 'worldHeight')
    assertPositive(options.viewportWidth, 'viewportWidth')
    assertPositive(options.viewportHeight, 'viewportHeight')

    this.#worldWidth = options.worldWidth
    this.#worldHeight = options.worldHeight
    this.#viewportWidth = options.viewportWidth
    this.#viewportHeight = options.viewportHeight

    const margin = options.margin ?? DEFAULT_CAMERA_MARGIN
    if (!Number.isFinite(margin) || margin < 0) {
      throw new RangeError(`margin must be a finite number >= 0, received ${margin}`)
    }
    this.#margin = margin

    this.easing = options.easing ?? true
    this.#zoom = clampNumber(options.zoom ?? 1, MIN_ZOOM, MAX_ZOOM)
    this.#targetZoom = this.#zoom

    this.#x = options.centre?.x ?? this.#worldWidth / 2
    this.#y = options.centre?.y ?? this.#worldHeight / 2
    assertFinite(this.#x, 'centre.x')
    assertFinite(this.#y, 'centre.y')

    this.clamp()
  }

  get worldWidth(): number {
    return this.#worldWidth
  }

  get worldHeight(): number {
    return this.#worldHeight
  }

  get viewportWidth(): number {
    return this.#viewportWidth
  }

  get viewportHeight(): number {
    return this.#viewportHeight
  }

  get margin(): number {
    return this.#margin
  }

  /** World x under the centre of the viewport. */
  get x(): number {
    return this.#x
  }

  get y(): number {
    return this.#y
  }

  get centre(): Vec2 {
    return { x: this.#x, y: this.#y }
  }

  /** CSS pixels per world unit, as currently displayed. */
  get zoom(): number {
    return this.#zoom
  }

  /** Where `zoom` is heading. Equal to `zoom` when nothing is animating. */
  get targetZoom(): number {
    return this.#targetZoom
  }

  /** True while zoom is interpolating or a flick is still coasting. */
  get animating(): boolean {
    return this.#zoom !== this.#targetZoom || this.#velocityX !== 0 || this.#velocityY !== 0
  }

  /** Current flick velocity in world units per millisecond. */
  get momentum(): Vec2 {
    return { x: this.#velocityX, y: this.#velocityY }
  }

  /** Follows a viewport resize. Keeps the same world point centred. */
  resize(viewportWidth: number, viewportHeight: number): void {
    assertPositive(viewportWidth, 'viewportWidth')
    assertPositive(viewportHeight, 'viewportHeight')
    this.#viewportWidth = viewportWidth
    this.#viewportHeight = viewportHeight
    this.clamp()
  }

  /** Follows a map change. Re-clamps, so the view can never end up off-map. */
  setWorldSize(worldWidth: number, worldHeight: number): void {
    assertPositive(worldWidth, 'worldWidth')
    assertPositive(worldHeight, 'worldHeight')
    this.#worldWidth = worldWidth
    this.#worldHeight = worldHeight
    this.clamp()
  }

  screenToWorld(screenX: number, screenY: number): Vec2 {
    return {
      x: this.#x + (screenX - this.#viewportWidth / 2) / this.#zoom,
      y: this.#y + (screenY - this.#viewportHeight / 2) / this.#zoom,
    }
  }

  worldToScreen(worldX: number, worldY: number): Vec2 {
    return {
      x: (worldX - this.#x) * this.#zoom + this.#viewportWidth / 2,
      y: (worldY - this.#y) * this.#zoom + this.#viewportHeight / 2,
    }
  }

  /** The world rectangle currently on screen. This is the culling frustum. */
  visibleRect(): WorldRect {
    const halfWidth = this.#viewportWidth / (2 * this.#zoom)
    const halfHeight = this.#viewportHeight / (2 * this.#zoom)
    return {
      left: this.#x - halfWidth,
      top: this.#y - halfHeight,
      right: this.#x + halfWidth,
      bottom: this.#y + halfHeight,
    }
  }

  /** Centres on a world point. Clamped, so the request may not be honoured. */
  moveTo(worldX: number, worldY: number): void {
    assertFinite(worldX, 'worldX')
    assertFinite(worldY, 'worldY')
    this.#x = worldX
    this.#y = worldY
    this.clamp()
  }

  /** Moves the camera itself by a world offset. */
  panByWorld(deltaX: number, deltaY: number): void {
    this.moveTo(this.#x + deltaX, this.#y + deltaY)
  }

  /**
   * Scroll semantics: a positive delta moves the camera the same way, so
   * scrolling down reveals what is below. This is what a wheel or a trackpad
   * two-finger scroll wants.
   */
  panByScreen(deltaX: number, deltaY: number): void {
    this.panByWorld(deltaX / this.#zoom, deltaY / this.#zoom)
  }

  /**
   * Grab semantics: the world follows the finger, so the camera moves against
   * the drag. This is what a one-pointer drag wants.
   */
  dragByScreen(deltaX: number, deltaY: number): void {
    this.panByWorld(-deltaX / this.#zoom, -deltaY / this.#zoom)
  }

  /**
   * Sets zoom immediately, optionally pivoting about a screen point so the
   * world under a pinch centroid or a cursor stays put.
   */
  setZoom(zoom: number, anchorScreen?: Vec2): void {
    assertFinite(zoom, 'zoom')
    const next = clampNumber(zoom, MIN_ZOOM, MAX_ZOOM)

    if (anchorScreen === undefined) {
      this.#zoom = next
    } else {
      const world = this.screenToWorld(anchorScreen.x, anchorScreen.y)
      this.#zoom = next
      this.#x = world.x - (anchorScreen.x - this.#viewportWidth / 2) / this.#zoom
      this.#y = world.y - (anchorScreen.y - this.#viewportHeight / 2) / this.#zoom
    }

    this.#targetZoom = this.#zoom
    this.#anchor = null
    this.clamp()
  }

  /**
   * Eases towards a zoom, holding `anchorScreen` over the same world point for
   * the whole animation rather than only at its start. With easing off this is
   * `setZoom`.
   */
  zoomTo(zoom: number, anchorScreen?: Vec2): void {
    assertFinite(zoom, 'zoom')
    const next = clampNumber(zoom, MIN_ZOOM, MAX_ZOOM)

    if (!this.easing) {
      this.setZoom(next, anchorScreen)
      return
    }

    this.#targetZoom = next
    if (anchorScreen === undefined) {
      this.#anchor = null
      return
    }

    const world = this.screenToWorld(anchorScreen.x, anchorScreen.y)
    this.#anchor = {
      screenX: anchorScreen.x,
      screenY: anchorScreen.y,
      worldX: world.x,
      worldY: world.y,
    }
  }

  /** Steps `steps` zoom stops from where the zoom is now. */
  stepZoom(steps: number, anchorScreen?: Vec2): void {
    this.zoomTo(zoomStopFrom(this.#targetZoom, steps), anchorScreen)
  }

  /** Settles a continuous pinch or wheel zoom onto the nearest stop. */
  snapZoomToStop(anchorScreen?: Vec2): void {
    this.zoomTo(nearestZoomStop(this.#zoom), anchorScreen)
  }

  /**
   * Starts a flick from a pointer velocity in CSS pixels per millisecond,
   * measured in the direction the finger was travelling.
   */
  flickByScreen(velocityX: number, velocityY: number): void {
    assertFinite(velocityX, 'velocityX')
    assertFinite(velocityY, 'velocityY')

    this.#velocityX = -velocityX / this.#zoom
    this.#velocityY = -velocityY / this.#zoom

    if (Math.hypot(this.#velocityX, this.#velocityY) < MIN_MOMENTUM_SPEED) {
      this.stopMomentum()
    }
  }

  stopMomentum(): void {
    this.#velocityX = 0
    this.#velocityY = 0
  }

  /** Cancels easing and momentum, leaving the camera exactly where it is. */
  settle(): void {
    this.stopMomentum()
    this.#targetZoom = this.#zoom
    this.#anchor = null
  }

  /**
   * Advances the eased state by one frame. Safe to call with 0, and safe to
   * call with the multi-second gap a backgrounded tab produces.
   */
  update(elapsedMs: number): void {
    const dt = clampNumber(Number.isFinite(elapsedMs) ? elapsedMs : 0, 0, MAX_FRAME_MS)
    if (dt === 0) return

    this.#updateZoom(dt)
    this.#updateMomentum(dt)
    this.clamp()
  }

  /**
   * Pulls the view back inside the map plus its margin.
   *
   * When the map is smaller than the viewport on an axis — a small map at zoom
   * 0.5, say — there is no valid range to clamp into, so the map is centred on
   * that axis instead. Hitting a bound also kills the momentum on that axis:
   * without it a flick into the edge keeps burning velocity against a wall and
   * the camera sits frozen until the decay runs out.
   */
  clamp(): void {
    const halfWidth = this.#viewportWidth / (2 * this.#zoom)
    const halfHeight = this.#viewportHeight / (2 * this.#zoom)

    const minX = -this.#margin + halfWidth
    const maxX = this.#worldWidth + this.#margin - halfWidth
    const minY = -this.#margin + halfHeight
    const maxY = this.#worldHeight + this.#margin - halfHeight

    const clampedX = minX > maxX ? this.#worldWidth / 2 : clampNumber(this.#x, minX, maxX)
    const clampedY = minY > maxY ? this.#worldHeight / 2 : clampNumber(this.#y, minY, maxY)

    if (clampedX !== this.#x) {
      this.#x = clampedX
      this.#velocityX = 0
    }
    if (clampedY !== this.#y) {
      this.#y = clampedY
      this.#velocityY = 0
    }
  }

  /**
   * Interpolates geometrically, not linearly: zoom is a scale factor, so the
   * step from 0.5 to 1 has to feel like the step from 2 to 4.
   */
  #updateZoom(dt: number): void {
    if (this.#zoom === this.#targetZoom) return

    if (!this.easing) {
      this.#zoom = this.#targetZoom
    } else {
      const progress = 1 - Math.exp(-dt / ZOOM_TAU_MS)
      const next = this.#zoom * (this.#targetZoom / this.#zoom) ** progress
      this.#zoom =
        Math.abs(Math.log(this.#targetZoom / next)) < ZOOM_SNAP_EPSILON ? this.#targetZoom : next
    }

    const anchor = this.#anchor
    if (anchor !== null) {
      this.#x = anchor.worldX - (anchor.screenX - this.#viewportWidth / 2) / this.#zoom
      this.#y = anchor.worldY - (anchor.screenY - this.#viewportHeight / 2) / this.#zoom
    }

    if (this.#zoom === this.#targetZoom) {
      this.#anchor = null
    }
  }

  #updateMomentum(dt: number): void {
    if (this.#velocityX === 0 && this.#velocityY === 0) return

    this.#x += this.#velocityX * dt
    this.#y += this.#velocityY * dt

    const decay = Math.exp(-dt / MOMENTUM_TAU_MS)
    this.#velocityX *= decay
    this.#velocityY *= decay

    if (Math.hypot(this.#velocityX, this.#velocityY) < MIN_MOMENTUM_SPEED) {
      this.stopMomentum()
    }
  }
}
