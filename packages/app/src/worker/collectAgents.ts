/**
 * Snapshot entity collection for the live game (T2.8 + T2.9 wiring).
 *
 * The worker publishes drawable agents after every step. Presentation colours
 * and mood pins are packed here using the render package's flag contract so
 * the main thread can rebuild `RenderAgent` poses without another round trip.
 */

import {
  AGENT_FACING,
  AGENT_WALK_FRAMES,
  moodNeedIdFromIndex,
  moodNeedIndexFromId,
  packAgentFlags,
  STAFF_UNIFORM_COLOUR,
  uniformColourForCategory,
} from '@blockwork/render'
import type { RenderAgent } from '@blockwork/render'
import {
  housingCapacity,
  type GameData,
  type InmateEntity,
  type InmateWorld,
  type SnapshotEntity,
  type StaffEntity,
  type UiDigest,
} from '@blockwork/sim'

/** High bit marks a staff snapshot id so inmate/staff registries never collide. */
export const SNAPSHOT_STAFF_ID_FLAG = 0x4000_0000

export function snapshotIdForInmate(id: number): number {
  return id
}

export function snapshotIdForStaff(id: number): number {
  return id | SNAPSHOT_STAFF_ID_FLAG
}

export function isStaffSnapshotId(snapshotId: number): boolean {
  return (snapshotId & SNAPSHOT_STAFF_ID_FLAG) !== 0
}

export function entityIdFromSnapshot(snapshotId: number): number {
  return snapshotId & ~SNAPSHOT_STAFF_ID_FLAG
}

/**
 * Fills `out` with every drawable inmate and staff shell for the current tick.
 */
export function collectGameEntities(
  world: InmateWorld,
  data: GameData,
  tick: number,
  out: SnapshotEntity[],
): void {
  const categories = data.securityCategories.ids()
  const needIds = data.needs.ids()

  for (const inmate of world.inmates.all()) {
    out.push(packInmate(inmate, categories, needIds, tick))
  }
  for (const staff of world.staff.all()) {
    out.push(packStaff(staff, tick))
  }
}

export function buildGameDigest(world: InmateWorld, alerts: number): UiDigest {
  return {
    // The ledger is authoritative (T3.6). The snapshot header carries a signed
    // 32-bit balance, so a prison deep in debt clamps rather than throwing.
    balance: clampInt32(Math.round(world.economy.balance)),
    danger: Math.max(0, Math.min(100, Math.round(world.dangerLevel))),
    population: world.inmates.size,
    alerts,
  }
}

function clampInt32(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, value))
}

/** Beds / holding capacity for the top bar. */
export function currentHousingCapacity(world: InmateWorld): number {
  return housingCapacity(world.rooms, world.objects)
}

export function snapshotEntityToRenderAgent(
  entity: SnapshotEntity,
  options: {
    readonly categoryIds: readonly string[]
    readonly selectedId: number | null
  },
): RenderAgent {
  const staff = isStaffSnapshotId(entity.id)
  const categoryId = options.categoryIds[entity.kind] ?? 'medium'
  const colour = staff ? STAFF_UNIFORM_COLOUR : uniformColourForCategory(categoryId)
  const idle = (entity.flags & 0b10) !== 0
  const selected = entity.id === options.selectedId || (entity.flags & 0b1) !== 0
  const moodSlot = (entity.flags >> 2) & 0x3f
  const moodNeedId = moodSlot === 0 ? null : moodNeedIdFromIndex(moodSlot - 1)

  return {
    id: entity.id,
    x: entity.x,
    y: entity.y,
    facing: entity.facing % 4,
    walkFrame: entity.spriteIndex % AGENT_WALK_FRAMES,
    idle,
    colour,
    moodNeedId,
    selected,
  }
}

function packInmate(
  entity: InmateEntity,
  categories: readonly string[],
  needIds: readonly string[],
  tick: number,
): SnapshotEntity {
  const idle = entity.dx === 0 && entity.dy === 0
  const moodNeedId = worstNeedId(entity.inmate.needs, needIds)
  const moodNeedIndex = moodNeedId === null ? null : moodNeedIndexFromId(moodNeedId)
  const kind = Math.max(0, categories.indexOf(entity.inmate.category))
  return {
    id: snapshotIdForInmate(entity.id),
    x: entity.x,
    y: entity.y,
    kind: kind & 0xff,
    spriteIndex: idle ? 0 : (Math.floor(tick / 2) + entity.id) % AGENT_WALK_FRAMES,
    facing: facingFromDelta(entity.dx, entity.dy),
    flags: packAgentFlags({
      idle,
      ...(moodNeedIndex === null || moodNeedIndex < 0 ? {} : { moodNeedIndex }),
    }),
  }
}

function packStaff(entity: StaffEntity, tick: number): SnapshotEntity {
  const idle = entity.staff.duty.kind === 'idle'
  return {
    id: snapshotIdForStaff(entity.id),
    x: entity.x,
    y: entity.y,
    kind: 0xff,
    spriteIndex: idle ? 0 : (Math.floor(tick / 2) + entity.id) % AGENT_WALK_FRAMES,
    facing: AGENT_FACING.SOUTH,
    flags: packAgentFlags({ idle }),
  }
}

function facingFromDelta(dx: number, dy: number): number {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? AGENT_FACING.EAST : AGENT_FACING.WEST
  }
  if (dy < 0) return AGENT_FACING.NORTH
  return AGENT_FACING.SOUTH
}

/**
 * Highest need value that has a mood pin. Threshold matches the inspector's
 * "high" band (60+) so pins appear before critical behaviours fire.
 */
function worstNeedId(needs: Float32Array, needIds: readonly string[]): string | null {
  let bestId: string | null = null
  let bestValue = 60
  for (let i = 0; i < needIds.length; i += 1) {
    const value = needs[i] ?? 0
    if (value < bestValue) continue
    const id = needIds[i]
    if (id === undefined) continue
    if (moodNeedIndexFromId(id) < 0) continue
    bestValue = value
    bestId = id
  }
  return bestId
}
