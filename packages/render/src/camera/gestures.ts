/**
 * Camera input: one drag to pan, two fingers to pinch, a wheel to scroll
 * (PRD 2.3).
 *
 * Everything here is a **Pointer Event**, never a touch event. Touch events
 * would work on the iPad and leave the Mac trackpad and mouse unhandled, and
 * PRD 2.3 asks for full parity. Pointer events give one code path for finger,
 * Pencil, trackpad and mouse; the only input that needs its own listener is
 * the wheel, which pointer events do not cover.
 *
 * The controller owns no camera state of its own. It converts raw input into
 * calls on `Camera` — `dragByScreen`, `setZoom`, `flickByScreen` — so the
 * clamping, easing and momentum rules live in one place and stay testable
 * without a DOM.
 *
 * Two behaviours worth stating, because they are choices rather than
 * consequences:
 *
 *   - **Pinch tracks the fingers, then settles.** While two pointers are down
 *     the zoom is continuous, because a pinch that jumped between four stops
 *     would feel broken. On release it eases to the nearest stop, which is
 *     what PRD 2.3's "4 discrete zoom levels with smooth interpolation" means.
 *   - **Wheel zoom is detented.** A Mac trackpad pinch arrives as a stream of
 *     small `ctrl`+wheel events, so the deltas are accumulated and spend
 *     themselves one stop at a time. No timers are involved anywhere in this
 *     module.
 */

import type { Camera, Vec2 } from './camera'

/** A pointer we are currently tracking, in canvas-relative CSS pixels. */
interface TrackedPointer {
  x: number
  y: number
}

/** One entry in the short history a flick velocity is measured over. */
interface MotionSample {
  readonly time: number
  readonly x: number
  readonly y: number
}

/**
 * How much accumulated wheel delta buys one zoom stop. Tuned against a Mac
 * trackpad pinch, where a comfortable gesture produces a few hundred units.
 */
const WHEEL_ZOOM_STEP = 120

/** `WheelEvent.deltaMode` is in lines; this is the assumed line height in px. */
const WHEEL_LINE_PX = 16

/** Pointer history older than this is ignored when measuring a flick. */
const DEFAULT_FLICK_WINDOW_MS = 90

/**
 * A flick shorter than this cannot have a meaningful velocity: dividing by a
 * sub-millisecond gap turns pointer jitter into a launch.
 */
const MIN_FLICK_INTERVAL_MS = 8

export interface GestureControllerOptions {
  /** The element pointer and wheel events are read from, normally the canvas. */
  readonly target: HTMLElement
  readonly camera: Camera
  /** Window over which a release velocity is measured, in milliseconds. */
  readonly flickWindowMs?: number
  /** Injectable clock, so the flick maths can be driven deterministically. */
  readonly now?: () => number
}

export class GestureController {
  /** Set false to hand input to a build tool without detaching listeners. */
  enabled = true

  /**
   * Whether a one-pointer drag pans.
   *
   * Set false while a build tool owns the world (PRD 6.3: "Drag with a tool
   * active = paint / drag-rectangle for that tool"). Pinch and two-finger pan
   * keep working, which is the whole reason this is a separate switch from
   * `enabled`: a player drawing a wall still has to be able to zoom out and
   * see where it is going, and taking the camera away entirely to draw a
   * rectangle would make building on a map larger than the screen impossible.
   *
   * The controller keeps tracking every pointer either way. It has to: a
   * pinch needs both contacts, and a controller that ignored the first one
   * would see a two-finger gesture as a one-finger gesture that teleported.
   */
  singlePointerPan = true

  readonly #target: HTMLElement
  readonly #camera: Camera
  readonly #flickWindowMs: number
  readonly #now: () => number

  readonly #pointers = new Map<number, TrackedPointer>()
  #samples: MotionSample[] = []

  /** Canvas-relative pointer coordinates need the canvas origin; cached. */
  #originX = 0
  #originY = 0

  #pinchStartDistance = 0
  #pinchStartZoom = 1
  #pinchCentroid: Vec2 = { x: 0, y: 0 }
  #wheelZoomAccumulator = 0
  #attached = false

  constructor(options: GestureControllerOptions) {
    this.#target = options.target
    this.#camera = options.camera
    this.#flickWindowMs = options.flickWindowMs ?? DEFAULT_FLICK_WINDOW_MS
    this.#now = options.now ?? ((): number => performance.now())
  }

  get attached(): boolean {
    return this.#attached
  }

  /** True while two pointers are down and driving a zoom. */
  get pinching(): boolean {
    return this.#pointers.size >= 2
  }

  attach(): void {
    if (this.#attached) return
    this.#attached = true

    // `touch-action: none` stops the webview claiming the gesture for its own
    // scrolling and zooming before we ever see a pointermove.
    this.#target.style.touchAction = 'none'

    this.#target.addEventListener('pointerdown', this.#onPointerDown)
    this.#target.addEventListener('pointermove', this.#onPointerMove)
    this.#target.addEventListener('pointerup', this.#onPointerUp)
    this.#target.addEventListener('pointercancel', this.#onPointerUp)
    this.#target.addEventListener('wheel', this.#onWheel, { passive: false })
  }

  detach(): void {
    if (!this.#attached) return
    this.#attached = false

    this.#target.removeEventListener('pointerdown', this.#onPointerDown)
    this.#target.removeEventListener('pointermove', this.#onPointerMove)
    this.#target.removeEventListener('pointerup', this.#onPointerUp)
    this.#target.removeEventListener('pointercancel', this.#onPointerUp)
    this.#target.removeEventListener('wheel', this.#onWheel)

    this.#pointers.clear()
    this.#samples = []
  }

  /**
   * Re-reads the canvas origin. Called at the start of every gesture, which
   * keeps `getBoundingClientRect` off the pointermove path where it would
   * force a layout on every frame of a drag.
   */
  #refreshOrigin(): void {
    const rect = this.#target.getBoundingClientRect()
    this.#originX = rect.left
    this.#originY = rect.top
  }

  #toLocal(event: { clientX: number; clientY: number }): Vec2 {
    return { x: event.clientX - this.#originX, y: event.clientY - this.#originY }
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    // Secondary mouse buttons belong to the context menu, not the camera.
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!this.enabled) return

    if (this.#pointers.size === 0) this.#refreshOrigin()
    this.#target.setPointerCapture(event.pointerId)

    const local = this.#toLocal(event)
    this.#pointers.set(event.pointerId, { x: local.x, y: local.y })

    // A new contact always cancels a coasting flick, so the world stops dead
    // under the finger rather than sliding out from under it.
    this.#camera.stopMomentum()
    this.#samples = [{ time: this.#now(), x: local.x, y: local.y }]

    if (this.#pointers.size === 2) this.#beginPinch()
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    const pointer = this.#pointers.get(event.pointerId)
    if (pointer === undefined) return

    const local = this.#toLocal(event)

    if (this.#pointers.size >= 2) {
      pointer.x = local.x
      pointer.y = local.y
      this.#updatePinch()
      return
    }

    const deltaX = local.x - pointer.x
    const deltaY = local.y - pointer.y
    pointer.x = local.x
    pointer.y = local.y

    if (this.enabled && this.singlePointerPan) this.#camera.dragByScreen(deltaX, deltaY)
    this.#recordSample(local)
  }

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (!this.#pointers.delete(event.pointerId)) return

    if (this.#target.hasPointerCapture(event.pointerId)) {
      this.#target.releasePointerCapture(event.pointerId)
    }

    if (this.#pointers.size === 1) {
      // A pinch lost a finger. Settle the zoom, then hand the survivor to the
      // drag path from a clean slate so the camera does not jump by the gap
      // between the centroid and the remaining contact.
      if (this.enabled) this.#camera.snapZoomToStop(this.#pinchCentroid)
      this.#samples = []
      return
    }

    if (this.#pointers.size === 0) {
      this.#releaseFlick()
    }
  }

  readonly #onWheel = (event: WheelEvent): void => {
    // Always prevented: an unhandled wheel scrolls or zooms the whole webview.
    event.preventDefault()
    if (!this.enabled) return

    this.#refreshOrigin()
    const scale = wheelDeltaScale(event, this.#target)

    // Mac reports a trackpad pinch, and cmd or ctrl plus wheel, the same way.
    if (event.ctrlKey || event.metaKey) {
      this.#wheelZoomAccumulator += event.deltaY * scale

      const steps = Math.trunc(this.#wheelZoomAccumulator / WHEEL_ZOOM_STEP)
      if (steps !== 0) {
        this.#wheelZoomAccumulator -= steps * WHEEL_ZOOM_STEP
        // Wheel down is positive and means zoom out, hence the negation.
        this.#camera.stepZoom(-steps, this.#toLocal(event))
      }
      return
    }

    this.#wheelZoomAccumulator = 0
    this.#camera.stopMomentum()
    this.#camera.panByScreen(event.deltaX * scale, event.deltaY * scale)
  }

  #beginPinch(): void {
    const [first, second] = [...this.#pointers.values()]
    if (first === undefined || second === undefined) return

    this.#pinchStartDistance = Math.hypot(second.x - first.x, second.y - first.y)
    this.#pinchStartZoom = this.#camera.zoom
    this.#pinchCentroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    this.#samples = []

    // Cancel any zoom still easing, or it would fight the fingers.
    this.#camera.settle()
  }

  #updatePinch(): void {
    if (!this.enabled) return

    const [first, second] = [...this.#pointers.values()]
    if (first === undefined || second === undefined) return

    const distance = Math.hypot(second.x - first.x, second.y - first.y)
    const centroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const previous = this.#pinchCentroid
    this.#pinchCentroid = centroid

    if (this.#pinchStartDistance > 0 && distance > 0) {
      // Pivot on where the centroid was, then translate it to where it is.
      // Doing it in that order is what makes a pinch that also moves feel like
      // the map is stuck to both fingers.
      this.#camera.setZoom(this.#pinchStartZoom * (distance / this.#pinchStartDistance), previous)
    }

    this.#camera.dragByScreen(centroid.x - previous.x, centroid.y - previous.y)
  }

  #recordSample(local: Vec2): void {
    const time = this.#now()
    this.#samples.push({ time, x: local.x, y: local.y })

    const oldest = time - this.#flickWindowMs
    let drop = 0
    while (drop < this.#samples.length - 2 && (this.#samples[drop]?.time ?? time) < oldest) {
      drop += 1
    }
    if (drop > 0) this.#samples = this.#samples.slice(drop)
  }

  #releaseFlick(): void {
    const samples = this.#samples
    this.#samples = []
    // A tool drag must not launch the camera when the finger leaves.
    if (!this.enabled || !this.singlePointerPan || samples.length < 2) return

    const first = samples[0]
    const last = samples[samples.length - 1]
    if (first === undefined || last === undefined) return

    const interval = last.time - first.time
    if (interval < MIN_FLICK_INTERVAL_MS) return

    this.#camera.flickByScreen((last.x - first.x) / interval, (last.y - first.y) / interval)
  }
}

/** Converts a wheel event's units into CSS pixels. */
function wheelDeltaScale(event: WheelEvent, target: HTMLElement): number {
  switch (event.deltaMode) {
    case 1:
      return WHEEL_LINE_PX
    case 2:
      return target.clientHeight
    default:
      return 1
  }
}
