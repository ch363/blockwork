import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import { CURRENT_SAVE_VERSION, SaveError, encodeSaveFile, readSaveHeader } from '@blockwork/sim'
import type { SaveFile } from '@blockwork/sim'

import {
  AUTOSAVE_SLOT_COUNT,
  MAX_SAVE_NAME_LENGTH,
  SaveStore,
  autosaveKey,
  manualSaveKey,
  nextAutosaveSlot,
} from '../../src/save/store'
import type { SaveDescriptor, SaveSummary } from '../../src/save/store'

/**
 * A save file with no world in it. The store never inflates a payload — it
 * reads the header and keeps the bytes — so the cheapest valid container is
 * the right fixture here, and the format's own tests cover the rest.
 */
function emptySaveFile(overrides: Partial<SaveFile> = {}): SaveFile {
  return {
    version: CURRENT_SAVE_VERSION,
    seed: 1,
    createdAt: '2031-03-12T14:05:00.000Z',
    playedTicks: 0,
    mapSize: 8,
    settings: {},
    grid: {
      floorMaterial: '',
      wallMaterial: '',
      roomId: '',
      sectorId: '',
      objectId: '',
      passability: '',
      dirt: '',
      temperature: '',
      powerGridId: '',
      waterGridId: '',
      outdoors: '',
      owned: '',
    },
    entities: [],
    rooms: [],
    nextRoomId: 1,
    sectors: { nextSectorId: 1, sectors: [] },
    economy: {
      balance: 0,
      loanPrincipal: 0,
      insolvencyDeadlineTick: null,
      entries: [],
    },
    directorate: { completed: [], active: [] },
    grading: { roomGrades: [], lastEntitlementTick: [], averageCellGrade: 0 },
    programs: { enrolments: [], completions: [], pins: [] },
    grades: { confinement: [] },
    parole: { queue: [], hearingsToday: 0, hearingDay: 0 },
    release: {
      released: [],
      lifetimeReleased: 0,
      lifetimeReoffended: 0,
      paroleReoffences: [],
      recidivismWarned: false,
    },
    intelligence: {
      informants: [],
      revealedStashIds: [],
      revealedThrowInIds: [],
      lastBlowRollDay: -1,
    },
    contracts: { active: [], finished: [], revealed: [] },
    routines: {},
    standingOrders: {
      misconduct: {},
      reassignmentStrictness: 'lenient',
      mealQuantity: 'normal',
      mealVariety: 2,
    },
    posts: { nextPostId: 1, nextRouteId: 1, posts: [], routes: [] },
    contraband: {
      nextStashId: 1,
      nextThrowInId: 1,
      confiscatedCount: 0,
      pendingArrivalIds: [],
      pendingDeliveryLines: [],
      stashes: [],
      throwIns: [],
      prices: [],
    },
    fire: { size: 8, burning: [], smoke: [], overloadedBranches: [] },
    riot: {
      active: false,
      riotingInmateIds: [],
      quietMinutes: 0,
      startedAtTick: 0,
      doorBreakProgress: [],
    },
    emergency: {
      sectorLockdowns: [],
      fullLockdown: false,
      riotSquadActive: false,
      riotSquadStaffIds: [],
      freeFireActive: false,
      freeFirePenaltiesApplied: false,
      nationalGuardActive: false,
      nationalGuardStaffIds: [],
      playerFired: false,
      riotFailureEnabled: true,
      warningAtTick: null,
      failureAtTick: null,
      warningEmitted: false,
      failed: false,
      prPenalty: 0,
      riotSquadLastWageTick: 0,
    },
    escapes: {
      nextTunnelId: 1,
      tunnels: [],
      breachedDoorTiles: [],
      pendingEscapes: [],
      escapesToday: 0,
      escapesYesterday: 0,
      accountedDay: 1,
      warningActive: false,
      failed: false,
      totalEscapes: 0,
    },
    combat: {
      nextFightId: 1,
      fights: [],
      corpses: { nextId: 1, list: [] },
      vestWearers: [],
      stunCharges: [],
      stunRechargeAt: [],
      overdoses: [],
      clinicEscortQueued: [],
      staffHealth: [],
      staffStatus: [],
      staffInventory: [],
    },
    punishments: { active: [], agitatorBoostUntil: [] },
    utilities: { cableTiles: [], pipeTiles: [] },
    dangerLevel: 0,
    riotActive: false,
    lockdownActive: false,
    misconductWindowTicks: [],
    log: [],
    rngState: { seed: 1, streams: [] },
    ...overrides,
  }
}

function descriptor(playedTicks: number): SaveDescriptor {
  return { savedAt: '2031-03-12T14:05:00.000Z', playedTicks, mapSize: 220 }
}

let store: SaveStore
let counter = 0

beforeEach(async () => {
  // A fresh factory per test: IndexedDB is global state and a store that
  // remembers the previous test's saves would make rotation untestable.
  globalThis.indexedDB = new IDBFactory()
  counter += 1
  store = await SaveStore.open(`blockwork-saves-test-${counter}`)
})

async function bytesFor(playedTicks: number, version = CURRENT_SAVE_VERSION): Promise<Uint8Array> {
  return encodeSaveFile(emptySaveFile({ playedTicks, version }))
}

describe('nextAutosaveSlot (PRD 7.4)', () => {
  function summary(slot: number, sequence: number): SaveSummary {
    return {
      key: autosaveKey(slot),
      kind: 'auto',
      name: `Autosave ${slot + 1}`,
      slot,
      sequence,
      savedAt: '2031-03-12T14:05:00.000Z',
      schemaVersion: CURRENT_SAVE_VERSION,
      playedTicks: 0,
      mapSize: 220,
      byteLength: 0,
    }
  }

  it('fills empty slots before it overwrites anything', () => {
    expect(nextAutosaveSlot([])).toBe(0)
    expect(nextAutosaveSlot([summary(0, 1)])).toBe(1)
    expect(nextAutosaveSlot([summary(0, 1), summary(1, 2)])).toBe(2)
  })

  it('overwrites the lowest sequence once every slot is in use', () => {
    const full = [summary(0, 7), summary(1, 3), summary(2, 9), summary(3, 8), summary(4, 6)]
    expect(nextAutosaveSlot(full)).toBe(1)
  })

  it('ignores the clock, so a device whose time moved backwards still rotates', () => {
    const full = [summary(0, 10), summary(1, 11), summary(2, 12), summary(3, 13), summary(4, 14)]
    expect(nextAutosaveSlot(full)).toBe(0)
  })

  it('ignores manual saves when choosing a slot', () => {
    const manual: SaveSummary = { ...summary(0, 1), key: 'manual:x', kind: 'manual', slot: -1 }
    expect(nextAutosaveSlot([manual])).toBe(0)
  })
})

describe('the save store (PRD 7.4)', () => {
  it('round-trips the exact container bytes', async () => {
    const bytes = await bytesFor(600)
    await store.putAutosave(bytes, descriptor(600))

    const read = await store.read(autosaveKey(0))
    expect(read).not.toBeNull()
    expect([...(read ?? [])]).toEqual([...bytes])
  })

  it('returns null for a save that is not there', async () => {
    expect(await store.read('manual:nothing')).toBeNull()
  })

  it('denormalises the header and descriptor so listing never inflates a payload', async () => {
    const bytes = await bytesFor(1_200)
    const written = await store.putAutosave(bytes, descriptor(1_200))

    expect(written.schemaVersion).toBe(readSaveHeader(bytes).schemaVersion)
    expect(written.playedTicks).toBe(1_200)
    expect(written.mapSize).toBe(220)
    expect(written.byteLength).toBe(bytes.byteLength)
  })

  it('rotates through exactly five autosave slots', async () => {
    for (let write = 0; write < AUTOSAVE_SLOT_COUNT; write += 1) {
      const written = await store.putAutosave(await bytesFor(write), descriptor(write))
      expect(written.slot).toBe(write)
    }

    const saves = await store.list()
    expect(saves).toHaveLength(AUTOSAVE_SLOT_COUNT)
    expect([...saves].map((save) => save.slot).sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('overwrites the oldest autosave on the sixth write, keeping five', async () => {
    for (let write = 0; write < AUTOSAVE_SLOT_COUNT + 3; write += 1) {
      await store.putAutosave(await bytesFor(write), descriptor(write))
    }

    const saves = await store.list()
    expect(saves).toHaveLength(AUTOSAVE_SLOT_COUNT)
    // Writes 0, 1 and 2 were overwritten by 5, 6 and 7.
    expect(saves.map((save) => save.playedTicks).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7])
  })

  it('never loses the newest autosave to rotation', async () => {
    for (let write = 0; write < 20; write += 1) {
      await store.putAutosave(await bytesFor(write), descriptor(write))
      const saves = await store.list()
      expect(saves[0]?.playedTicks, `after write ${write}`).toBe(write)
    }
  })

  it('keeps named saves alongside the rotation, untouched by it', async () => {
    await store.putManualSave('Wing C before the riot', await bytesFor(99), descriptor(99))
    for (let write = 0; write < 12; write += 1) {
      await store.putAutosave(await bytesFor(write), descriptor(write))
    }

    const saves = await store.list()
    expect(saves.filter((save) => save.kind === 'auto')).toHaveLength(AUTOSAVE_SLOT_COUNT)

    const manual = saves.filter((save) => save.kind === 'manual')
    expect(manual).toHaveLength(1)
    expect(manual[0]?.name).toBe('Wing C before the riot')
    expect(manual[0]?.slot).toBe(-1)
  })

  it('replaces a named save of the same name rather than accumulating', async () => {
    await store.putManualSave('Same name', await bytesFor(1), descriptor(1))
    await store.putManualSave('Same name', await bytesFor(2), descriptor(2))

    const saves = await store.list()
    expect(saves).toHaveLength(1)
    expect(saves[0]?.playedTicks).toBe(2)
  })

  it('trims a name and refuses an empty or overlong one', async () => {
    const bytes = await bytesFor(1)
    const written = await store.putManualSave('  Padded  ', bytes, descriptor(1))
    expect(written.key).toBe(manualSaveKey('Padded'))

    await expect(store.putManualSave('   ', bytes, descriptor(1))).rejects.toThrow(SaveError)
    await expect(
      store.putManualSave('x'.repeat(MAX_SAVE_NAME_LENGTH + 1), bytes, descriptor(1)),
    ).rejects.toThrow(/at most 64 characters/)
  })

  it('lists newest first, by write order rather than by timestamp', async () => {
    await store.putAutosave(await bytesFor(10), descriptor(10))
    await store.putManualSave('Second', await bytesFor(20), descriptor(20))
    await store.putAutosave(await bytesFor(30), descriptor(30))

    expect((await store.list()).map((save) => save.playedTicks)).toEqual([30, 20, 10])
  })

  it('deletes a save, and deleting one that is gone is not an error', async () => {
    await store.putManualSave('Doomed', await bytesFor(1), descriptor(1))
    await store.delete(manualSaveKey('Doomed'))

    expect(await store.list()).toEqual([])
    await expect(store.delete(manualSaveKey('Doomed'))).resolves.toBeUndefined()
  })

  it('refuses bytes that are not a save, so a listing can be trusted', async () => {
    const notASave = new Uint8Array(64)
    await expect(store.putAutosave(notASave, descriptor(1))).rejects.toThrow(SaveError)
    expect(await store.list()).toEqual([])
  })

  it('records the schema version of an older file it is asked to hold', async () => {
    const written = await store.putManualSave('Old', await bytesFor(5, 1), descriptor(5))
    expect(written.schemaVersion).toBe(1)
  })

  it('survives being closed and reopened', async () => {
    const name = `blockwork-saves-test-${counter}`
    await store.putManualSave('Persisted', await bytesFor(7), descriptor(7))
    store.close()

    const reopened = await SaveStore.open(name)
    expect((await reopened.list()).map((save) => save.name)).toEqual(['Persisted'])
    reopened.close()
  })
})
