/**
 * Tap-to-select hit testing (T2.9).
 *
 * Priority matches the ticket: entities in the snapshot first, then tiles.
 * Entity positions are world units (PRD 4.3: 32 world units per tile). The
 * tile the finger landed on is already resolved by the tool input controller;
 * this only answers "is there a person or object on that tile?".
 */

/** PRD 4.3. Duplicated here so `packages/ui` never imports `@blockwork/render`. */
export const WORLD_UNITS_PER_TILE = 32

/** The fields hit-testing needs from a snapshot entity. */
export interface HitTestEntity {
  readonly id: number
  readonly x: number
  readonly y: number
}

/**
 * The entity whose feet are on `tile`, or `null` when the tile is empty of
 * mobile entities. When several occupy the same tile, the closest to the tile
 * centre wins — deterministic, no RNG.
 */
export function hitTestEntities(
  entities: readonly HitTestEntity[],
  tileX: number,
  tileY: number,
  tileSize: number = WORLD_UNITS_PER_TILE,
): number | null {
  const centreX = (tileX + 0.5) * tileSize
  const centreY = (tileY + 0.5) * tileSize

  let bestId: number | null = null
  let bestDist = Number.POSITIVE_INFINITY

  for (const entity of entities) {
    const ex = Math.floor(entity.x / tileSize)
    const ey = Math.floor(entity.y / tileSize)
    if (ex !== tileX || ey !== tileY) continue

    const dx = entity.x - centreX
    const dy = entity.y - centreY
    const dist = dx * dx + dy * dy
    if (dist < bestDist || (dist === bestDist && (bestId === null || entity.id < bestId))) {
      bestDist = dist
      bestId = entity.id
    }
  }

  return bestId
}

/**
 * Full selection resolution: entity id, or `null` to fall through to a tile
 * inspect on the worker.
 */
export function resolveWorldTap(
  entities: readonly HitTestEntity[],
  tileX: number,
  tileY: number,
): { readonly kind: 'entity'; readonly entityId: number } | { readonly kind: 'tile' } {
  const entityId = hitTestEntities(entities, tileX, tileY)
  if (entityId !== null) return { kind: 'entity', entityId }
  return { kind: 'tile' }
}
