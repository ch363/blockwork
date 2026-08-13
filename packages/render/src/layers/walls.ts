/**
 * Walls and doors: layer 2 of PRD 7.6, and the layer that makes a floor plan
 * read as a building.
 *
 * ## Two halves, because they are two different problems
 *
 * **Walls are dense and static.** A built prison is tens of thousands of wall
 * tiles that change only when someone builds. They are drawn exactly the way
 * `layers/terrain.ts` draws the floor, and for the same reason: one quad per
 * 32x32 chunk, one shader, one draw call at every zoom on any map size. The
 * per-tile detail lives in a data texture, one texel per tile, with the wall
 * material index in red and the autotile sprite index in green.
 *
 * A wall shader needs one thing terrain does not: **colour per material,
 * shape per neighbourhood.** Baking both into the atlas would need 47 cells
 * times every wall material. So the atlas holds 47 greyscale shapes and a
 * 256x1 palette texture holds one colour per material index; the fragment
 * multiplies them. Material 0 is transparent in the palette, which is what
 * makes "no wall" cost no branch.
 *
 * **Doors are sparse and animated.** A prison has hundreds, not thousands, and
 * each one opens and closes. They are ordinary sprites in one container off a
 * single atlas, so Pixi batches the lot into one draw call, and a state change
 * is a texture swap rather than a texture rewrite.
 *
 * ## Doors are part of the wall run
 *
 * `sim/world/walls.ts` defines `isWallLike` as "a wall or a door", because a
 * door is built into a wall rather than beside it: placing one clears the tile's
 * `wallMaterial` and puts an entry in the door registry. This layer computes
 * its autotile masks against the same predicate, so the wall each side of a
 * doorway caps against the frame instead of stopping in mid-air. That is the
 * single reason walls and doors share a module.
 *
 * ## Dirty tracking
 *
 * A tile's sprite depends on its eight neighbours, so a change ripples one
 * tile outward. `markDirtyRect` grows its rectangle by one before mapping it
 * onto chunks, which is the same allowance `core/blueprint.ts` already makes on
 * the simulation side when it repaints all nine tiles around a structural
 * change.
 *
 * Chunks are also culled by content, not only by the frustum: a chunk holding
 * no walls contributes no indices, so the yard and the car park cost nothing
 * to rasterise even while they are on screen.
 */

import { BufferImageSource, Container, Geometry, Mesh, Shader, Sprite } from 'pixi.js'

import {
  AUTOTILE_CORNERS,
  AUTOTILE_INDEX_BY_MASK,
  AUTOTILE_NEIGHBOUR,
  AUTOTILE_OFFSETS,
  AUTOTILE_TILE_COUNT,
  autotileConnects,
  autotileIsInnerCorner,
  autotileMaskAt,
} from '../sprites/autotile'
import {
  applyGrain,
  createSpriteCanvas,
  cssColour,
  greyColour,
  sliceAtlas,
  spriteAtlasFromCanvas,
} from '../sprites/atlas'
import type { SpriteAtlas } from '../sprites/atlas'
import { TILE_SIZE } from '../tiles'

import { TERRAIN_CHUNK_TILES, TERRAIN_CHUNK_WORLD } from './terrain'

import type { Camera, WorldRect } from '../camera/camera'
import type { DoorType } from '@blockwork/sim'
import type { Texture } from 'pixi.js'

/* -------------------------------------------------------------------------- */
/* Wall atlas constants                                                        */
/* -------------------------------------------------------------------------- */

/** Atlas cell edge in pixels: one tile of art at zoom 1. */
export const WALL_ATLAS_CELL_PX = 32

/** 8 columns fits the 47 shapes in 6 rows, so the atlas is 256x192. */
export const WALL_ATLAS_COLUMNS = 8

/** The palette texture is indexed by a `Uint8` material index. */
export const MAX_WALL_MATERIALS = 256

/**
 * How far the wall face sits back from a tile edge it does not continue over,
 * in atlas pixels. Four of thirty-two: enough that a capped end reads as an
 * end at zoom 1, little enough that a straight run still reads as one mass.
 */
const WALL_CAP_PX = 4

/** The dark line along a wall face, in atlas pixels. */
const WALL_OUTLINE_PX = 2

/**
 * Shading levels, as bytes, before the palette tint multiplies them. The body
 * sits below full brightness so the lit north edge has somewhere to go.
 */
const WALL_SHADE = {
  body: 208,
  /** The boundary between wall and open ground. */
  outline: 96,
  /** A lit edge along a capped north face, for a little depth. */
  highlight: 246,
  /** Where a solid corner meets a diagonal gap. */
  seam: 150,
} as const

/** How much per-pixel grain the wall body carries. */
const WALL_GRAIN = 0.1

/** How one wall material is coloured. */
export interface WallAppearance {
  /** Base colour as `0xRRGGBB`. */
  readonly colour: number
}

/** Fallback wall colour when a material lacks an appearance entry. */
export const DEFAULT_WALL_APPEARANCE: WallAppearance = { colour: 0x757e8d }

/**
 * Turns the simulation's index-ordered material ids into a palette the layer
 * can upload.
 *
 * `MaterialTable.ids()` puts the reserved empty slot at index 0, which is "no
 * wall" on `wallMaterial` (PRD 4.3), so entry 0 comes back as `null` and the
 * shader draws nothing there. Floor materials share the index space and are
 * never walls, so they come back `null` too.
 */
export function wallPalette(
  materialIds: readonly string[],
  appearances?: ReadonlyMap<string, WallAppearance> | Readonly<Record<string, WallAppearance>>,
): readonly (WallAppearance | null)[] {
  const lookup = appearances === undefined
    ? () => undefined
    : appearances instanceof Map
      ? (id: string) => appearances.get(id)
      : (id: string) => (appearances as Readonly<Record<string, WallAppearance>>)[id]
  return materialIds.map((id, index) => {
    if (index === 0) return null
    return lookup(id) ?? DEFAULT_WALL_APPEARANCE
  })
}

/**
 * Draws the 47 blob shapes into an atlas of greyscale coverage.
 *
 * Each cell is built from the canonical mask's four cardinals and four
 * corners, which is the whole of the shape:
 *
 *   - the body fills the cell, set back by `WALL_CAP_PX` on every side the
 *     wall does not continue over, so an end caps and a run does not;
 *   - each capped side gets an outline, which is what a player actually reads
 *     as the edge of a building;
 *   - each **inner corner** — both cardinals solid, the diagonal open — gets a
 *     small seam at that corner. Those seams are the only difference between
 *     a crossroads with four diagonal gaps and one with none, and without them
 *     16 of the 47 sprites would be identical.
 */
export function createWallShapeAtlas(cellPx: number = WALL_ATLAS_CELL_PX): SpriteAtlas {
  if (!Number.isInteger(cellPx) || cellPx < 8) {
    throw new RangeError(`wall atlas cellPx must be an integer >= 8, received ${cellPx}`)
  }

  const columns = WALL_ATLAS_COLUMNS
  const rows = Math.ceil(AUTOTILE_TILE_COUNT / columns)
  const scale = cellPx / WALL_ATLAS_CELL_PX
  const cap = Math.max(1, Math.round(WALL_CAP_PX * scale))
  const outline = Math.max(1, Math.round(WALL_OUTLINE_PX * scale))

  const { canvas, context } = createSpriteCanvas(columns * cellPx, rows * cellPx)

  for (let index = 0; index < AUTOTILE_TILE_COUNT; index += 1) {
    const mask = autotileMaskAt(index)
    const originX = (index % columns) * cellPx
    const originY = Math.floor(index / columns) * cellPx

    const north = autotileConnects(mask, AUTOTILE_NEIGHBOUR.N)
    const east = autotileConnects(mask, AUTOTILE_NEIGHBOUR.E)
    const south = autotileConnects(mask, AUTOTILE_NEIGHBOUR.S)
    const west = autotileConnects(mask, AUTOTILE_NEIGHBOUR.W)

    const left = west ? 0 : cap
    const top = north ? 0 : cap
    const right = cellPx - (east ? 0 : cap)
    const bottom = cellPx - (south ? 0 : cap)
    const width = right - left
    const height = bottom - top

    context.fillStyle = greyColour(WALL_SHADE.body)
    context.fillRect(originX + left, originY + top, width, height)

    context.fillStyle = greyColour(WALL_SHADE.outline)
    if (!north) context.fillRect(originX + left, originY + top, width, outline)
    if (!south) context.fillRect(originX + left, originY + bottom - outline, width, outline)
    if (!west) context.fillRect(originX + left, originY + top, outline, height)
    if (!east) context.fillRect(originX + right - outline, originY + top, outline, height)

    // A single lit pixel row under a capped north face. Every wall in the
    // prison is lit from the same side, which is what stops a plan of
    // identical grey rectangles from looking flat.
    if (!north) {
      context.fillStyle = greyColour(WALL_SHADE.highlight)
      context.fillRect(
        originX + left + outline,
        originY + top + outline,
        Math.max(0, width - outline * 2),
        Math.max(1, Math.round(scale)),
      )
    }

    context.fillStyle = greyColour(WALL_SHADE.seam)
    for (const corner of AUTOTILE_CORNERS) {
      if (!autotileIsInnerCorner(mask, corner)) continue
      const seamX = autotileConnects(corner.cardinals, AUTOTILE_NEIGHBOUR.E) ? cellPx - cap : 0
      const seamY = autotileConnects(corner.cardinals, AUTOTILE_NEIGHBOUR.S) ? cellPx - cap : 0
      context.fillRect(originX + seamX, originY + seamY, cap, cap)
    }

    applyGrain(context, originX, originY, cellPx, cellPx, WALL_GRAIN)
  }

  return spriteAtlasFromCanvas(canvas, {
    cellPx,
    columns,
    rows,
    label: 'blockwork-wall-shapes',
  })
}

/* -------------------------------------------------------------------------- */
/* Doors                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Door orientation, from the run the door sits in. A door between walls to
 * east and west is `horizontal`; anything else falls back to `vertical`, which
 * is what a door in a stub of wall or in open ground looks like.
 */
export const DOOR_ORIENTATIONS = ['horizontal', 'vertical'] as const
export type DoorOrientation = (typeof DOOR_ORIENTATIONS)[number]

/**
 * The frames of the swing. Eight frames provide a proper hinged sweep at 22.5
 * degrees per step, enough to read as an opening motion at game speed.
 */
export const DOOR_FRAMES = [
  'closed', 'swing1', 'swing2', 'swing3', 'swing4', 'swing5', 'swing6', 'open',
] as const
export type DoorFrame = (typeof DOOR_FRAMES)[number]

/** Number of swing frames for the hinged sweep animation. */
export const DOOR_SWING_FRAMES = DOOR_FRAMES.length

/**
 * The door types of `sim/data/schemas.ts`, in the order the atlas lays them
 * out. Restated rather than imported because `DOOR_TYPES` is a value and PRD
 * 7.2 allows this package types only; an unknown type falls back to the first
 * entry rather than failing to draw.
 */
export const DOOR_ATLAS_TYPES: readonly DoorType[] = [
  'standard',
  'secure',
  'barred',
  'staff',
  'isolation',
  'remote',
]

/** How one door type is drawn. */
export interface DoorAppearance {
  /** The leaf, as `0xRRGGBB`. */
  readonly colour: number
  /** Vertical bars across the leaf, for a barred or a remote gate. */
  readonly barred: boolean
}

/** Default door appearances keyed by type. Uses palette swatches. */
export const DEFAULT_DOOR_APPEARANCES: Readonly<Record<DoorType, DoorAppearance>> = {
  standard: { colour: 0xa9805a, barred: false },
  secure: { colour: 0x7e8b9b, barred: false },
  barred: { colour: 0x8d99a8, barred: true },
  staff: { colour: 0x6f8398, barred: false },
  isolation: { colour: 0x5f6874, barred: false },
  remote: { colour: 0x7e8b9b, barred: true },
}

/** The jamb, which is the stub of wall the leaf hangs off. */
const DOOR_JAMB_COLOUR = 0x5a6270
const DOOR_OUTLINE_COLOUR = 0x1b2028
/** What is visible through an open doorway: the floor, shaded by the frame. */
const DOOR_THRESHOLD_COLOUR = 0x2f343b

/**
 * Draws every door state into one atlas: type down the rows, and the
 * combinations of orientation and frame across the columns.
 *
 * The swing is now eight frames, providing a proper hinged sweep per T8.22.
 * Each frame rotates the leaf incrementally from closed (0°) to open (90°),
 * giving smooth door animation at game speed.
 */
export function createDoorAtlas(
  appearances: Readonly<Record<DoorType, DoorAppearance>> = DEFAULT_DOOR_APPEARANCES,
  cellPx: number = WALL_ATLAS_CELL_PX,
): SpriteAtlas {
  const columns = DOOR_ORIENTATIONS.length * DOOR_FRAMES.length
  const rows = DOOR_ATLAS_TYPES.length
  const { canvas, context } = createSpriteCanvas(columns * cellPx, rows * cellPx)

  const scale = cellPx / WALL_ATLAS_CELL_PX
  const jamb = Math.max(2, Math.round(6 * scale))
  const leaf = Math.max(3, Math.round(10 * scale))
  const outline = Math.max(1, Math.round(scale))

  for (const [row, type] of DOOR_ATLAS_TYPES.entries()) {
    const appearance = appearances[type] ?? DEFAULT_DOOR_APPEARANCES.standard
    const originY = row * cellPx

    for (const [orientationIndex, orientation] of DOOR_ORIENTATIONS.entries()) {
      for (const [frameIndex] of DOOR_FRAMES.entries()) {
        const originX = (orientationIndex * DOOR_FRAMES.length + frameIndex) * cellPx
        // Swing angle: 0 = closed (0°), 7 = open (90°)
        const swingAngle = (frameIndex / (DOOR_FRAMES.length - 1)) * (Math.PI / 2)

        context.save()
        context.translate(originX, originY)
        // A vertical door is a horizontal one turned a quarter turn about the
        // cell's centre, so only one drawing routine exists.
        if (orientation === 'vertical') {
          context.translate(cellPx / 2, cellPx / 2)
          context.rotate(Math.PI / 2)
          context.translate(-cellPx / 2, -cellPx / 2)
        }
        drawHingedDoor(context, {
          appearance,
          swingAngle,
          cellPx,
          jamb,
          leaf,
          outline,
        })
        context.restore()
      }
    }
  }

  return spriteAtlasFromCanvas(canvas, { cellPx, columns, rows, label: 'blockwork-doors' })
}

interface HingedDoorDrawOptions {
  readonly appearance: DoorAppearance
  /** Swing angle in radians: 0 = closed, π/2 = fully open */
  readonly swingAngle: number
  readonly cellPx: number
  readonly jamb: number
  readonly leaf: number
  readonly outline: number
}

/**
 * Draws a hinged door with proper sweep animation. The door leaf rotates from
 * closed (0°) to fully open (90°), pivoting from the hinge point against the
 * left jamb.
 */
function drawHingedDoor(context: CanvasRenderingContext2D, options: HingedDoorDrawOptions): void {
  const { appearance, swingAngle, cellPx, jamb, leaf, outline } = options
  const centre = (cellPx - leaf) / 2

  // Draw the threshold visible through the opening
  context.fillStyle = cssColour(DOOR_THRESHOLD_COLOUR)
  context.fillRect(0, centre, cellPx, leaf)

  // Draw the jambs (frame posts on each side)
  context.fillStyle = cssColour(DOOR_JAMB_COLOUR)
  context.fillRect(0, centre - outline, jamb, leaf + outline * 2)
  context.fillRect(cellPx - jamb, centre - outline, jamb, leaf + outline * 2)

  const openingLeft = jamb
  const openingWidth = cellPx - jamb * 2
  const hingeX = openingLeft
  const hingeY = centre + leaf / 2

  // Calculate the door leaf dimensions based on swing angle
  // As the door opens, we see it foreshortened (narrower) from the top-down view
  const leafLength = openingWidth
  const foreshortening = Math.cos(swingAngle)
  const projectedWidth = Math.max(2, leafLength * foreshortening)
  const projectedDepth = Math.max(1, Math.abs(leafLength * Math.sin(swingAngle)))

  context.save()
  context.translate(hingeX, hingeY)

  // Draw the door leaf with perspective foreshortening
  // When closed (0°): full width rectangle
  // When open (90°): thin line perpendicular to the wall
  context.fillStyle = cssColour(appearance.colour)

  if (swingAngle < 0.1) {
    // Nearly closed: draw as a flat rectangle spanning the opening
    context.fillRect(0, -leaf / 2, openingWidth, leaf)
  } else if (swingAngle > Math.PI / 2 - 0.1) {
    // Nearly fully open: draw as a thin rectangle against the jamb
    const thickness = Math.max(2, leaf * 0.15)
    context.fillRect(-thickness / 2, -leaf / 2 - leafLength + leaf, thickness, leafLength)
  } else {
    // Mid-swing: draw as a parallelogram showing the hinged rotation
    // The door swings inward (toward negative Y in our coordinate system)
    context.beginPath()
    context.moveTo(0, -leaf / 2) // Near corner at hinge
    context.lineTo(projectedWidth, -leaf / 2 - projectedDepth) // Far corner top
    context.lineTo(projectedWidth, leaf / 2 - projectedDepth) // Far corner bottom
    context.lineTo(0, leaf / 2) // Near corner at hinge bottom
    context.closePath()
    context.fill()
  }

  // Draw bars for barred doors
  if (appearance.barred && projectedWidth > 4) {
    context.fillStyle = cssColour(DOOR_OUTLINE_COLOUR, 0.45)
    const numBars = Math.max(2, Math.floor(projectedWidth / 6))
    const barSpacing = projectedWidth / (numBars + 1)
    for (let i = 1; i <= numBars; i += 1) {
      const barX = barSpacing * i
      const barYOffset = swingAngle > 0.1 ? -projectedDepth * (barX / projectedWidth) : 0
      context.fillRect(barX - outline / 2, -leaf / 2 + barYOffset, outline, leaf)
    }
  }

  // Draw outline
  context.strokeStyle = cssColour(DOOR_OUTLINE_COLOUR, 0.7)
  context.lineWidth = outline

  if (swingAngle < 0.1) {
    context.strokeRect(outline / 2, -leaf / 2 + outline / 2, openingWidth - outline, leaf - outline)
  } else if (swingAngle > Math.PI / 2 - 0.1) {
    const thickness = Math.max(2, leaf * 0.15)
    context.strokeRect(
      -thickness / 2 + outline / 2,
      -leaf / 2 - leafLength + leaf + outline / 2,
      thickness - outline,
      leafLength - outline,
    )
  } else {
    context.beginPath()
    context.moveTo(outline / 2, -leaf / 2 + outline / 2)
    context.lineTo(projectedWidth - outline / 2, -leaf / 2 - projectedDepth + outline / 2)
    context.lineTo(projectedWidth - outline / 2, leaf / 2 - projectedDepth - outline / 2)
    context.lineTo(outline / 2, leaf / 2 - outline / 2)
    context.closePath()
    context.stroke()
  }

  context.restore()
}

/** Where a door state sits in the atlas grid. */
export function doorAtlasCell(
  type: DoorType,
  orientation: DoorOrientation,
  frame: DoorFrame,
): number {
  const row = Math.max(0, DOOR_ATLAS_TYPES.indexOf(type))
  const frameIndex = DOOR_FRAMES.indexOf(frame)
  const column = DOOR_ORIENTATIONS.indexOf(orientation) * DOOR_FRAMES.length + frameIndex
  return row * DOOR_ORIENTATIONS.length * DOOR_FRAMES.length + column
}

/**
 * Maps an open/closed boolean to a frame for backward compatibility.
 * For smooth animation, use the full frame sequence.
 */
export function doorFrameFromOpen(open: boolean): DoorFrame {
  return open ? 'open' : 'closed'
}

/**
 * A door lies along its wall run. Walls to east and west make it horizontal;
 * everything else, including a door in open ground, hangs vertically.
 */
export function doorOrientation(mask: number): DoorOrientation {
  const alongX =
    autotileConnects(mask, AUTOTILE_NEIGHBOUR.E) || autotileConnects(mask, AUTOTILE_NEIGHBOUR.W)
  const alongY =
    autotileConnects(mask, AUTOTILE_NEIGHBOUR.N) || autotileConnects(mask, AUTOTILE_NEIGHBOUR.S)
  return alongX && !alongY ? 'horizontal' : 'vertical'
}

/** A door as the renderer needs it: a tile, a type, and whether it is open. */
export interface RenderDoor {
  readonly tileIndex: number
  readonly type: DoorType
  readonly open: boolean
}

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Written in the ES 3.00 dialect with no `#version` directive, the convention
 * Pixi's own shaders follow: its preprocessor rewrites `in`, `out` and
 * `texture` for WebGL 1 and leaves them alone for WebGL 2. See the same note
 * in `layers/terrain.ts` for why the fragment precision is `highp`.
 */

const WALL_VERTEX_SOURCE = `
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

/*
 * The tint's alpha carries "is there a wall here": palette entry 0 is fully
 * transparent, so an empty tile multiplies out to nothing without a branch or
 * a `discard`, both of which cost more on a tiled mobile GPU than the multiply
 * does. Output is premultiplied, which is what Pixi's blend state expects.
 */
const WALL_FRAGMENT_SOURCE = `precision highp float;

uniform sampler2D uWall;
uniform sampler2D uShapes;
uniform sampler2D uPalette;
uniform vec2 uMapSize;
uniform vec2 uShapeGrid;
uniform vec2 uShapeCell;
uniform float uShapeInset;

in vec2 vTile;

out vec4 finalColor;

void main(void) {
    vec2 tile = floor(vTile);
    vec2 within = clamp(vTile - tile, uShapeInset, 1.0 - uShapeInset);

    // Not 'packed': that is a reserved word in GLSL ES, and naming a local
    // after it makes the whole shader fail to compile — silently, as far as
    // anything but the console is concerned, leaving every wall undrawn.
    vec4 sampled = texture(uWall, (tile + 0.5) / uMapSize);
    float material = floor(sampled.r * 255.0 + 0.5);
    float shape = floor(sampled.g * 255.0 + 0.5);

    vec2 cell = vec2(mod(shape, uShapeGrid.x), floor(shape / uShapeGrid.x));
    vec4 art = texture(uShapes, (cell + within) * uShapeCell);
    vec4 tint = texture(uPalette, vec2((material + 0.5) / 256.0, 0.5));

    float coverage = art.a * tint.a;
    finalColor = vec4(art.rgb * tint.rgb, 1.0) * coverage;
}
`

/* -------------------------------------------------------------------------- */
/* The layer                                                                   */
/* -------------------------------------------------------------------------- */

export interface WallLayerOptions {
  /** Map edge in tiles. The map is square (PRD 4.3). */
  readonly mapSize: number
  readonly shapes: SpriteAtlas
  readonly doors: SpriteAtlas
  /**
   * One entry per material index, `null` where that index is not a wall.
   * Build it with `wallPalette`.
   */
  readonly palette: readonly (WallAppearance | null)[]
}

/** The chunk rectangle a camera can see, inclusive on both ends. */
interface ChunkRange {
  readonly firstColumn: number
  readonly firstRow: number
  readonly lastColumn: number
  readonly lastRow: number
}

const EMPTY_RANGE: ChunkRange = { firstColumn: 0, firstRow: 0, lastColumn: -1, lastRow: -1 }

export class WallLayer {
  /** Add this to the world container. Holds the wall mesh and the door sprites. */
  readonly container: Container
  readonly mapSize: number
  readonly chunksPerAxis: number

  readonly #shapes: SpriteAtlas
  readonly #doorAtlas: SpriteAtlas
  readonly #doorTextures: readonly Texture[]

  readonly #mesh: Mesh<Geometry, Shader>
  readonly #geometry: Geometry
  readonly #shader: Shader
  readonly #doorContainer: Container

  /** One RGBA texel per tile: red is the material, green is the sprite. */
  readonly #wallData: Uint8Array
  readonly #wallSource: BufferImageSource
  readonly #paletteData: Uint8Array
  readonly #paletteSource: BufferImageSource

  readonly #indices: Uint32Array
  readonly #dirtyChunks: number[] = []
  readonly #dirtyFlags: Uint8Array
  /** Wall and door tiles per chunk, so an empty chunk can be skipped entirely. */
  readonly #chunkContent: Uint16Array

  readonly #doors = new Map<number, RenderDoor>()
  readonly #doorSprites = new Map<number, Sprite>()

  #range: ChunkRange = EMPTY_RANGE
  #visibleChunkCount = 0
  #visibleDoorCount = 0
  #doorRect: WorldRect | null = null

  /** The simulation's `wallMaterial`, borrowed not copied. Null until `setWalls`. */
  #walls: Uint8Array | null = null

  constructor(options: WallLayerOptions) {
    const { mapSize, shapes, doors, palette } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }
    if (palette.length > MAX_WALL_MATERIALS) {
      throw new RangeError(
        `a wall palette holds at most ${MAX_WALL_MATERIALS} materials, ` +
          `because the grid stores one Uint8 index per tile, received ${palette.length}`,
      )
    }

    this.mapSize = mapSize
    this.chunksPerAxis = Math.ceil(mapSize / TERRAIN_CHUNK_TILES)
    this.#shapes = shapes
    this.#doorAtlas = doors
    this.#doorTextures = sliceAtlas(doors)

    const chunkTotal = this.chunksPerAxis * this.chunksPerAxis
    this.#dirtyFlags = new Uint8Array(chunkTotal)
    this.#chunkContent = new Uint16Array(chunkTotal)

    this.#wallData = new Uint8Array(mapSize * mapSize * 4)
    // Opaque everywhere. Only red and green are read, but a zero alpha would
    // be premultiplied away on upload and take them with it.
    for (let at = 3; at < this.#wallData.length; at += 4) {
      this.#wallData[at] = 255
    }

    this.#wallSource = new BufferImageSource({
      resource: this.#wallData,
      width: mapSize,
      height: mapSize,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
      label: 'blockwork-wall-tiles',
    })

    this.#paletteData = new Uint8Array(MAX_WALL_MATERIALS * 4)
    this.#paletteSource = new BufferImageSource({
      resource: this.#paletteData,
      width: MAX_WALL_MATERIALS,
      height: 1,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
      label: 'blockwork-wall-palette',
    })
    this.setPalette(palette)

    this.#shader = Shader.from({
      gl: {
        name: 'blockwork-walls',
        vertex: WALL_VERTEX_SOURCE,
        fragment: WALL_FRAGMENT_SOURCE,
      },
      resources: {
        uWall: this.#wallSource,
        uShapes: shapes.texture.source,
        uPalette: this.#paletteSource,
        wallUniforms: {
          uTileSize: { value: TILE_SIZE, type: 'f32' },
          uMapSize: { value: new Float32Array([mapSize, mapSize]), type: 'vec2<f32>' },
          uShapeGrid: {
            value: new Float32Array([shapes.columns, shapes.rows]),
            type: 'vec2<f32>',
          },
          uShapeCell: {
            value: new Float32Array([1 / shapes.columns, 1 / shapes.rows]),
            type: 'vec2<f32>',
          },
          // Half a texel, so bilinear sampling at a cell edge cannot reach
          // into the neighbouring sprite.
          uShapeInset: { value: 0.5 / shapes.cellPx, type: 'f32' },
        },
      },
    })

    this.#indices = new Uint32Array(chunkTotal * 6)
    this.#geometry = new Geometry({
      label: 'blockwork-walls',
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
      label: 'blockwork-walls',
      geometry: this.#geometry,
      shader: this.#shader,
    })

    this.#doorContainer = new Container({ label: 'doors' })
    this.container = new Container({ label: 'walls' })
    this.container.addChild(this.#mesh, this.#doorContainer)
  }

  /** Chunks that hold a wall and passed the frustum test on the last `update`. */
  get visibleChunkCount(): number {
    return this.#visibleChunkCount
  }

  /** Chunks awaiting an autotile pass. */
  get dirtyChunkCount(): number {
    return this.#dirtyChunks.length
  }

  get doorCount(): number {
    return this.#doors.size
  }

  get visibleDoorCount(): number {
    return this.#visibleDoorCount
  }

  /**
   * Recolours the materials. Entry `index` is the colour of material index
   * `index`; `null` means the index is not a wall and draws nothing.
   */
  setPalette(palette: readonly (WallAppearance | null)[]): void {
    this.#paletteData.fill(0)
    for (const [index, appearance] of palette.entries()) {
      if (appearance === null || index === 0 || index >= MAX_WALL_MATERIALS) continue
      const at = index * 4
      this.#paletteData[at] = (appearance.colour >> 16) & 0xff
      this.#paletteData[at + 1] = (appearance.colour >> 8) & 0xff
      this.#paletteData[at + 2] = appearance.colour & 0xff
      this.#paletteData[at + 3] = 255
    }
    this.#paletteSource.update()
  }

  /**
   * Points the layer at the simulation's `wallMaterial` array and marks
   * everything dirty. The array is read, never written, and is not copied: the
   * caller keeps ownership and reports later edits through `markDirtyRect`.
   */
  setWalls(wallMaterial: Uint8Array): void {
    const expected = this.mapSize * this.mapSize
    if (wallMaterial.length !== expected) {
      throw new RangeError(
        `wallMaterial must hold ${expected} entries for a ${this.mapSize}x${this.mapSize} map, ` +
          `received ${wallMaterial.length}`,
      )
    }
    this.#walls = wallMaterial
    this.markAllDirty()
  }

  /**
   * Marks every chunk touching a tile rectangle, **grown by one tile**: a wall
   * that appears changes the autotile mask of its eight neighbours, and those
   * may be in the next chunk over.
   */
  markDirtyRect(tileX: number, tileY: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return

    const left = Math.max(0, tileX - 1)
    const top = Math.max(0, tileY - 1)
    const right = Math.min(this.mapSize - 1, tileX + width)
    const bottom = Math.min(this.mapSize - 1, tileY + height)
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

  /** Replaces the whole door set, for a fresh world or a loaded save. */
  setDoors(doors: Iterable<RenderDoor>): void {
    for (const tileIndex of [...this.#doorSprites.keys()]) {
      this.#destroyDoorSprite(tileIndex)
    }
    this.#doors.clear()
    for (const door of doors) {
      this.#doors.set(door.tileIndex, door)
    }
    this.#doorRect = null
    this.markAllDirty()
  }

  /** Adds or replaces one door. Repaints the run it interrupts. */
  setDoor(door: RenderDoor): void {
    this.#doors.set(door.tileIndex, door)
    this.#doorRect = null
    this.#markTileAndNeighbours(door.tileIndex)
  }

  /** Swings a door. A no-op, and not an error, if there is no door there. */
  setDoorOpen(tileIndex: number, open: boolean): void {
    const door = this.#doors.get(tileIndex)
    if (door === undefined || door.open === open) return
    this.#doors.set(tileIndex, { ...door, open })
    this.#markTileAndNeighbours(tileIndex)
  }

  removeDoor(tileIndex: number): void {
    if (!this.#doors.delete(tileIndex)) return
    this.#destroyDoorSprite(tileIndex)
    this.#doorRect = null
    this.#markTileAndNeighbours(tileIndex)
  }

  /**
   * The eight-neighbour autotile mask of a tile, counting doors as wall.
   *
   * This is `wallNeighbourMask` in `sim/world/walls.ts`, computed against the
   * renderer's copy of the same data. Off-grid neighbours read as absent, so a
   * wall against the map edge caps rather than running into nothing.
   */
  neighbourMask(x: number, y: number): number {
    const walls = this.#walls
    if (walls === null) return 0

    let mask = 0
    for (const [dx, dy, bit] of AUTOTILE_OFFSETS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= this.mapSize || ny >= this.mapSize) continue
      if (this.#isWallLike(walls, ny * this.mapSize + nx)) mask |= bit
    }
    return mask
  }

  /** One frame of work: retile whatever changed, then re-cull. */
  update(camera: Camera): void {
    this.#rebuildDirtyChunks()
    const rect = camera.visibleRect()
    this.#cull(rect)
    this.#cullDoors(rect)
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.#geometry.destroy(true)
    this.#shader.destroy(true)
    this.#wallSource.destroy()
    this.#paletteSource.destroy()
    for (const texture of this.#doorTextures) {
      texture.destroy(false)
    }
    this.#shapes.destroy()
    this.#doorAtlas.destroy()
    this.#doors.clear()
    this.#doorSprites.clear()
  }

  #isWallLike(walls: Uint8Array, tileIndex: number): boolean {
    return (walls[tileIndex] ?? 0) !== 0 || this.#doors.has(tileIndex)
  }

  #markChunk(chunk: number): void {
    if (this.#dirtyFlags[chunk] === 1) return
    this.#dirtyFlags[chunk] = 1
    this.#dirtyChunks.push(chunk)
  }

  #markTileAndNeighbours(tileIndex: number): void {
    const y = Math.floor(tileIndex / this.mapSize)
    const x = tileIndex - y * this.mapSize
    this.markDirtyRect(x, y, 1, 1)
  }

  /**
   * Retiles the dirty chunks and uploads once.
   *
   * The upload is whole-texture because Pixi is not given a sub-rectangle by
   * either backend, but it is 193KB on a 220x220 map and happens at most once
   * a frame however many chunks changed. The autotile step itself is a table
   * index per tile, so a fully dirty 220x220 map is 48,400 lookups.
   */
  #rebuildDirtyChunks(): void {
    if (this.#dirtyChunks.length === 0) return

    const walls = this.#walls
    for (const chunk of this.#dirtyChunks) {
      this.#dirtyFlags[chunk] = 0
      if (walls === null) continue

      const startX = (chunk % this.chunksPerAxis) * TERRAIN_CHUNK_TILES
      const startY = Math.floor(chunk / this.chunksPerAxis) * TERRAIN_CHUNK_TILES
      const endX = Math.min(startX + TERRAIN_CHUNK_TILES, this.mapSize)
      const endY = Math.min(startY + TERRAIN_CHUNK_TILES, this.mapSize)

      let content = 0
      for (let y = startY; y < endY; y += 1) {
        const row = y * this.mapSize
        for (let x = startX; x < endX; x += 1) {
          const tileIndex = row + x
          const material = walls[tileIndex] ?? 0
          const door = this.#doors.get(tileIndex)

          if (material === 0 && door === undefined) {
            this.#wallData[tileIndex * 4] = 0
            this.#wallData[tileIndex * 4 + 1] = 0
            continue
          }

          const mask = this.neighbourMask(x, y)

          if (door !== undefined) {
            // A door has cleared the wall segment it sits in (see
            // `construction.ts`), so the mesh draws nothing here and the
            // sprite covers the tile instead.
            this.#wallData[tileIndex * 4] = 0
            this.#wallData[tileIndex * 4 + 1] = 0
            this.#placeDoorSprite(door, x, y, mask)
            continue
          }

          // Counts mesh tiles only. A chunk holding nothing but doors draws
          // its doors as sprites and needs no quad.
          content += 1
          this.#wallData[tileIndex * 4] = material
          // Masked into the table's own range, so always present.
          this.#wallData[tileIndex * 4 + 1] = AUTOTILE_INDEX_BY_MASK[mask & 0xff] ?? 0
        }
      }

      this.#chunkContent[chunk] = content
    }

    this.#dirtyChunks.length = 0
    this.#wallSource.update()
    // A chunk that just gained or lost its last wall changes what is drawn.
    this.#range = EMPTY_RANGE
  }

  #placeDoorSprite(door: RenderDoor, x: number, y: number, mask: number): void {
    const frame: DoorFrame = door.open ? 'open' : 'closed'
    const cell = doorAtlasCell(door.type, doorOrientation(mask), frame)
    const texture = this.#doorTextures[cell]
    if (texture === undefined) return

    let sprite = this.#doorSprites.get(door.tileIndex)
    if (sprite === undefined) {
      sprite = new Sprite({ texture, label: `door-${String(door.tileIndex)}` })
      sprite.setSize(TILE_SIZE, TILE_SIZE)
      this.#doorSprites.set(door.tileIndex, sprite)
      this.#doorContainer.addChild(sprite)
    } else {
      sprite.texture = texture
    }

    sprite.position.set(x * TILE_SIZE, y * TILE_SIZE)
  }

  #destroyDoorSprite(tileIndex: number): void {
    const sprite = this.#doorSprites.get(tileIndex)
    if (sprite === undefined) return
    this.#doorSprites.delete(tileIndex)
    this.#doorContainer.removeChild(sprite)
    sprite.destroy()
  }

  /**
   * Rewrites the index buffer to reference only the visible chunks that hold
   * something, packed at the front. The tail is zeroed, which the GPU sees as
   * degenerate triangles on vertex 0 and discards before rasterising; that
   * keeps the buffer a fixed size, so culling never reallocates mid-pan.
   */
  #cull(rect: WorldRect): void {
    const range = chunkRange(rect, this.chunksPerAxis)
    if (sameRange(range, this.#range)) return
    this.#range = range

    let write = 0
    let visible = 0
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
        const chunk = row * this.chunksPerAxis + column
        if ((this.#chunkContent[chunk] ?? 0) === 0) continue

        const vertex = chunk * 4
        this.#indices[write] = vertex
        this.#indices[write + 1] = vertex + 1
        this.#indices[write + 2] = vertex + 2
        this.#indices[write + 3] = vertex
        this.#indices[write + 4] = vertex + 2
        this.#indices[write + 5] = vertex + 3
        write += 6
        visible += 1
      }
    }

    this.#visibleChunkCount = visible
    this.#indices.fill(0, write)
    this.#geometry.getIndex().update()
  }

  /**
   * Hides off-screen door sprites. They all share one texture, so the visible
   * ones still batch into a single draw call; this only saves the vertex work
   * of a few hundred quads, which is why it is skipped while the view is still.
   */
  #cullDoors(rect: WorldRect): void {
    const previous = this.#doorRect
    if (
      previous !== null &&
      previous.left === rect.left &&
      previous.top === rect.top &&
      previous.right === rect.right &&
      previous.bottom === rect.bottom
    ) {
      return
    }
    this.#doorRect = rect

    let visible = 0
    for (const [tileIndex, sprite] of this.#doorSprites) {
      const y = Math.floor(tileIndex / this.mapSize)
      const x = tileIndex - y * this.mapSize
      const left = x * TILE_SIZE
      const top = y * TILE_SIZE
      const onScreen =
        left + TILE_SIZE >= rect.left &&
        left <= rect.right &&
        top + TILE_SIZE >= rect.top &&
        top <= rect.bottom

      sprite.renderable = onScreen
      if (onScreen) visible += 1
    }
    this.#visibleDoorCount = visible
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Which chunks of a `chunksPerAxis` grid a world rectangle touches. */
function chunkRange(rect: WorldRect, chunksPerAxis: number): ChunkRange {
  const firstColumn = Math.max(0, Math.floor(rect.left / TERRAIN_CHUNK_WORLD))
  const lastColumn = Math.min(chunksPerAxis - 1, Math.floor(rect.right / TERRAIN_CHUNK_WORLD))
  const firstRow = Math.max(0, Math.floor(rect.top / TERRAIN_CHUNK_WORLD))
  const lastRow = Math.min(chunksPerAxis - 1, Math.floor(rect.bottom / TERRAIN_CHUNK_WORLD))

  if (lastColumn < firstColumn || lastRow < firstRow) return EMPTY_RANGE

  return { firstColumn, firstRow, lastColumn, lastRow }
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
