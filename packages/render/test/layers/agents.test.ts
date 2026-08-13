import { describe, expect, it } from 'vitest'

import {
  AGENT_ATLAS_BODY_ROWS,
  AGENT_ATLAS_COLUMNS,
  AGENT_FACING,
  AGENT_FLAG,
  AGENT_MOOD_NEED_IDS,
  agentBodyCell,
  agentFlagsIdle,
  agentFlagsMoodIndex,
  agentFlagsSelected,
  agentUniformCell,
  interpolateAgents,
  moodNeedIdFromIndex,
  moodNeedIndexFromId,
  packAgentFlags,
  uniformColourForCategory,
} from '../../src/layers/agents'
import type { RenderAgent } from '../../src/layers/agents'

function agent(partial: Partial<RenderAgent> & Pick<RenderAgent, 'id' | 'x' | 'y'>): RenderAgent {
  return {
    facing: AGENT_FACING.SOUTH,
    walkFrame: 0,
    idle: true,
    colour: 0xe08b3d,
    moodNeedId: null,
    selected: false,
    ...partial,
  }
}

describe('interpolateAgents', () => {
  it('returns the previous pose at alpha 0', () => {
    const previous = [agent({ id: 1, x: 0, y: 10, walkFrame: 0 })]
    const next = [agent({ id: 1, x: 32, y: 10, walkFrame: 2, idle: false })]

    expect(interpolateAgents(previous, next, 0)).toEqual(previous)
  })

  it('returns the next pose at alpha 1', () => {
    const previous = [agent({ id: 1, x: 0, y: 10 })]
    const next = [agent({ id: 1, x: 32, y: 10, walkFrame: 3, idle: false })]

    expect(interpolateAgents(previous, next, 1)).toEqual(next)
  })

  it('lerps position between snapshots without snapping', () => {
    const previous = [agent({ id: 1, x: 0, y: 0 })]
    const next = [agent({ id: 1, x: 100, y: 50, idle: false, walkFrame: 1 })]

    const samples = [0, 0.25, 0.5, 0.75, 1].map((alpha) => {
      const [pose] = interpolateAgents(previous, next, alpha)
      // Present after every sample — the id is stable across the lerp.
      expect(pose).toBeDefined()
      return pose as RenderAgent
    })

    expect(samples.map((pose) => pose.x)).toEqual([0, 25, 50, 75, 100])
    expect(samples.map((pose) => pose.y)).toEqual([0, 12.5, 25, 37.5, 50])

    // Consecutive samples move by a constant step: no teleport mid-lerp.
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1] as RenderAgent
      const cur = samples[i] as RenderAgent
      expect(cur.x - prev.x).toBeCloseTo(25, 10)
      expect(cur.y - prev.y).toBeCloseTo(12.5, 10)
    }
  })

  it('takes discrete sprite fields from the destination pose while lerping', () => {
    const previous = [
      agent({
        id: 1,
        x: 0,
        y: 0,
        facing: AGENT_FACING.SOUTH,
        walkFrame: 0,
        idle: true,
        colour: 0x8b93a0,
        moodNeedId: null,
        selected: false,
      }),
    ]
    const next = [
      agent({
        id: 1,
        x: 40,
        y: 0,
        facing: AGENT_FACING.EAST,
        walkFrame: 2,
        idle: false,
        colour: 0xd95151,
        moodNeedId: 'food',
        selected: true,
      }),
    ]

    const mid = interpolateAgents(previous, next, 0.5)[0]
    expect(mid).toMatchObject({
      x: 20,
      y: 0,
      facing: AGENT_FACING.EAST,
      walkFrame: 2,
      idle: false,
      colour: 0xd95151,
      moodNeedId: 'food',
      selected: true,
    })
  })

  it('clamps alpha outside 0..1', () => {
    const previous = [agent({ id: 1, x: 0, y: 0 })]
    const next = [agent({ id: 1, x: 10, y: 0 })]

    expect(interpolateAgents(previous, next, -1)[0]?.x).toBe(0)
    expect(interpolateAgents(previous, next, 2)[0]?.x).toBe(10)
  })

  it('spawns agents that only exist in the next snapshot', () => {
    const previous = [agent({ id: 1, x: 0, y: 0 })]
    const next = [agent({ id: 1, x: 10, y: 0 }), agent({ id: 2, x: 5, y: 5 })]

    const mid = interpolateAgents(previous, next, 0.5)
    expect(mid.map((pose) => pose.id).sort()).toEqual([1, 2])
    expect(mid.find((pose) => pose.id === 2)).toEqual(next[1])
  })

  it('drops agents that left once alpha moves off the previous snapshot', () => {
    const previous = [agent({ id: 1, x: 0, y: 0 }), agent({ id: 2, x: 5, y: 5 })]
    const next = [agent({ id: 1, x: 10, y: 0 })]

    expect(
      interpolateAgents(previous, next, 0)
        .map((pose) => pose.id)
        .sort(),
    ).toEqual([1, 2])
    expect(interpolateAgents(previous, next, 0.01).map((pose) => pose.id)).toEqual([1])
  })

  it('interpolates many agents independently', () => {
    const count = 400
    const previous = Array.from({ length: count }, (_, i) => agent({ id: i + 1, x: i, y: 0 }))
    const next = Array.from({ length: count }, (_, i) =>
      agent({ id: i + 1, x: i + 32, y: 16, idle: false, walkFrame: i % 4 }),
    )

    const mid = interpolateAgents(previous, next, 0.5)
    expect(mid).toHaveLength(count)
    expect(mid[0]).toMatchObject({ id: 1, x: 16, y: 8 })
    expect(mid[399]).toMatchObject({ id: 400, x: 399 + 16, y: 8 })
  })
})

describe('agent flags and atlas indexing', () => {
  it('packs and unpacks selection, idle and mood', () => {
    const foodIndex = moodNeedIndexFromId('food')
    expect(foodIndex).toBeGreaterThanOrEqual(0)

    const flags = packAgentFlags({
      selected: true,
      idle: true,
      moodNeedIndex: foodIndex,
    })

    expect(agentFlagsSelected(flags)).toBe(true)
    expect(agentFlagsIdle(flags)).toBe(true)
    expect(agentFlagsMoodIndex(flags)).toBe(foodIndex)
    expect(moodNeedIdFromIndex(foodIndex)).toBe('food')
    expect(flags & AGENT_FLAG.SELECTED).toBe(AGENT_FLAG.SELECTED)
  })

  it('treats mood index 0 as no pin', () => {
    expect(agentFlagsMoodIndex(0)).toBe(-1)
    expect(moodNeedIdFromIndex(-1)).toBeNull()
  })

  it('keeps body and uniform cells on matching poses', () => {
    const body = agentBodyCell(AGENT_FACING.EAST, 2, false)
    const uniform = agentUniformCell(AGENT_FACING.EAST, 2, false)
    // Uniform block starts immediately after the body facing rows.
    expect(uniform - body).toBe(AGENT_ATLAS_BODY_ROWS * AGENT_ATLAS_COLUMNS)
  })

  it('maps every mood need id to a stable index', () => {
    expect(AGENT_MOOD_NEED_IDS.length).toBe(19)
    for (const [index, id] of AGENT_MOOD_NEED_IDS.entries()) {
      expect(moodNeedIndexFromId(id)).toBe(index)
    }
  })

  it('uses mockup colours for known categories', () => {
    expect(uniformColourForCategory('maximum')).toBe(0xd95151)
    expect(uniformColourForCategory('minimum')).toBe(0x8b93a0)
  })
})
