/**
 * The world's unit system, shared by every render module.
 *
 * `packages/sim` counts in tiles; the renderer counts in **world units**, of
 * which a tile is 32 (PRD 4.3). Keeping the constant in its own module rather
 * than in `index.ts` avoids an import cycle: `index.ts` re-exports the layers,
 * and the layers need the tile size at module scope.
 *
 * World units are not pixels. A world unit is a pixel only at zoom 1; the
 * camera scales them, and the Pixi renderer scales that again by the device
 * pixel ratio. Anything measured in pixels is named `...Px` or `...Screen`.
 */

/** Tile edge length in world units. See PRD 4.3. */
export const TILE_SIZE = 32

/** World units spanned by `tiles` tiles. */
export function tilesToWorld(tiles: number): number {
  return tiles * TILE_SIZE
}

/** The tile a world coordinate falls in. Unclamped; may be outside the map. */
export function worldToTile(world: number): number {
  return Math.floor(world / TILE_SIZE)
}
