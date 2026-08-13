/**
 * Objects: layer 3 of PRD 7.6, the furniture and machines that turn a room
 * into a room.
 *
 * ## Why sprites, not another mesh
 *
 * Objects are sparse relative to tiles — a built prison has thousands, not
 * tens of thousands — and they need **y-sorting** so a bed in front of a
 * locker draws over it. A texture-indexed mesh cannot reorder mid-draw; a
 * sprite container can, and Pixi's batcher still collapses every sprite that
 * shares the atlas into a single draw call.
 *
 * ## Sort within the chunk, not across the map
 *
 * T1.6 is explicit: objects are y-sorted **within their chunk**. A global
 * sort would thrash the display list every time anything moved; a per-chunk
 * sort only touches the objects that share a 32x32 block, which is the same
 * locality the dirty tracker already uses.
 *
 * The sort key is the object's **bottom tile**, not its anchor. A 2x1 cooker
 * and a 1x1 toilet that share a row must paint in the same order whether the
 * cooker's anchor is the left tile or the right one after a rotation, and
 * only the southern edge of the footprint is stable under that.
 *
 * ## Placeholder art
 *
 * One greyscale silhouette per footprint class, tinted per definition id.
 * PRD 7.7 allows this through Phase 6; generating it keeps the repository
 * free of anyone else's assets (CLAUDE.md rule 1).
 */

import { Container, Sprite } from 'pixi.js'

import {
  applyGrain,
  createSpriteCanvas,
  greyColour,
  sliceAtlas,
  spriteAtlasFromCanvas,
  spriteHash,
} from '../sprites/atlas'
import type { SpriteAtlas } from '../sprites/atlas'
import { swatchColour } from '../sprites/palette'
import { TILE_SIZE } from '../tiles'

import { TERRAIN_CHUNK_TILES, TERRAIN_CHUNK_WORLD } from './terrain'

import type { Camera, WorldRect } from '../camera/camera'
import type { Texture } from 'pixi.js'

/** Atlas cell edge in pixels: one tile of art at zoom 1. */
export const OBJECT_ATLAS_CELL_PX = 32

/**
 * Footprint classes the placeholder atlas knows how to draw.
 *
 * Anything larger than 2x2 falls back to `large`, which is a 3x3 cell drawn
 * scaled to the footprint. Real art will replace the class with a per-
 * definition sprite; the class only exists so the placeholder set stays small.
 */
export const OBJECT_SHAPES = ['square', 'wide', 'tall', 'block', 'large', 'fixture'] as const
export type ObjectShape = (typeof OBJECT_SHAPES)[number]

/** How a definition looks while the real art is still placeholder. */
export interface ObjectAppearance {
  /** Tint as `0xRRGGBB`, applied to the greyscale silhouette. */
  readonly colour: number
  readonly shape: ObjectShape
}

/**
 * The last of the placeholder table (T6.6).
 *
 * Every definition now carries an `appearance` in `objects.json`, so the live
 * game never reaches this: `appearanceFromDef` resolves the swatch and shape
 * the content author chose. What remains is a fallback for a caller that has
 * no `GameData` to hand — a unit test of the layer itself, most of the time.
 *
 * @deprecated Prefer `appearanceFromDef`. Kept so a data-free render still
 * draws something recognisable rather than a screen of identical squares.
 */
export const PLACEHOLDER_OBJECT_APPEARANCES: Readonly<Record<string, ObjectAppearance>> = {
  bed: { colour: 0x8fa0b5, shape: 'wide' },
  bunk_bed: { colour: 0x7f91a8, shape: 'wide' },
  comfort_bed: { colour: 0x9aabbe, shape: 'wide' },
  toilet: { colour: 0xb7c4d2, shape: 'fixture' },
  sink: { colour: 0xa8b8c6, shape: 'fixture' },
  shower: { colour: 0x7fb2c4, shape: 'fixture' },
  shower_head: { colour: 0x7fb2c4, shape: 'fixture' },
  table: { colour: 0x8a6a46, shape: 'wide' },
  bench: { colour: 0x8a6a46, shape: 'wide' },
  chair: { colour: 0x7a5a3c, shape: 'square' },
  cooker: { colour: 0x9aa7b6, shape: 'wide' },
  fridge: { colour: 0x9aa7b6, shape: 'tall' },
  freezer: { colour: 0x8a97a6, shape: 'block' },
  serving_table: { colour: 0xc9a24b, shape: 'wide' },
  bookshelf: { colour: 0x6e5a3e, shape: 'wide' },
  desk: { colour: 0x8a6a46, shape: 'wide' },
  workshop_saw: { colour: 0x9aa7b6, shape: 'block' },
  weight_bench: { colour: 0x5e7a62, shape: 'wide' },
}

/** An object as the renderer needs it. */
export interface RenderObject {
  /** Entity id; the layer's key. */
  readonly id: number
  readonly defId: string
  /** Anchor tile, top-left of the footprint (matches `objectFootprint`). */
  readonly tileX: number
  readonly tileY: number
  /** Footprint in tiles after rotation. */
  readonly width: number
  readonly height: number
  /**
   * Degrees clockwise. Presentation only: the sim owns placement geometry;
   * this rotates the sprite so a 2x1 cooker looks turned.
   */
  readonly rotation: number
}

export interface ObjectLayerOptions {
  readonly mapSize: number
  readonly atlas: SpriteAtlas
  /**
   * Looks up an appearance for a definition id. Defaults to the placeholder
   * table plus a hash-derived fallback.
   */
  readonly appearanceFor?: (defId: string) => ObjectAppearance
}

/**
 * Picks a silhouette for a footprint. Wide and tall are distinguished so a
 * rotated 2x1 does not look like a 1x2 of a different kind.
 */
export function objectShapeForSize(width: number, height: number): ObjectShape {
  if (width <= 1 && height <= 1) return 'square'
  if (width === 2 && height === 1) return 'wide'
  if (width === 1 && height === 2) return 'tall'
  if (width === 2 && height === 2) return 'block'
  return 'large'
}

/** A stable placeholder colour from a definition id. */
export function objectColourForId(defId: string): number {
  const hash = spriteHash(defId)
  // Kept in the muted institutional range of the mockup palette.
  const hueBand = hash % 5
  const bases = [0x8fa0b5, 0x9aa7b6, 0x8a6a46, 0x7fb2c4, 0x6e7a88] as const
  // Bounded by the tuple length.
  return bases[hueBand] as number
}

export function defaultObjectAppearance(defId: string): ObjectAppearance {
  const known = PLACEHOLDER_OBJECT_APPEARANCES[defId]
  if (known !== undefined) return known
  return { colour: objectColourForId(defId), shape: 'square' }
}

/**
 * The appearance a definition actually declares (T6.6).
 *
 * This is the live path. Colour comes from the palette by swatch name, so the
 * whole game re-tints from one table; shape falls back to the footprint class,
 * because a 2×1 that forgot to say `wide` is still obviously wide.
 */
export function appearanceFromDef(def: {
  readonly size?: { readonly w: number; readonly h: number } | undefined
  readonly appearance?:
    | { readonly swatch: string; readonly shape?: string | undefined }
    | undefined
}): ObjectAppearance {
  const declared = def.appearance
  const width = def.size?.w ?? 1
  const height = def.size?.h ?? 1
  if (declared === undefined) {
    return { colour: swatchColour('concrete'), shape: objectShapeForSize(width, height) }
  }
  const shape = declared.shape
  return {
    colour: swatchColour(declared.swatch),
    shape:
      shape !== undefined && isObjectShape(shape)
        ? shape
        : objectShapeForSize(width, height),
  }
}

function isObjectShape(value: string): value is ObjectShape {
  return (OBJECT_SHAPES as readonly string[]).includes(value)
}

/**
 * Builds the lookup the layer takes, from the loaded definitions.
 *
 * A map rather than a closure over `GameData` so the render package keeps its
 * one-way dependency: it is handed colours and shapes, never a data loader.
 */
export function objectAppearances(
  defs: Iterable<{
    readonly id: string
    readonly size?: { readonly w: number; readonly h: number } | undefined
    readonly appearance?:
      | { readonly swatch: string; readonly shape?: string | undefined }
      | undefined
  }>,
): Map<string, ObjectAppearance> {
  const table = new Map<string, ObjectAppearance>()
  for (const def of defs) table.set(def.id, appearanceFromDef(def))
  return table
}

/**
 * Draws the six placeholder silhouettes into a single-row atlas.
 *
 * Greyscale on purpose: each sprite is tinted at draw time, so one cell serves
 * every definition that shares a footprint class.
 */
export function createObjectAtlas(cellPx: number = OBJECT_ATLAS_CELL_PX): SpriteAtlas {
  if (!Number.isInteger(cellPx) || cellPx < 8) {
    throw new RangeError(`object atlas cellPx must be an integer >= 8, received ${cellPx}`)
  }

  const columns = OBJECT_SHAPES.length
  const rows = 1
  const { canvas, context } = createSpriteCanvas(columns * cellPx, rows * cellPx)
  const pad = Math.max(2, Math.round(cellPx * 0.12))

  for (const [index, shape] of OBJECT_SHAPES.entries()) {
    const originX = index * cellPx
    context.fillStyle = greyColour(210)

    switch (shape) {
      case 'square':
        context.fillRect(originX + pad, pad, cellPx - pad * 2, cellPx - pad * 2)
        break
      case 'wide':
        context.fillRect(originX + pad, pad + cellPx * 0.28, cellPx - pad * 2, cellPx * 0.44)
        break
      case 'tall':
        context.fillRect(originX + pad + cellPx * 0.28, pad, cellPx * 0.44, cellPx - pad * 2)
        break
      case 'block':
        context.fillRect(originX + pad, pad, cellPx - pad * 2, cellPx - pad * 2)
        context.fillStyle = greyColour(170)
        context.fillRect(
          originX + pad + cellPx * 0.15,
          pad + cellPx * 0.15,
          cellPx * 0.35,
          cellPx * 0.35,
        )
        break
      case 'large':
        context.fillRect(originX + pad * 0.5, pad * 0.5, cellPx - pad, cellPx - pad)
        break
      case 'fixture': {
        const radius = (cellPx - pad * 2) / 2
        context.beginPath()
        context.arc(originX + cellPx / 2, cellPx / 2, radius, 0, Math.PI * 2)
        context.fill()
        break
      }
    }

    applyGrain(context, originX, 0, cellPx, cellPx, 0.08)
  }

  return spriteAtlasFromCanvas(canvas, {
    cellPx,
    columns,
    rows,
    label: 'blockwork-objects',
  })
}

/** Chunk a bottom-tile coordinate falls in. */
function chunkOf(tileX: number, tileY: number, chunksPerAxis: number): number {
  const column = Math.floor(tileX / TERRAIN_CHUNK_TILES)
  const row = Math.floor(tileY / TERRAIN_CHUNK_TILES)
  return row * chunksPerAxis + column
}

/**
 * Sort key for depth: bottom edge of the footprint in world units, then the
 * left edge as a tie-break so two objects on the same row stay stable.
 */
export function objectSortY(object: RenderObject): number {
  return (object.tileY + object.height) * TILE_SIZE + object.tileX * 0.001
}

export class ObjectLayer {
  readonly container: Container
  readonly mapSize: number
  readonly chunksPerAxis: number

  readonly #atlas: SpriteAtlas
  readonly #textures: readonly Texture[]
  readonly #appearanceFor: (defId: string) => ObjectAppearance
  readonly #chunks: Container[]
  readonly #objects = new Map<number, RenderObject>()
  readonly #sprites = new Map<number, Sprite>()
  readonly #chunkOfObject = new Map<number, number>()

  #visibleChunkCount = 0
  #visibleObjectCount = 0
  #range: { firstColumn: number; firstRow: number; lastColumn: number; lastRow: number } | null =
    null

  constructor(options: ObjectLayerOptions) {
    const { mapSize, atlas } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.chunksPerAxis = Math.ceil(mapSize / TERRAIN_CHUNK_TILES)
    this.#atlas = atlas
    this.#textures = sliceAtlas(atlas)
    this.#appearanceFor = options.appearanceFor ?? defaultObjectAppearance

    this.container = new Container({ label: 'objects' })
    this.#chunks = []

    for (let row = 0; row < this.chunksPerAxis; row += 1) {
      for (let column = 0; column < this.chunksPerAxis; column += 1) {
        const chunk = new Container({
          label: `objects-${String(column)}-${String(row)}`,
          sortableChildren: true,
        })
        chunk.visible = false
        this.#chunks.push(chunk)
        this.container.addChild(chunk)
      }
    }
  }

  get objectCount(): number {
    return this.#objects.size
  }

  get visibleChunkCount(): number {
    return this.#visibleChunkCount
  }

  get visibleObjectCount(): number {
    return this.#visibleObjectCount
  }

  /** Replaces the whole set, for a fresh world or a loaded save. */
  setObjects(objects: Iterable<RenderObject>): void {
    for (const id of [...this.#sprites.keys()]) {
      this.#destroySprite(id)
    }
    this.#objects.clear()
    for (const object of objects) {
      this.#objects.set(object.id, object)
      this.#placeSprite(object)
    }
    this.#range = null
  }

  /** Adds or replaces one object. */
  setObject(object: RenderObject): void {
    const previous = this.#objects.get(object.id)
    if (previous !== undefined) {
      const previousChunk = this.#chunkOfObject.get(object.id)
      const nextChunk = this.#objectChunk(object)
      if (previousChunk !== nextChunk) {
        this.#destroySprite(object.id)
      }
    }
    this.#objects.set(object.id, object)
    this.#placeSprite(object)
    this.#range = null
  }

  removeObject(id: number): void {
    if (!this.#objects.delete(id)) return
    this.#destroySprite(id)
    this.#range = null
  }

  update(camera: Camera): void {
    this.#cull(camera.visibleRect())
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const texture of this.#textures) {
      texture.destroy(false)
    }
    this.#atlas.destroy()
    this.#objects.clear()
    this.#sprites.clear()
    this.#chunkOfObject.clear()
  }

  #objectChunk(object: RenderObject): number {
    // Bottom-right-ish tile of the footprint: the southern edge decides the
    // chunk, matching the sort key, so a multi-tile object that straddles a
    // chunk boundary is owned by the chunk that paints it in front.
    const bottomY = object.tileY + object.height - 1
    const midX = object.tileX + Math.floor((object.width - 1) / 2)
    return chunkOf(
      Math.min(this.mapSize - 1, Math.max(0, midX)),
      Math.min(this.mapSize - 1, Math.max(0, bottomY)),
      this.chunksPerAxis,
    )
  }

  #placeSprite(object: RenderObject): void {
    const appearance = this.#appearanceFor(object.defId)
    // Footprint is already rotated by the sim (`objectFootprint`). Multi-tile
    // silhouettes follow the occupied tiles; 1x1 fixtures keep their round
    // placeholder so a toilet does not look like a stool.
    const shape =
      object.width === 1 && object.height === 1
        ? appearance.shape
        : objectShapeForSize(object.width, object.height)
    const cell = OBJECT_SHAPES.indexOf(shape)
    const texture = this.#textures[cell]
    if (texture === undefined) return

    const chunkIndex = this.#objectChunk(object)
    const chunk = this.#chunks[chunkIndex]
    if (chunk === undefined) return

    let sprite = this.#sprites.get(object.id)
    if (sprite === undefined) {
      sprite = new Sprite({ texture, label: `object-${String(object.id)}` })
      sprite.anchor.set(0.5, 0.5)
      this.#sprites.set(object.id, sprite)
      chunk.addChild(sprite)
    } else {
      const previousChunk = this.#chunkOfObject.get(object.id)
      if (previousChunk !== undefined && previousChunk !== chunkIndex) {
        const old = this.#chunks[previousChunk]
        old?.removeChild(sprite)
        chunk.addChild(sprite)
      }
      sprite.texture = texture
    }

    this.#chunkOfObject.set(object.id, chunkIndex)

    const worldWidth = object.width * TILE_SIZE
    const worldHeight = object.height * TILE_SIZE
    sprite.setSize(worldWidth, worldHeight)
    sprite.tint = appearance.colour
    // Rotation is already baked into width/height; spinning again would shear
    // a cooker that the sim has already turned into a 1x2 footprint.
    sprite.rotation = 0
    sprite.position.set(
      object.tileX * TILE_SIZE + worldWidth / 2,
      object.tileY * TILE_SIZE + worldHeight / 2,
    )
    sprite.zIndex = objectSortY(object)
  }

  #destroySprite(id: number): void {
    const sprite = this.#sprites.get(id)
    if (sprite === undefined) return
    this.#sprites.delete(id)
    const chunkIndex = this.#chunkOfObject.get(id)
    this.#chunkOfObject.delete(id)
    if (chunkIndex !== undefined) {
      this.#chunks[chunkIndex]?.removeChild(sprite)
    }
    sprite.destroy()
  }

  #cull(rect: WorldRect): void {
    const firstColumn = Math.max(0, Math.floor(rect.left / TERRAIN_CHUNK_WORLD))
    const lastColumn = Math.min(
      this.chunksPerAxis - 1,
      Math.floor(rect.right / TERRAIN_CHUNK_WORLD),
    )
    const firstRow = Math.max(0, Math.floor(rect.top / TERRAIN_CHUNK_WORLD))
    const lastRow = Math.min(this.chunksPerAxis - 1, Math.floor(rect.bottom / TERRAIN_CHUNK_WORLD))

    if (
      this.#range !== null &&
      this.#range.firstColumn === firstColumn &&
      this.#range.lastColumn === lastColumn &&
      this.#range.firstRow === firstRow &&
      this.#range.lastRow === lastRow
    ) {
      return
    }

    this.#range = { firstColumn, firstRow, lastColumn, lastRow }

    let visibleChunks = 0
    let visibleObjects = 0
    for (let index = 0; index < this.#chunks.length; index += 1) {
      const column = index % this.chunksPerAxis
      const row = Math.floor(index / this.chunksPerAxis)
      const onScreen =
        column >= firstColumn && column <= lastColumn && row >= firstRow && row <= lastRow
      const chunk = this.#chunks[index]
      if (chunk === undefined) continue
      chunk.visible = onScreen
      if (onScreen) {
        visibleChunks += 1
        visibleObjects += chunk.children.length
      }
    }
    this.#visibleChunkCount = visibleChunks
    this.#visibleObjectCount = visibleObjects
  }
}
