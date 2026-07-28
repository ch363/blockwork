/**
 * Procedural sprite atlases: the plumbing behind the placeholder art for
 * walls, doors and objects.
 *
 * PRD 7.7 allows placeholder art through Phase 6 and requires the real thing
 * to be original. Generating it at runtime satisfies both at once, and has a
 * third virtue: there is no binary in the repository that anyone could mistake
 * for someone else's, which is CLAUDE.md rule 1 held to the letter.
 *
 * Two conventions run through every generator here.
 *
 * **Shape and colour are separated.** A cell holds a greyscale shading value
 * in RGB and coverage in alpha; the colour arrives later, as a Pixi `tint` or
 * as a palette texture lookup in a shader. That is what keeps the wall atlas
 * at 47 cells instead of 47 per material, and the object atlas at a handful of
 * shapes instead of one per definition.
 *
 * **Generation is deterministic.** The grain is hash noise, never
 * `Math.random`, so two runs produce byte-identical atlases and a future
 * screenshot comparison cannot fail for want of a seed. Nothing here is
 * simulation state, so CLAUDE.md rule 3 does not reach it, but reproducible is
 * strictly better than random either way.
 *
 * `layers/terrain.ts` predates this module and generates its atlas inline with
 * the same technique. Unifying the two is worth doing when real art lands and
 * both switch to a packed file; doing it now would edit T0.5's tested code for
 * no behavioural gain.
 */

import { CanvasSource, Rectangle, Texture } from 'pixi.js'

/** A generated atlas plus the grid layout its consumers index it by. */
export interface SpriteAtlas {
  readonly texture: Texture
  readonly columns: number
  readonly rows: number
  readonly cellPx: number
  destroy(): void
}

export interface SpriteAtlasOptions {
  /** Cell edge in pixels. One tile of art at zoom 1 is 32. */
  readonly cellPx: number
  readonly columns: number
  readonly rows: number
  /** Shows up in a GPU debugger. */
  readonly label: string
}

/**
 * Hash noise in 0..1. The same coordinate always returns the same value, and
 * neighbouring coordinates are uncorrelated.
 */
export function spriteNoise(x: number, y: number): number {
  let h = Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x2545f491)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 0xffffffff
}

/**
 * A stable 32-bit hash of a string, for deriving a placeholder appearance from
 * a definition id. Never used for anything a player can win or lose.
 */
export function spriteHash(text: string): number {
  let h = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    h ^= text.charCodeAt(at)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A 2D canvas of the requested size, or a clear error about why not. */
export function createSpriteCanvas(
  width: number,
  height: number,
): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (context === null) {
    throw new Error('Blockwork: a 2D canvas context is unavailable, cannot build a sprite atlas')
  }

  return { canvas, context }
}

/**
 * Wraps a painted canvas as an atlas texture.
 *
 * Mipmaps are off and the sampler clamps, for the same reason the terrain
 * atlas does it: cells are indexed by arithmetic, so a mip chain would blend
 * one sprite into the next at low zoom. `linear` filtering is kept, because
 * these are 32px cells drawn at anything from 16 to 128 screen pixels and
 * nearest sampling would alias the diagonal seams badly.
 */
export function spriteAtlasFromCanvas(
  canvas: HTMLCanvasElement,
  options: SpriteAtlasOptions,
): SpriteAtlas {
  const source = new CanvasSource({
    resource: canvas,
    scaleMode: 'linear',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
    label: options.label,
  })

  const texture = new Texture({ source, label: options.label })

  return {
    texture,
    columns: options.columns,
    rows: options.rows,
    cellPx: options.cellPx,
    destroy(): void {
      texture.destroy(true)
    },
  }
}

/**
 * One `Texture` per atlas cell, in row-major order.
 *
 * Every slice shares the atlas's single texture source, which is the point:
 * Pixi's batcher breaks a batch when the texture changes, so a hundred sprites
 * cut from one atlas cost one draw call and a hundred sprites from a hundred
 * textures cost a hundred.
 */
export function sliceAtlas(atlas: SpriteAtlas): readonly Texture[] {
  const textures: Texture[] = []

  for (let row = 0; row < atlas.rows; row += 1) {
    for (let column = 0; column < atlas.columns; column += 1) {
      textures.push(
        new Texture({
          source: atlas.texture.source,
          frame: new Rectangle(
            column * atlas.cellPx,
            row * atlas.cellPx,
            atlas.cellPx,
            atlas.cellPx,
          ),
        }),
      )
    }
  }

  return textures
}

/** `0xRRGGBB` as a CSS colour, so canvas drawing can take the same constants. */
export function cssColour(colour: number, alpha = 1): string {
  const red = (colour >> 16) & 0xff
  const green = (colour >> 8) & 0xff
  const blue = colour & 0xff
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(alpha)})`
}

/** A grey whose channels all carry `value`, clamped to a byte. */
export function greyColour(value: number, alpha = 1): string {
  const level = value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
  return `rgba(${String(level)}, ${String(level)}, ${String(level)}, ${String(alpha)})`
}

/**
 * Multiplies a rectangle's brightness by deterministic per-pixel noise.
 *
 * Run after the shapes are drawn. It works on the pixels rather than through
 * a composite operation because canvas blend modes treat a transparent
 * destination as "paint the source", which would fill the empty half of a
 * capped wall tile with grey. Touching only RGB leaves coverage exactly as the
 * shape drawing left it.
 *
 * A flat 32px block of colour repeated across a wing reads as a rendering
 * error; a little grain reads as a surface.
 */
export function applyGrain(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  strength: number,
): void {
  if (strength <= 0 || width <= 0 || height <= 0) return

  const image = context.getImageData(x, y, width, height)
  const pixels = image.data

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const at = (row * width + column) * 4
      if ((pixels[at + 3] ?? 0) === 0) continue

      const shade = 1 - spriteNoise(x + column, y + row) * strength
      pixels[at] = clampByte((pixels[at] ?? 0) * shade)
      pixels[at + 1] = clampByte((pixels[at + 1] ?? 0) * shade)
      pixels[at + 2] = clampByte((pixels[at + 2] ?? 0) * shade)
    }
  }

  context.putImageData(image, x, y)
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0
}
