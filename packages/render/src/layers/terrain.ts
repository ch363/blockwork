/**
 * The terrain layer: the floor of the world, and the first of PRD 7.6's six
 * render layers.
 *
 * ## How it draws
 *
 * The obvious implementation gives every 32x32 tile chunk its own mesh of
 * 1024 textured quads. It works, and it costs one draw call per visible chunk:
 * at the furthest zoom a 1180pt viewport spans up to four chunk columns and
 * three chunk rows, so twelve draw calls for the floor alone, before a single
 * wall, object or agent has been drawn. The ticket's budget is under twelve.
 *
 * So the tile grid is moved into a texture instead. Two textures back the
 * whole layer:
 *
 *   - the **material texture**, one texel per tile, holding that tile's index
 *     into the material table in its red channel;
 *   - the **atlas**, one cell per material, holding the art.
 *
 * The geometry is then one quad per chunk — four vertices, not four thousand —
 * and a fragment shader turns its world position into a tile coordinate, reads
 * the material index, and samples the matching atlas cell. Every chunk quad
 * shares one shader and one pair of textures, so they all live in a single
 * `Mesh` and the entire floor is **one draw call at every zoom level**, on any
 * map size. It is also how PRD 7.6 already specifies the overlay layer, so the
 * technique is not new to this codebase.
 *
 * ## Chunks
 *
 * Chunks survive that change; they are just no longer the unit of geometry.
 * They remain:
 *
 *   - the unit of **dirty tracking** — a changed chunk rewrites its own 32x32
 *     block of the material texture and nothing else, and the texture uploads
 *     once per frame no matter how many chunks changed;
 *   - the unit of **frustum culling** — only chunks intersecting the camera
 *     rectangle get indices, so off-screen chunks are not rasterised at all.
 *
 * The render chunk is 32x32 tiles (PRD 7.6). The simulation's dirty regions
 * are 16x16 (`CHUNK_SIZE` in `sim/world/coords.ts`), exactly a quarter of one,
 * which is why this layer takes dirty **tile rectangles** rather than chunk
 * ids: mapping between two chunk grids is the caller's job, and it keeps the
 * render package from needing a value import out of `sim` (PRD 7.2).
 *
 * ## Art
 *
 * `createTerrainAtlas` generates a placeholder atlas at runtime from a list of
 * flat colours plus deterministic grain. PRD 7.7 allows placeholder art until
 * Phase 6, and generating it means no binary assets exist to be mistaken for
 * anyone else's. The palette is an argument, not a constant baked into the
 * layer: materials are content, and content becomes `packages/data` in T1.1.
 */

import {
  BufferImageSource,
  CanvasSource,
  Container,
  Geometry,
  Mesh,
  Shader,
  Texture,
} from 'pixi.js'

import { TILE_SIZE } from '../tiles'

import type { Camera, WorldRect } from '../camera/camera'
import { swatchColour } from '../sprites/palette'

/** Render chunk edge, in tiles (PRD 7.6). Four simulation chunks. */
export const TERRAIN_CHUNK_TILES = 32

/** World units spanned by one render chunk. */
export const TERRAIN_CHUNK_WORLD = TERRAIN_CHUNK_TILES * TILE_SIZE

/** Atlas cell edge in pixels: one tile of art at zoom 1. */
export const TERRAIN_ATLAS_CELL_PX = 32

/** Cells per atlas row. 16 keeps a full 256-material atlas at 512x512. */
export const TERRAIN_ATLAS_COLUMNS = 16

/**
 * The width of a `Uint8Array` material index, which is what the grid stores
 * per tile (PRD 4.3) and therefore what the red channel can carry.
 */
export const MAX_TERRAIN_MATERIALS = 256

/** How one material is drawn while the real art is still placeholder. */
export interface TerrainTileAppearance {
  /** Base colour as `0xRRGGBB`. */
  readonly colour: number
  /**
   * Per-pixel value noise, 0 to 1, as a fraction of the base brightness. Stops
   * a large floor reading as a single flat rectangle.
   */
  readonly grain?: number
}

/**
 * Bare ground: what index 0 of the material table means on `floorMaterial`.
 * An unbuilt map is a field rather than a wasteland. Uses the palette's earth
 * swatch so the whole app re-tints from one table.
 */
export const DEFAULT_GROUND_APPEARANCE: TerrainTileAppearance = {
  colour: swatchColour('earth'),
  grain: 0.12,
}

/**
 * Fallback floor when a material lacks an appearance entry.
 */
export const DEFAULT_FLOOR_APPEARANCE: TerrainTileAppearance = {
  colour: swatchColour('concrete'),
  grain: 0.05,
}

/** @deprecated Use `DEFAULT_GROUND_APPEARANCE`. */
export const BARE_GROUND_APPEARANCE: TerrainTileAppearance = DEFAULT_GROUND_APPEARANCE

/**
 * Turns the simulation's index-ordered material ids into a floor palette.
 *
 * The mirror of `wallPalette`, and it matters for the same reason: the atlas
 * is indexed by the value stored in `floorMaterial`, which is a position in
 * `MaterialTable`, so a palette that is not built from the same id list draws
 * the wrong material — or, once the table is longer than the palette, nothing
 * at all.
 *
 * Wall materials share the index space and never appear on `floorMaterial`,
 * so their slots are filled with bare ground rather than left short.
 */
export function terrainPalette(
  materialIds: readonly string[],
  appearances: ReadonlyMap<string, TerrainTileAppearance> | Readonly<Record<string, TerrainTileAppearance>>,
): readonly TerrainTileAppearance[] {
  const lookup = appearances instanceof Map
    ? (id: string) => appearances.get(id)
    : (id: string) => (appearances as Readonly<Record<string, TerrainTileAppearance>>)[id]
  return materialIds.map((id, index) => {
    if (index === 0) return DEFAULT_GROUND_APPEARANCE
    return lookup(id) ?? DEFAULT_FLOOR_APPEARANCE
  })
}

/** A generated tile atlas plus the layout the shader needs to index it. */
export interface TerrainAtlas {
  readonly texture: Texture
  readonly columns: number
  readonly rows: number
  readonly cellPx: number
  destroy(): void
}

export interface TerrainAtlasOptions {
  readonly cellPx?: number
  readonly columns?: number
}

/**
 * Hash noise. Deterministic on purpose: two runs must produce byte-identical
 * atlases, or a screenshot comparison in a future visual test would fail for
 * no reason. `Math.random` would also be fine here — this is not simulation
 * state — but reproducible is strictly better than random.
 */
function hashNoise(x: number, y: number): number {
  let h = Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x2545f491)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 0xffffffff
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0
}

/**
 * Paints an atlas of flat, grained tiles onto a canvas and wraps it as a
 * texture. Mipmaps are off and the sampler clamps: the shader indexes cells by
 * arithmetic, so a mip chain would blend neighbouring materials into each
 * other at low zoom.
 */
export function createTerrainAtlas(
  appearances: readonly TerrainTileAppearance[],
  options: TerrainAtlasOptions = {},
): TerrainAtlas {
  if (appearances.length === 0) {
    throw new RangeError('a terrain atlas needs at least one appearance')
  }
  if (appearances.length > MAX_TERRAIN_MATERIALS) {
    throw new RangeError(
      `a terrain atlas holds at most ${MAX_TERRAIN_MATERIALS} materials, ` +
        `because the grid stores one Uint8 index per tile, received ${appearances.length}`,
    )
  }

  const cellPx = options.cellPx ?? TERRAIN_ATLAS_CELL_PX
  const columns = Math.min(options.columns ?? TERRAIN_ATLAS_COLUMNS, appearances.length)
  const rows = Math.ceil(appearances.length / columns)

  const canvas = document.createElement('canvas')
  canvas.width = columns * cellPx
  canvas.height = rows * cellPx

  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Blockwork: a 2D canvas context is unavailable, cannot build a terrain atlas')
  }

  const image = context.createImageData(canvas.width, canvas.height)
  const pixels = image.data

  for (let index = 0; index < appearances.length; index += 1) {
    // Bounded by the loop, so the element is present.
    const appearance = appearances[index] as TerrainTileAppearance
    const grain = appearance.grain ?? 0
    const red = (appearance.colour >> 16) & 0xff
    const green = (appearance.colour >> 8) & 0xff
    const blue = appearance.colour & 0xff

    const originX = (index % columns) * cellPx
    const originY = Math.floor(index / columns) * cellPx

    for (let y = 0; y < cellPx; y += 1) {
      for (let x = 0; x < cellPx; x += 1) {
        const shade = 1 + (hashNoise(originX + x, originY + y) - 0.5) * 2 * grain
        const at = ((originY + y) * canvas.width + originX + x) * 4
        pixels[at] = clampByte(red * shade)
        pixels[at + 1] = clampByte(green * shade)
        pixels[at + 2] = clampByte(blue * shade)
        pixels[at + 3] = 255
      }
    }
  }

  context.putImageData(image, 0, 0)

  const source = new CanvasSource({
    resource: canvas,
    scaleMode: 'linear',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
    label: 'blockwork-terrain-atlas',
  })

  const texture = new Texture({ source })

  return {
    texture,
    columns,
    rows,
    cellPx,
    destroy(): void {
      texture.destroy(true)
    },
  }
}

/**
 * GLSL for both WebGL versions.
 *
 * Written in the ES 3.00 dialect with no `#version` directive, which is the
 * convention Pixi's own shaders follow: its `GlProgram` preprocessor rewrites
 * `in`, `out`, `finalColor` and `texture` for WebGL 1 and leaves them alone
 * for WebGL 2. `precision highp float` leads the fragment source because the
 * tile coordinate reaches 300 on the largest map, and a `mediump` float cannot
 * separate one tile from the next at that magnitude; Pixi downgrades it on the
 * rare device that has no high precision fragment support.
 */
const TERRAIN_VERTEX_SOURCE = `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uTileSize;

in vec2 aPosition;

out vec2 vTile;

void main(void) {
    mat3 modelViewProjection = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((modelViewProjection * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vTile = aPosition / uTileSize;
}
`

const TERRAIN_FRAGMENT_SOURCE = `precision highp float;

uniform sampler2D uMaterial;
uniform sampler2D uAtlas;
uniform vec2 uMapSize;
uniform vec2 uAtlasGrid;
uniform vec2 uAtlasCell;
uniform float uAtlasInset;

in vec2 vTile;

out vec4 finalColor;

void main(void) {
    vec2 tile = floor(vTile);
    vec2 within = clamp(vTile - tile, uAtlasInset, 1.0 - uAtlasInset);
    float material = floor(texture(uMaterial, (tile + 0.5) / uMapSize).r * 255.0 + 0.5);
    vec2 cell = vec2(mod(material, uAtlasGrid.x), floor(material / uAtlasGrid.x));
    finalColor = texture(uAtlas, (cell + within) * uAtlasCell);
}
`

/** The chunk rectangle a camera can see, inclusive on both ends. */
interface ChunkRange {
  readonly firstColumn: number
  readonly firstRow: number
  readonly lastColumn: number
  readonly lastRow: number
  readonly count: number
}

const EMPTY_RANGE: ChunkRange = {
  firstColumn: 0,
  firstRow: 0,
  lastColumn: -1,
  lastRow: -1,
  count: 0,
}

/** Which chunks of a `chunksPerAxis` grid a world rectangle touches. */
export function terrainChunkRange(rect: WorldRect, chunksPerAxis: number): ChunkRange {
  const firstColumn = Math.max(0, Math.floor(rect.left / TERRAIN_CHUNK_WORLD))
  const lastColumn = Math.min(chunksPerAxis - 1, Math.floor(rect.right / TERRAIN_CHUNK_WORLD))
  const firstRow = Math.max(0, Math.floor(rect.top / TERRAIN_CHUNK_WORLD))
  const lastRow = Math.min(chunksPerAxis - 1, Math.floor(rect.bottom / TERRAIN_CHUNK_WORLD))

  if (lastColumn < firstColumn || lastRow < firstRow) return EMPTY_RANGE

  return {
    firstColumn,
    firstRow,
    lastColumn,
    lastRow,
    count: (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1),
  }
}

export interface TerrainLayerOptions {
  /** Map edge in tiles. The map is square (PRD 4.3). */
  readonly mapSize: number
  readonly atlas: TerrainAtlas
}

export class TerrainLayer {
  /** Add this to the world container. Holds the layer's single mesh. */
  readonly container: Container
  readonly mapSize: number
  readonly chunksPerAxis: number

  readonly #atlas: TerrainAtlas
  readonly #mesh: Mesh<Geometry, Shader>
  readonly #geometry: Geometry
  readonly #shader: Shader

  /** One RGBA texel per tile; the material index lives in red. */
  readonly #materialData: Uint8Array
  readonly #materialSource: BufferImageSource

  readonly #indices: Uint32Array
  readonly #dirtyChunks: number[] = []
  readonly #dirtyFlags: Uint8Array
  #range: ChunkRange = EMPTY_RANGE

  /** The tile data being mirrored into the texture. Null until `setFloors`. */
  #floors: Uint8Array | null = null

  constructor(options: TerrainLayerOptions) {
    const { mapSize, atlas } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    this.mapSize = mapSize
    this.chunksPerAxis = Math.ceil(mapSize / TERRAIN_CHUNK_TILES)
    this.#atlas = atlas

    const chunkTotal = this.chunksPerAxis * this.chunksPerAxis
    this.#dirtyFlags = new Uint8Array(chunkTotal)

    this.#materialData = new Uint8Array(mapSize * mapSize * 4)
    // Opaque everywhere. Only red is read, but a zero alpha would be premultiplied
    // away on upload and take the index with it.
    for (let at = 3; at < this.#materialData.length; at += 4) {
      this.#materialData[at] = 255
    }

    this.#materialSource = new BufferImageSource({
      resource: this.#materialData,
      width: mapSize,
      height: mapSize,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
      label: 'blockwork-terrain-materials',
    })

    this.#shader = Shader.from({
      gl: {
        name: 'blockwork-terrain',
        vertex: TERRAIN_VERTEX_SOURCE,
        fragment: TERRAIN_FRAGMENT_SOURCE,
      },
      resources: {
        uMaterial: this.#materialSource,
        uAtlas: atlas.texture.source,
        terrainUniforms: {
          uTileSize: { value: TILE_SIZE, type: 'f32' },
          uMapSize: { value: new Float32Array([mapSize, mapSize]), type: 'vec2<f32>' },
          uAtlasGrid: { value: new Float32Array([atlas.columns, atlas.rows]), type: 'vec2<f32>' },
          uAtlasCell: {
            value: new Float32Array([1 / atlas.columns, 1 / atlas.rows]),
            type: 'vec2<f32>',
          },
          // Half a texel, so bilinear sampling at a cell edge cannot reach into
          // the neighbouring material.
          uAtlasInset: { value: 0.5 / atlas.cellPx, type: 'f32' },
        },
      },
    })

    this.#indices = new Uint32Array(chunkTotal * 6)
    this.#geometry = new Geometry({
      label: 'blockwork-terrain',
      attributes: {
        aPosition: {
          buffer: buildChunkPositions(mapSize, this.chunksPerAxis),
          format: 'float32x2',
          stride: 2 * Float32Array.BYTES_PER_ELEMENT,
          offset: 0,
        },
      },
      indexBuffer: this.#indices,
      topology: 'triangle-list',
    })

    this.#mesh = new Mesh<Geometry, Shader>({
      label: 'blockwork-terrain',
      geometry: this.#geometry,
      shader: this.#shader,
    })

    this.container = new Container({ label: 'terrain' })
    this.container.addChild(this.#mesh)
  }

  /** Chunks that passed the frustum test on the last `update`. */
  get visibleChunkCount(): number {
    return this.#range.count
  }

  /** Chunks awaiting a texture rewrite. */
  get dirtyChunkCount(): number {
    return this.#dirtyChunks.length
  }

  /**
   * Points the layer at the simulation's `floorMaterial` array and marks
   * everything dirty. The array is read, never written, and is not copied: the
   * caller keeps ownership and may keep mutating it as long as it reports the
   * changes through `markDirtyRect`.
   */
  setFloors(floorMaterial: Uint8Array): void {
    const expected = this.mapSize * this.mapSize
    if (floorMaterial.length !== expected) {
      throw new RangeError(
        `floorMaterial must hold ${expected} entries for a ${this.mapSize}x${this.mapSize} map, ` +
          `received ${floorMaterial.length}`,
      )
    }
    this.#floors = floorMaterial
    this.markAllDirty()
  }

  /**
   * Marks every render chunk touching a tile rectangle. Clipped to the map, so
   * a caller expanding a simulation chunk id into tiles need not bounds-check.
   */
  markDirtyRect(tileX: number, tileY: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return

    const left = Math.max(0, tileX)
    const top = Math.max(0, tileY)
    const right = Math.min(this.mapSize - 1, tileX + width - 1)
    const bottom = Math.min(this.mapSize - 1, tileY + height - 1)
    if (right < left || bottom < top) return

    const firstColumn = Math.floor(left / TERRAIN_CHUNK_TILES)
    const lastColumn = Math.floor(right / TERRAIN_CHUNK_TILES)
    const firstRow = Math.floor(top / TERRAIN_CHUNK_TILES)
    const lastRow = Math.floor(bottom / TERRAIN_CHUNK_TILES)

    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        this.#markChunk(row * this.chunksPerAxis + column)
      }
    }
  }

  markAllDirty(): void {
    for (let chunk = 0; chunk < this.#dirtyFlags.length; chunk += 1) {
      this.#markChunk(chunk)
    }
  }

  /**
   * One frame of work: rewrite whatever changed, then re-cull. Both halves are
   * no-ops when nothing has moved, so a still camera over a still map costs a
   * rectangle comparison.
   */
  update(camera: Camera): void {
    this.#rebuildDirtyChunks()
    this.#cull(camera.visibleRect())
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.#geometry.destroy(true)
    this.#shader.destroy(true)
    this.#materialSource.destroy()
    this.#atlas.destroy()
  }

  #markChunk(chunk: number): void {
    if (this.#dirtyFlags[chunk] === 1) return
    this.#dirtyFlags[chunk] = 1
    this.#dirtyChunks.push(chunk)
  }

  /**
   * Copies dirty chunks out of the tile array and into the texture, then
   * uploads once. The upload is whole-texture because neither WebGL nor WebGPU
   * is given a sub-rectangle by Pixi, but it is 193KB on a 220x220 map and
   * happens at most once a frame however many chunks changed.
   */
  #rebuildDirtyChunks(): void {
    if (this.#dirtyChunks.length === 0) return

    const floors = this.#floors
    for (const chunk of this.#dirtyChunks) {
      this.#dirtyFlags[chunk] = 0
      if (floors === null) continue

      const startX = (chunk % this.chunksPerAxis) * TERRAIN_CHUNK_TILES
      const startY = Math.floor(chunk / this.chunksPerAxis) * TERRAIN_CHUNK_TILES
      const endX = Math.min(startX + TERRAIN_CHUNK_TILES, this.mapSize)
      const endY = Math.min(startY + TERRAIN_CHUNK_TILES, this.mapSize)

      for (let y = startY; y < endY; y += 1) {
        const row = y * this.mapSize
        for (let x = startX; x < endX; x += 1) {
          this.#materialData[(row + x) * 4] = floors[row + x] ?? 0
        }
      }
    }

    this.#dirtyChunks.length = 0
    this.#materialSource.update()
  }

  /**
   * Rewrites the index buffer to reference only the visible chunks, packed at
   * the front. The tail is filled with zeroes, which the GPU sees as
   * degenerate triangles on vertex 0 and discards before rasterising; that
   * keeps the index buffer a fixed size, so culling never reallocates a GPU
   * buffer mid-pan.
   */
  #cull(rect: WorldRect): void {
    const range = terrainChunkRange(rect, this.chunksPerAxis)
    if (sameRange(range, this.#range)) return
    this.#range = range

    let write = 0
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
        const vertex = (row * this.chunksPerAxis + column) * 4
        this.#indices[write] = vertex
        this.#indices[write + 1] = vertex + 1
        this.#indices[write + 2] = vertex + 2
        this.#indices[write + 3] = vertex
        this.#indices[write + 4] = vertex + 2
        this.#indices[write + 5] = vertex + 3
        write += 6
      }
    }

    this.#indices.fill(0, write)
    this.#geometry.getIndex().update()
  }
}

function sameRange(a: ChunkRange, b: ChunkRange): boolean {
  return (
    a.firstColumn === b.firstColumn &&
    a.firstRow === b.firstRow &&
    a.lastColumn === b.lastColumn &&
    a.lastRow === b.lastRow
  )
}

/**
 * One quad per chunk, in world units, wound clockwise from the top-left.
 * Chunks at the far edge of a map that is not a multiple of the chunk size are
 * clipped, so a 220x220 map's last chunk column is 28 tiles wide.
 */
function buildChunkPositions(mapSize: number, chunksPerAxis: number): Float32Array {
  const worldSize = mapSize * TILE_SIZE
  const positions = new Float32Array(chunksPerAxis * chunksPerAxis * 4 * 2)

  let at = 0
  for (let row = 0; row < chunksPerAxis; row += 1) {
    const top = row * TERRAIN_CHUNK_WORLD
    const bottom = Math.min(top + TERRAIN_CHUNK_WORLD, worldSize)

    for (let column = 0; column < chunksPerAxis; column += 1) {
      const left = column * TERRAIN_CHUNK_WORLD
      const right = Math.min(left + TERRAIN_CHUNK_WORLD, worldSize)

      positions[at] = left
      positions[at + 1] = top
      positions[at + 2] = right
      positions[at + 3] = top
      positions[at + 4] = right
      positions[at + 5] = bottom
      positions[at + 6] = left
      positions[at + 7] = bottom
      at += 8
    }
  }

  return positions
}

/* -------------------------------------------------------------------------- */
/* Data-driven appearance (T6.6)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Turns the material definitions into the appearance table the layers take.
 *
 * Keyed by id, and returned as a plain map so the render package never holds a
 * `GameData`: it is handed colours, which is all a renderer should know about
 * content.
 */
export function materialAppearances(
  materials: Iterable<{
    readonly id: string
    readonly appearance?: { readonly swatch: string; readonly grain: number } | undefined
  }>,
): Map<string, TerrainTileAppearance> {
  const table = new Map<string, TerrainTileAppearance>()
  for (const material of materials) {
    const declared = material.appearance
    table.set(
      material.id,
      declared === undefined
        ? { colour: swatchColour('concrete'), grain: 0.05 }
        : { colour: swatchColour(declared.swatch), grain: declared.grain },
    )
  }
  return table
}

/**
 * The palette in material-table order, which is the order the tile grid's
 * indices refer to.
 *
 * Index 0 is bare ground rather than a material, so it keeps the earth swatch:
 * an unbuilt tile is not made of anything.
 */
export function terrainPaletteFor(
  materialIds: readonly string[],
  appearances: ReadonlyMap<string, TerrainTileAppearance>,
): readonly TerrainTileAppearance[] {
  return [
    DEFAULT_GROUND_APPEARANCE,
    ...materialIds.map((id) => appearances.get(id) ?? DEFAULT_FLOOR_APPEARANCE),
  ]
}
