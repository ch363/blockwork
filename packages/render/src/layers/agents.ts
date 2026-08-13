/**
 * Agents: layer 4 of PRD 7.6 — the people you can see.
 *
 * ## Why a sprite batch, not a mesh
 *
 * Agents move every frame and must y-sort so someone walking past a bed draws
 * in front of it. A texture-indexed mesh cannot reorder mid-draw; a sprite
 * container can, and Pixi's batcher still collapses every sprite that shares
 * the atlas into a single draw call — which is the T2.8 acceptance bar
 * (400 agents, one draw call, under 4ms).
 *
 * ## Two layers, one silhouette
 *
 * PRD 7.7: inmates are colour-coded by category via a **tint on the uniform
 * layer**, so one base sprite serves every category and staff role. The atlas
 * therefore holds greyscale body cells and greyscale uniform cells; the body
 * stays untinted and the uniform takes `RenderAgent.colour`.
 *
 * ## Interpolation lives here
 *
 * The sim publishes integer-tick snapshots; the display runs at 60fps. Positions
 * lerp between the previous and next snapshot so a 10-tick-per-minute step does
 * not teleport. Discrete fields (facing, frame, mood, selection) take from the
 * destination pose so animation never "half-frames" a walk cycle.
 *
 * ## Zoom LOD
 *
 * At the furthest stop (zoom 0.5) agents become 4 CSS-pixel coloured dots with
 * no walk animation, matching PRD 7.6. Mood pins and the selection ring stay
 * readable because they scale with the camera already.
 */

import { Container, Sprite } from 'pixi.js'

import {
  applyGrain,
  createSpriteCanvas,
  cssColour,
  greyColour,
  sliceAtlas,
  spriteAtlasFromCanvas,
  spriteHash,
} from '../sprites/atlas'
import type { SpriteAtlas } from '../sprites/atlas'
import { TILE_SIZE } from '../tiles'

import type { Camera } from '../camera/camera'
import type { Texture } from 'pixi.js'

/** Atlas cell edge in pixels. One tile of art at zoom 1. */
export const AGENT_ATLAS_CELL_PX = 32

/** World size of a full agent sprite (body + uniform stack). */
export const AGENT_SPRITE_WORLD = TILE_SIZE

/** Furthest zoom stop (PRD 2.3). At-or-below this, agents become dots. */
export const AGENT_DOT_ZOOM = 0.5

/** On-screen size of the LOD dot, in CSS pixels. */
export const AGENT_DOT_SCREEN_PX = 4

/** Walk cycle length. Spec: 4 directions × 4 walk frames. */
export const AGENT_WALK_FRAMES = 4

/**
 * Cardinal facings for the atlas rows, clockwise from south (toward the
 * camera). Snapshot `facing` values are expected in this range.
 */
export const AGENT_FACING = {
  SOUTH: 0,
  EAST: 1,
  NORTH: 2,
  WEST: 3,
} as const

export const AGENT_FACINGS = [
  AGENT_FACING.SOUTH,
  AGENT_FACING.EAST,
  AGENT_FACING.NORTH,
  AGENT_FACING.WEST,
] as const

export type AgentFacing = (typeof AGENT_FACINGS)[number]

/**
 * Presentation flags packed into `SnapshotEntity.flags` (16 bits).
 *
 *   bit 0     — selected
 *   bit 1     — idle (not walking; use the idle cell)
 *   bits 2..7 — mood need index + 1 (0 = no pin; 1..63 → need slot)
 */
export const AGENT_FLAG = {
  SELECTED: 1 << 0,
  IDLE: 1 << 1,
  MOOD_SHIFT: 2,
  MOOD_MASK: 0x3f,
} as const

/** `--accent` from `docs/04-ui-mockups.html`: selection ring. */
export const AGENT_SELECTION_COLOUR = 0xf0a93b

/** Staff-only legend blue from the mockup world canvas. */
export const STAFF_UNIFORM_COLOUR = 0x2f4f76

/**
 * Security-category uniform tints from the mockup `:root` tokens. Presentation
 * colours, not balance — the sim only ships a category index via `kind`.
 */
export const CATEGORY_UNIFORM_COLOURS: Readonly<Record<string, number>> = {
  minimum: 0x8b93a0,
  medium: 0xe08b3d,
  maximum: 0xd95151,
  supermax: 0x9b4dca,
  protective: 0x4c9be8,
  condemned: 0x1d222a,
}

/**
 * Need ids that have a dedicated mood-pin cell, in `needs.json` file order.
 * Index packing in `AGENT_FLAG` addresses this table; unknown ids fall back to
 * a hashed generic glyph.
 */
export const AGENT_MOOD_NEED_IDS = [
  'bladder',
  'sleep',
  'food',
  'hygiene',
  'clothing',
  'comfort',
  'exercise',
  'safety',
  'freedom',
  'family',
  'recreation',
  'environment',
  'privacy',
  'literacy',
  'spirituality',
  'narcotics',
  'alcohol',
  'warmth',
  'luxury',
] as const

export type AgentMoodNeedId = (typeof AGENT_MOOD_NEED_IDS)[number]

/** An agent pose as the renderer (and the interpolator) understands it. */
export interface RenderAgent {
  readonly id: number
  /** World x. Fractional after interpolation. */
  readonly x: number
  readonly y: number
  /** `AGENT_FACING` value 0..3. */
  readonly facing: number
  /** Walk-cycle frame 0..3. Ignored while `idle`. */
  readonly walkFrame: number
  readonly idle: boolean
  /** Uniform tint as `0xRRGGBB`. */
  readonly colour: number
  /**
   * Need id for the mood pin, or `null` when no need is high/critical.
   * The worst need's icon is the one the sim already chose.
   */
  readonly moodNeedId: string | null
  readonly selected: boolean
}

export interface AgentLayerOptions {
  readonly mapSize: number
  readonly atlas: SpriteAtlas
  /**
   * Looks up a mood-pin texture index for a need id. Defaults to the atlas's
   * built-in need row.
   */
  readonly moodCellFor?: (needId: string) => number
}

/** Packed-flag helpers so the worker and the renderer agree on the bits. */
export function packAgentFlags(options: {
  readonly selected?: boolean
  readonly idle?: boolean
  /** Index into `AGENT_MOOD_NEED_IDS`, or `null` / negative for none. */
  readonly moodNeedIndex?: number | null
}): number {
  let flags = 0
  if (options.selected === true) flags |= AGENT_FLAG.SELECTED
  if (options.idle === true) flags |= AGENT_FLAG.IDLE
  const mood = options.moodNeedIndex
  if (mood !== undefined && mood !== null && mood >= 0) {
    const slot = Math.min(AGENT_FLAG.MOOD_MASK, mood + 1)
    flags |= slot << AGENT_FLAG.MOOD_SHIFT
  }
  return flags
}

export function agentFlagsSelected(flags: number): boolean {
  return (flags & AGENT_FLAG.SELECTED) !== 0
}

export function agentFlagsIdle(flags: number): boolean {
  return (flags & AGENT_FLAG.IDLE) !== 0
}

/** Mood need index, or `-1` when the pin is off. */
export function agentFlagsMoodIndex(flags: number): number {
  const slot = (flags >> AGENT_FLAG.MOOD_SHIFT) & AGENT_FLAG.MOOD_MASK
  return slot === 0 ? -1 : slot - 1
}

export function moodNeedIdFromIndex(index: number): string | null {
  if (index < 0 || index >= AGENT_MOOD_NEED_IDS.length) return null
  // Bounded by the length check above.
  return AGENT_MOOD_NEED_IDS[index] as string
}

export function moodNeedIndexFromId(needId: string): number {
  const index = AGENT_MOOD_NEED_IDS.indexOf(needId as AgentMoodNeedId)
  return index
}

/** Uniform colour for a security category id, with a stable fallback. */
export function uniformColourForCategory(categoryId: string): number {
  const known = CATEGORY_UNIFORM_COLOURS[categoryId]
  if (known !== undefined) return known
  const hash = spriteHash(categoryId)
  const bases = [0x8b93a0, 0xe08b3d, 0xd95151, 0x9b4dca, 0x4c9be8] as const
  // Bounded by the tuple length.
  return bases[hash % bases.length] as number
}

/**
 * Atlas layout (row-major cells):
 *
 *   rows 0..3   body:   south / east / north / west × (walk0..3, idle)
 *   rows 4..7   uniform: same
 *   row  8      mood pins (one cell per `AGENT_MOOD_NEED_IDS` entry, then a
 *               generic fallback glyph)
 *   row  9      selection ring | LOD dot
 *
 * Columns are wide enough for every mood pin. Figure poses only use the first
 * five (`walk0..3` + idle); the rest of those rows stay empty.
 */
export const AGENT_ATLAS_FIGURE_COLUMNS = AGENT_WALK_FRAMES + 1
/** One cell per known need, plus a trailing generic glyph. */
export const AGENT_ATLAS_COLUMNS = AGENT_MOOD_NEED_IDS.length + 1
export const AGENT_ATLAS_BODY_ROWS = AGENT_FACINGS.length
export const AGENT_ATLAS_UNIFORM_ROW0 = AGENT_ATLAS_BODY_ROWS
export const AGENT_ATLAS_MOOD_ROW = AGENT_ATLAS_BODY_ROWS * 2
export const AGENT_ATLAS_CHROME_ROW = AGENT_ATLAS_MOOD_ROW + 1
export const AGENT_ATLAS_ROWS = AGENT_ATLAS_CHROME_ROW + 1

const IDLE_COLUMN = AGENT_WALK_FRAMES
const GENERIC_MOOD_COLUMN = AGENT_MOOD_NEED_IDS.length

function cellIndex(row: number, column: number): number {
  return row * AGENT_ATLAS_COLUMNS + column
}

/** Body-layer atlas cell for a facing + frame. */
export function agentBodyCell(facing: number, walkFrame: number, idle: boolean): number {
  const row = ((facing % AGENT_FACINGS.length) + AGENT_FACINGS.length) % AGENT_FACINGS.length
  const column = idle
    ? IDLE_COLUMN
    : ((walkFrame % AGENT_WALK_FRAMES) + AGENT_WALK_FRAMES) % AGENT_WALK_FRAMES
  return cellIndex(row, column)
}

/** Uniform-layer atlas cell — same pose as the body, one atlas block down. */
export function agentUniformCell(facing: number, walkFrame: number, idle: boolean): number {
  return agentBodyCell(facing, walkFrame, idle) + AGENT_ATLAS_BODY_ROWS * AGENT_ATLAS_COLUMNS
}

/** Mood-pin cell for a need id. Unknown ids land on the generic glyph. */
export function agentMoodCell(needId: string): number {
  const index = moodNeedIndexFromId(needId)
  const column = index >= 0 ? index : GENERIC_MOOD_COLUMN
  return cellIndex(AGENT_ATLAS_MOOD_ROW, column)
}

export function agentSelectionCell(): number {
  return cellIndex(AGENT_ATLAS_CHROME_ROW, 0)
}

export function agentDotCell(): number {
  return cellIndex(AGENT_ATLAS_CHROME_ROW, 1)
}

/** Depth key: world y, then id so two agents on a row stay stable. */
export function agentSortY(agent: Pick<RenderAgent, 'y' | 'id'>): number {
  return agent.y * 1000 + (agent.id % 1000)
}

/**
 * Linear interpolation of agent poses between two snapshots.
 *
 * Positions lerp. Discrete presentation fields (facing, walk frame, idle,
 * colour, mood, selection) come from `next` once `alpha > 0`, and from
 * `previous` at `alpha === 0`, so a frame never snaps halfway through a walk
 * cell and never holds a stale colour after the sim has moved on.
 *
 * Agents are matched by `id`. An id only in `previous` fades out by omission
 * once `alpha > 0`; an id only in `next` appears immediately (spawn).
 */
export function interpolateAgents(
  previous: readonly RenderAgent[],
  next: readonly RenderAgent[],
  alpha: number,
): RenderAgent[] {
  const t = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha
  const prevById = new Map<number, RenderAgent>()
  for (const agent of previous) prevById.set(agent.id, agent)

  const out: RenderAgent[] = []
  const seen = new Set<number>()

  for (const dest of next) {
    seen.add(dest.id)
    const src = prevById.get(dest.id)
    if (src === undefined || t === 1) {
      out.push(dest)
      continue
    }
    if (t === 0) {
      out.push(src)
      continue
    }
    out.push({
      id: dest.id,
      x: src.x + (dest.x - src.x) * t,
      y: src.y + (dest.y - src.y) * t,
      facing: dest.facing,
      walkFrame: dest.walkFrame,
      idle: dest.idle,
      colour: dest.colour,
      moodNeedId: dest.moodNeedId,
      selected: dest.selected,
    })
  }

  if (t === 0) {
    for (const src of previous) {
      if (!seen.has(src.id)) out.push(src)
    }
  }

  return out
}

/**
 * Builds the procedural agent atlas. Greyscale figures + tintable uniforms,
 * plus mood glyphs and chrome (selection ring, LOD dot).
 */
export function createAgentAtlas(cellPx: number = AGENT_ATLAS_CELL_PX): SpriteAtlas {
  if (!Number.isInteger(cellPx) || cellPx < 8) {
    throw new RangeError(`agent atlas cellPx must be an integer >= 8, received ${cellPx}`)
  }

  const { canvas, context } = createSpriteCanvas(
    AGENT_ATLAS_COLUMNS * cellPx,
    AGENT_ATLAS_ROWS * cellPx,
  )

  for (const facing of AGENT_FACINGS) {
    for (let frame = 0; frame < AGENT_WALK_FRAMES; frame += 1) {
      drawBody(context, facing, frame, false, cellPx)
      drawUniform(context, facing, frame, false, cellPx)
    }
    drawBody(context, facing, 0, true, cellPx)
    drawUniform(context, facing, 0, true, cellPx)
  }

  for (let i = 0; i < AGENT_MOOD_NEED_IDS.length; i += 1) {
    // Bounded by the loop against the tuple length.
    const needId = AGENT_MOOD_NEED_IDS[i] as string
    drawMoodIcon(context, i, needId, cellPx)
  }
  drawMoodIcon(context, GENERIC_MOOD_COLUMN, 'generic', cellPx)

  drawSelectionRing(context, cellPx)
  drawLodDot(context, cellPx)

  return spriteAtlasFromCanvas(canvas, {
    cellPx,
    columns: AGENT_ATLAS_COLUMNS,
    rows: AGENT_ATLAS_ROWS,
    label: 'blockwork-agents',
  })
}

function cellOrigin(row: number, column: number, cellPx: number): { x: number; y: number } {
  return { x: column * cellPx, y: row * cellPx }
}

function drawBody(
  context: CanvasRenderingContext2D,
  facing: number,
  walkFrame: number,
  idle: boolean,
  cellPx: number,
): void {
  const column = idle ? IDLE_COLUMN : walkFrame
  const { x, y } = cellOrigin(facing, column, cellPx)
  const cx = x + cellPx / 2
  const headR = cellPx * 0.16
  const stride = idle ? 0 : ((walkFrame % 2) * 2 - 1) * cellPx * 0.04

  // Head
  context.fillStyle = greyColour(220)
  context.beginPath()
  context.arc(cx, y + cellPx * 0.28, headR, 0, Math.PI * 2)
  context.fill()

  // Legs — a tiny stride so the walk cycle reads at a glance.
  context.strokeStyle = greyColour(180)
  context.lineWidth = Math.max(1.5, cellPx * 0.06)
  context.lineCap = 'round'
  const hipY = y + cellPx * 0.72
  const footY = y + cellPx * 0.92
  context.beginPath()
  context.moveTo(cx - cellPx * 0.06, hipY)
  context.lineTo(cx - cellPx * 0.06 + (facing === AGENT_FACING.EAST ? stride : -stride), footY)
  context.moveTo(cx + cellPx * 0.06, hipY)
  context.lineTo(cx + cellPx * 0.06 + (facing === AGENT_FACING.WEST ? stride : stride), footY)
  context.stroke()

  // Facing cue: a darker nose mark on the facing edge of the head.
  context.fillStyle = greyColour(150)
  const nose = noseOffset(facing, headR * 0.7)
  context.beginPath()
  context.arc(cx + nose.x, y + cellPx * 0.28 + nose.y, headR * 0.28, 0, Math.PI * 2)
  context.fill()

  applyGrain(context, x, y, cellPx, cellPx, 0.06)
}

function drawUniform(
  context: CanvasRenderingContext2D,
  facing: number,
  walkFrame: number,
  idle: boolean,
  cellPx: number,
): void {
  const column = idle ? IDLE_COLUMN : walkFrame
  const { x, y } = cellOrigin(AGENT_ATLAS_UNIFORM_ROW0 + facing, column, cellPx)
  const cx = x + cellPx / 2
  const sway = idle ? 0 : Math.sin(walkFrame * 1.2) * cellPx * 0.02

  // Torso block — the tintable uniform. Arms suggest facing without a second
  // colour so one silhouette still serves every category.
  context.fillStyle = greyColour(200)
  const torsoW = cellPx * 0.42
  const torsoH = cellPx * 0.34
  context.fillRect(cx - torsoW / 2 + sway, y + cellPx * 0.38, torsoW, torsoH)

  context.fillStyle = greyColour(170)
  const armY = y + cellPx * 0.42
  const armH = cellPx * 0.22
  if (facing === AGENT_FACING.EAST) {
    context.fillRect(cx + torsoW / 2 + sway, armY, cellPx * 0.14, armH)
  } else if (facing === AGENT_FACING.WEST) {
    context.fillRect(cx - torsoW / 2 - cellPx * 0.14 + sway, armY, cellPx * 0.14, armH)
  } else {
    context.fillRect(cx - torsoW / 2 - cellPx * 0.08 + sway, armY, cellPx * 0.08, armH)
    context.fillRect(cx + torsoW / 2 + sway, armY, cellPx * 0.08, armH)
  }

  applyGrain(context, x, y, cellPx, cellPx, 0.05)
}

function noseOffset(facing: number, radius: number): { x: number; y: number } {
  switch (facing) {
    case AGENT_FACING.EAST:
      return { x: radius, y: 0 }
    case AGENT_FACING.WEST:
      return { x: -radius, y: 0 }
    case AGENT_FACING.NORTH:
      return { x: 0, y: -radius }
    default:
      return { x: 0, y: radius }
  }
}

function drawMoodIcon(
  context: CanvasRenderingContext2D,
  column: number,
  needId: string,
  cellPx: number,
): void {
  const { x, y } = cellOrigin(AGENT_ATLAS_MOOD_ROW, column, cellPx)
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  const r = cellPx * 0.28

  // Soft disc backing so the pin reads over any terrain.
  context.fillStyle = cssColour(0x1a1f27, 0.92)
  context.beginPath()
  context.arc(cx, cy, r, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = cssColour(0x39424f, 1)
  context.lineWidth = Math.max(1, cellPx * 0.04)
  context.stroke()

  context.fillStyle = cssColour(0xe05c5c, 1)
  context.strokeStyle = cssColour(0xe05c5c, 1)
  context.lineWidth = Math.max(1.5, cellPx * 0.06)
  context.lineCap = 'round'

  switch (needId) {
    case 'food':
      // Bowl
      context.beginPath()
      context.arc(cx, cy + r * 0.1, r * 0.45, 0, Math.PI, false)
      context.fill()
      break
    case 'sleep':
      // Crescent
      context.beginPath()
      context.arc(cx, cy, r * 0.4, -0.4, Math.PI * 0.8)
      context.stroke()
      break
    case 'bladder':
    case 'hygiene':
      // Drop
      context.beginPath()
      context.moveTo(cx, cy - r * 0.45)
      context.quadraticCurveTo(cx + r * 0.4, cy, cx, cy + r * 0.4)
      context.quadraticCurveTo(cx - r * 0.4, cy, cx, cy - r * 0.45)
      context.fill()
      break
    case 'safety':
      // Warning triangle
      context.beginPath()
      context.moveTo(cx, cy - r * 0.45)
      context.lineTo(cx + r * 0.45, cy + r * 0.35)
      context.lineTo(cx - r * 0.45, cy + r * 0.35)
      context.closePath()
      context.stroke()
      break
    case 'warmth':
      // Flame-ish V
      context.beginPath()
      context.moveTo(cx, cy + r * 0.35)
      context.lineTo(cx - r * 0.25, cy - r * 0.1)
      context.lineTo(cx, cy - r * 0.4)
      context.lineTo(cx + r * 0.25, cy - r * 0.1)
      context.closePath()
      context.fill()
      break
    default: {
      // Exclamation — generic "need attention"
      context.fillRect(cx - cellPx * 0.04, cy - r * 0.4, cellPx * 0.08, r * 0.55)
      context.beginPath()
      context.arc(cx, cy + r * 0.35, cellPx * 0.05, 0, Math.PI * 2)
      context.fill()
      break
    }
  }
}

function drawSelectionRing(context: CanvasRenderingContext2D, cellPx: number): void {
  const { x, y } = cellOrigin(AGENT_ATLAS_CHROME_ROW, 0, cellPx)
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  context.strokeStyle = cssColour(AGENT_SELECTION_COLOUR, 1)
  context.lineWidth = Math.max(2, cellPx * 0.08)
  context.beginPath()
  context.arc(cx, cy, cellPx * 0.38, 0, Math.PI * 2)
  context.stroke()
  context.strokeStyle = cssColour(AGENT_SELECTION_COLOUR, 0.35)
  context.lineWidth = Math.max(3, cellPx * 0.12)
  context.beginPath()
  context.arc(cx, cy, cellPx * 0.38, 0, Math.PI * 2)
  context.stroke()
}

function drawLodDot(context: CanvasRenderingContext2D, cellPx: number): void {
  const { x, y } = cellOrigin(AGENT_ATLAS_CHROME_ROW, 1, cellPx)
  const cx = x + cellPx / 2
  const cy = y + cellPx / 2
  context.fillStyle = greyColour(255)
  context.beginPath()
  context.arc(cx, cy, cellPx * 0.28, 0, Math.PI * 2)
  context.fill()
}

interface AgentSprites {
  body: Sprite
  uniform: Sprite
  mood: Sprite
  selection: Sprite
  dot: Sprite
}

/**
 * PRD 7.5 sprite pool ceiling. At 400 agents × 5 sprites, we cap at 2000
 * sprites per set (active + pooled). Beyond this the pool stops growing and
 * the oldest pooled sprites are not returned.
 */
export const AGENT_SPRITE_POOL_CEILING = 2000

/**
 * Draws every agent: body + tinted uniform, optional mood pin, optional
 * selection ring; at zoom ≤ 0.5, a coloured 4px dot instead.
 *
 * T8.19: uses a sprite pool with a ceiling to avoid unbounded allocation.
 * Sprites are returned to the pool when agents leave, then reused when new
 * agents arrive, avoiding per-frame `new Sprite()` calls.
 */
export class AgentLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #atlas: SpriteAtlas
  readonly #textures: readonly Texture[]
  readonly #moodCellFor: (needId: string) => number
  readonly #figures: Container
  readonly #agents = new Map<number, RenderAgent>()
  readonly #sprites = new Map<number, AgentSprites>()

  /**
   * T8.19: pool of recyclable sprite sets. FIFO: oldest pooled sets are
   * reused first, and dropped silently when the pool reaches its ceiling.
   */
  readonly #pool: AgentSprites[] = []

  #dotMode = false

  constructor(options: AgentLayerOptions) {
    const { mapSize, atlas } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.#atlas = atlas
    this.#textures = sliceAtlas(atlas)
    this.#moodCellFor = options.moodCellFor ?? agentMoodCell

    this.container = new Container({ label: 'agents' })
    this.#figures = new Container({ label: 'agent-figures', sortableChildren: true })
    this.container.addChild(this.#figures)
  }

  get agentCount(): number {
    return this.#agents.size
  }

  get dotMode(): boolean {
    return this.#dotMode
  }

  /** Replaces the whole set, for a fresh world or a loaded save. */
  setAgents(agents: Iterable<RenderAgent>): void {
    for (const id of [...this.#sprites.keys()]) {
      this.#destroySprites(id)
    }
    this.#agents.clear()
    for (const agent of agents) {
      this.#agents.set(agent.id, agent)
      this.#place(agent)
    }
  }

  /** Adds or replaces one agent. */
  setAgent(agent: RenderAgent): void {
    this.#agents.set(agent.id, agent)
    this.#place(agent)
  }

  removeAgent(id: number): void {
    if (!this.#agents.delete(id)) return
    this.#destroySprites(id)
  }

  /**
   * Cull / LOD pass. Call every frame after the camera has updated. Agent
   * poses themselves are pushed via `setAgents` / `setAgent` from the
   * interpolator — this only flips the zoom LOD.
   */
  update(camera: Camera): void {
    const nextDot = camera.zoom <= AGENT_DOT_ZOOM
    if (nextDot === this.#dotMode) return
    this.#dotMode = nextDot
    for (const agent of this.#agents.values()) {
      this.#place(agent)
    }
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const texture of this.#textures) {
      texture.destroy(false)
    }
    this.#atlas.destroy()
    this.#agents.clear()
    this.#sprites.clear()
  }

  #place(agent: RenderAgent): void {
    let sprites = this.#sprites.get(agent.id)
    if (sprites === undefined) {
      sprites = this.#createSprites(agent.id)
      this.#sprites.set(agent.id, sprites)
    }

    const sort = agentSortY(agent)
    const bodyTexture = this.#textures[agentBodyCell(agent.facing, agent.walkFrame, agent.idle)]
    const uniformTexture =
      this.#textures[agentUniformCell(agent.facing, agent.walkFrame, agent.idle)]
    const dotTexture = this.#textures[agentDotCell()]
    const selectionTexture = this.#textures[agentSelectionCell()]

    if (bodyTexture === undefined || uniformTexture === undefined || dotTexture === undefined) {
      return
    }

    if (this.#dotMode) {
      sprites.body.visible = false
      sprites.uniform.visible = false
      sprites.mood.visible = false
      sprites.selection.visible = false
      sprites.dot.visible = true
      sprites.dot.texture = dotTexture
      sprites.dot.tint = agent.colour
      const worldSize = AGENT_DOT_SCREEN_PX / AGENT_DOT_ZOOM
      sprites.dot.setSize(worldSize, worldSize)
      sprites.dot.position.set(agent.x, agent.y)
      sprites.dot.zIndex = sort
      return
    }

    sprites.dot.visible = false
    sprites.body.visible = true
    sprites.uniform.visible = true

    sprites.body.texture = bodyTexture
    sprites.uniform.texture = uniformTexture
    sprites.body.setSize(AGENT_SPRITE_WORLD, AGENT_SPRITE_WORLD)
    sprites.uniform.setSize(AGENT_SPRITE_WORLD, AGENT_SPRITE_WORLD)
    sprites.body.tint = 0xffffff
    sprites.uniform.tint = agent.colour
    sprites.body.position.set(agent.x, agent.y)
    sprites.uniform.position.set(agent.x, agent.y)
    sprites.body.zIndex = sort * 4
    sprites.uniform.zIndex = sort * 4 + 1

    if (agent.moodNeedId !== null) {
      const moodTexture = this.#textures[this.#moodCellFor(agent.moodNeedId)]
      if (moodTexture !== undefined) {
        sprites.mood.visible = true
        sprites.mood.texture = moodTexture
        const moodSize = AGENT_SPRITE_WORLD * 0.45
        sprites.mood.setSize(moodSize, moodSize)
        sprites.mood.position.set(agent.x, agent.y - AGENT_SPRITE_WORLD * 0.55)
        sprites.mood.zIndex = sort * 4 + 2
      } else {
        sprites.mood.visible = false
      }
    } else {
      sprites.mood.visible = false
    }

    if (agent.selected && selectionTexture !== undefined) {
      sprites.selection.visible = true
      sprites.selection.texture = selectionTexture
      sprites.selection.tint = AGENT_SELECTION_COLOUR
      const ringSize = AGENT_SPRITE_WORLD * 1.15
      sprites.selection.setSize(ringSize, ringSize)
      sprites.selection.position.set(agent.x, agent.y)
      sprites.selection.zIndex = sort * 4 + 3
    } else {
      sprites.selection.visible = false
    }
  }

  /**
   * T8.19: acquires a sprite set from the pool or creates a fresh one.
   * When the pool is non-empty, the oldest set is reused (FIFO), which
   * avoids per-frame Sprite construction. Fresh sprites are only created
   * when the pool is exhausted.
   */
  #createSprites(id: number): AgentSprites {
    const pooled = this.#pool.shift()
    if (pooled !== undefined) {
      for (const sprite of Object.values(pooled)) {
        sprite.visible = false
      }
      return pooled
    }

    const label = String(id)
    const body = new Sprite({ label: `agent-body-${label}` })
    const uniform = new Sprite({ label: `agent-uniform-${label}` })
    const mood = new Sprite({ label: `agent-mood-${label}` })
    const selection = new Sprite({ label: `agent-sel-${label}` })
    const dot = new Sprite({ label: `agent-dot-${label}` })

    for (const sprite of [body, uniform, mood, selection, dot]) {
      sprite.anchor.set(0.5, 0.5)
      sprite.visible = false
      this.#figures.addChild(sprite)
    }

    return { body, uniform, mood, selection, dot }
  }

  /**
   * T8.19: returns sprites to the pool for reuse. Sprites are hidden but
   * remain children of the figures container. When the pool is at its
   * ceiling, excess sprites are silently dropped (destroyed).
   */
  #destroySprites(id: number): void {
    const sprites = this.#sprites.get(id)
    if (sprites === undefined) return
    this.#sprites.delete(id)

    for (const sprite of Object.values(sprites)) {
      sprite.visible = false
    }

    const totalActive = this.#sprites.size * 5
    const currentPool = this.#pool.length * 5
    if (totalActive + currentPool < AGENT_SPRITE_POOL_CEILING) {
      this.#pool.push(sprites)
    } else {
      for (const sprite of Object.values(sprites)) {
        this.#figures.removeChild(sprite)
        sprite.destroy()
      }
    }
  }

  /** T8.19: current pool depth for diagnostics. */
  get poolSize(): number {
    return this.#pool.length
  }
}
