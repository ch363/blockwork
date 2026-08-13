/**
 * T8.14 — staff HP lives only on `CombatRuntime`, not emergency state.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { emptyCombatState, emptyEmergencyState } from '../../src/save/defaults'
import type { EmergencyStateSnapshot } from '../../src/save/format'
import { consolidateLegacyStaffHealth } from '../../src/save/toWorld'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import { summonCallableStaff } from '../../src/systems/emergencySystem'
import type { SaveState } from '../../src/save/state'
import { makeSaveState } from '../save/fixture'

const DATA = loadGameData()

class NoopEvents {
  emit(): void {}
}

describe('staff health source of truth', () => {
  it('EmergencyState does not carry a staffHealth map', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    expect('staffHealth' in world.emergency).toBe(false)
  })

  it('callable staff summons initialise combat staffHealth only', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    const events = new NoopEvents()
    const ids = summonCallableStaff({
      world,
      defId: DATA.balance.emergency.riotSquadDefId,
      count: 1,
      tick: 0,
      events,
    })
    expect(ids).toHaveLength(1)
    const staffId = ids[0]
    expect(staffId).toBeDefined()
    const key = world.combat.agentKey('staff', staffId ?? 0)
    expect(world.combat.staffHealth.get(key)).toBe(DATA.balance.combat.maxHealth)
    expect('staffHealth' in world.emergency).toBe(false)
  })

  it('merges legacy emergency staffHealth into combat when consolidating saves', () => {
    const base = makeSaveState()
    const legacyEmergency = {
      ...emptyEmergencyState(),
      staffHealth: [{ id: 7, hp: 42 }],
    } as EmergencyStateSnapshot & {
      staffHealth: readonly { readonly id: number; readonly hp: number }[]
    }

    const state: SaveState = {
      ...base,
      emergency: legacyEmergency,
      combat: emptyCombatState(),
    }

    const consolidated = consolidateLegacyStaffHealth(state)

    expect('staffHealth' in consolidated.emergency).toBe(false)
    expect(consolidated.combat.staffHealth).toEqual([{ key: 'staff:7', hp: 42 }])
  })

  it('prefers existing combat staffHealth over legacy emergency entries', () => {
    const base = makeSaveState()
    const legacyEmergency = {
      ...emptyEmergencyState(),
      staffHealth: [{ id: 7, hp: 42 }],
    } as EmergencyStateSnapshot & {
      staffHealth: readonly { readonly id: number; readonly hp: number }[]
    }

    const state: SaveState = {
      ...base,
      emergency: legacyEmergency,
      combat: {
        ...emptyCombatState(),
        staffHealth: [{ key: 'staff:7', hp: 99 }],
      },
    }

    const consolidated = consolidateLegacyStaffHealth(state)

    expect(consolidated.combat.staffHealth).toEqual([{ key: 'staff:7', hp: 99 }])
  })
})
