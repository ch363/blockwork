import { describe, expect, it } from 'vitest'

import { GameDataError, loadGameData } from '../../src/data/loader'
import { GAME_DATA_FILES, ID_PATTERN } from '../../src/data/schemas'
import { NO_MATERIAL_ID } from '../../src/world/materials'

import { cloneRawData, defOf, fileOf, listOf } from './rawData'

/** Loaded once: the real files are the subject of every assertion here. */
const data = loadGameData()

describe('loadGameData, happy path against the real files', () => {
  it('loads every definition file without throwing', () => {
    expect(() => loadGameData()).not.toThrow()
  })

  it('holds the v1 content lists from the PRD', () => {
    // PRD 5.4 lists 19 needs, 5.1 lists 32 rooms, 5.5 six categories, fourteen
    // traits and a forty-entry conviction table, 5.6 twenty staff roles
    // including the per-session ones, 5.8 thirty-four Directorate nodes, and
    // 5.9 eleven programs.
    expect(data.needs.size).toBe(19)
    expect(data.rooms.size).toBe(32)
    expect(data.securityCategories.size).toBe(6)
    expect(data.traits.size).toBe(14)
    expect(data.convictions.size).toBe(40)
    expect(data.staff.size).toBe(20)
    expect(data.directorate.size).toBe(34)
    expect(data.programs.size).toBe(11)

    // PRD 5.3 targets 90 objects in v1.
    expect(data.objects.size).toBeGreaterThanOrEqual(90)
    expect(data.contraband.size).toBeGreaterThanOrEqual(30)
    expect(data.contracts.size).toBeGreaterThanOrEqual(6)
    expect(data.materials.size).toBeGreaterThanOrEqual(10)
  })

  it('gives every definition a unique lower_snake_case id', () => {
    const registries = [
      data.materials,
      data.supplies,
      data.needs,
      data.rooms,
      data.objects,
      data.staff,
      data.directorate,
      data.programs,
      data.contraband,
      data.contracts,
      data.securityCategories,
      data.traits,
      data.reputations,
      data.convictions,
    ]

    for (const registry of registries) {
      const ids = registry.ids()
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(id).toMatch(ID_PATTERN)
      }
    }
  })

  it('never defines the reserved empty material slot', () => {
    expect(data.materials.has(NO_MATERIAL_ID)).toBe(false)
  })

  it('grades exactly the rooms PRD 5.2 names', () => {
    const graded = data.rooms.all.filter((room) => room.graded).map((room) => room.id)
    expect(graded.sort()).toEqual(
      ['cell', 'classroom', 'dayroom', 'dormitory', 'exercise_yard', 'mess_hall'].sort(),
    )
  })

  it('exposes need order as a stable index, because saves store the index', () => {
    // T2.5 keys each inmate's Float32Array by this index. If the order of
    // needs.json changes, saved need arrays are silently misread, so the first
    // and last entries are pinned here as a tripwire.
    expect(data.needs.indexOf('bladder')).toBe(0)
    expect(data.needs.indexOf('luxury')).toBe(data.needs.size - 1)
    expect(data.needs.indexOf('not_a_need')).toBe(-1)
  })

  it('prices every security category and gives each a misconduct base rate', () => {
    const rates = data.balance.misconduct.baseRatePer10MinutesByCategory
    for (const category of data.securityCategories.all) {
      expect(rates[category.id]).toBeTypeOf('number')
    }
    expect(Object.keys(rates).length).toBe(data.securityCategories.size)
  })

  it('derives what each Directorate node unlocks from the back-references', () => {
    expect(data.unlocks.size).toBe(data.directorate.size)

    const medical = data.unlocks.get('medical')
    expect(medical?.rooms).toContain('clinic')
    expect(medical?.rooms).toContain('mortuary')
    expect(medical?.staff).toContain('medic')
    expect(medical?.programs).toContain('substance_treatment')

    const securityOffice = data.unlocks.get('security_office')
    expect(securityOffice?.staff).toContain('security_director')
    expect(securityOffice?.features).toContain('danger_meter')

    // Condemned inmates are gated behind Capital Cases (PRD 5.5).
    expect(data.unlocks.get('capital_cases')?.securityCategories).toContain('condemned')
  })

  it('resolves definitions by id and reports unknown ones', () => {
    expect(data.rooms.get('cell').name).toBe('Cell')
    expect(data.rooms.find('no_such_room')).toBeUndefined()
    expect(() => data.rooms.get('no_such_room')).toThrow(/unknown definition 'no_such_room'/)
  })

  it('marks placeholder balance values so the tuning pass can find them', () => {
    // Rule from the ticket: values the PRD does not specify carry `_tuning`.
    const tunable = data.objects.all.filter((object) => object._tuning === true)
    expect(tunable.length).toBeGreaterThan(0)
    expect(data.balance.economy._tuning).toBe(true)
  })
})

describe('loadGameData, shape validation', () => {
  it('rejects an unknown key on a definition', () => {
    const raw = cloneRawData()
    defOf(raw, 'rooms', 'rooms', 'cell')['sizeInAcres'] = 3

    expect(() => loadGameData(raw)).toThrow(GameDataError)
    expect(() => loadGameData(raw)).toThrow(/rooms\.json rooms\[0\]/)
    expect(() => loadGameData(raw)).toThrow(/sizeInAcres/)
  })

  it('rejects an unknown key nested inside a definition', () => {
    const raw = cloneRawData()
    const balance = fileOf(raw, 'balance')
    const kitchen = balance['kitchen'] as Record<string, unknown>
    kitchen['mealsPerMinute'] = 4

    expect(() => loadGameData(raw)).toThrow(/balance\.json kitchen/)
  })

  it('rejects a missing required field', () => {
    const raw = cloneRawData()
    const bed = defOf(raw, 'objects', 'objects', 'bed')
    delete bed['hp']

    expect(() => loadGameData(raw)).toThrow(/objects\.json objects\[0\]\.hp/)
  })

  it('rejects an id that is not lower_snake_case', () => {
    const raw = cloneRawData()
    defOf(raw, 'needs', 'needs', 'bladder')['id'] = 'Bladder'

    expect(() => loadGameData(raw)).toThrow(/needs\.json needs\[0\]\.id/)
  })

  it('reports a missing file rather than loading a partial dataset', () => {
    const raw = cloneRawData()
    delete (raw as Record<string, unknown>)['contraband']

    expect(() => loadGameData(raw)).toThrow(/contraband\.json <root>: file is missing/)
  })

  it('collects every shape problem in one throw', () => {
    const raw = cloneRawData()
    defOf(raw, 'rooms', 'rooms', 'cell')['nonsense'] = true
    defOf(raw, 'rooms', 'rooms', 'kitchen')['alsoNonsense'] = true

    try {
      loadGameData(raw)
      expect.unreachable('expected the load to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GameDataError)
      expect((error as GameDataError).issues.length).toBe(2)
    }
  })
})

describe('loadGameData, identity checks', () => {
  it('rejects a duplicate id, naming both positions', () => {
    const raw = cloneRawData()
    const rooms = listOf(raw, 'rooms', 'rooms')
    rooms.push(JSON.parse(JSON.stringify(rooms[0])) as Record<string, unknown>)

    expect(() => loadGameData(raw)).toThrow(/duplicate id 'cell', first defined at \[0\]/)
  })

  it('rejects a material claiming the reserved empty slot id', () => {
    const raw = cloneRawData()
    defOf(raw, 'materials', 'materials', 'concrete_floor')['id'] = NO_MATERIAL_ID

    expect(() => loadGameData(raw)).toThrow(/reserved for the empty tile slot/)
  })

  it('rejects a supply whose id collides with a material', () => {
    const raw = cloneRawData()
    defOf(raw, 'materials', 'supplies', 'timber')['id'] = 'brick_wall'

    expect(() => loadGameData(raw)).toThrow(/collides with a material of the same id/)
  })
})

describe('the shipped data files', () => {
  it('are all present in the raw export', () => {
    const raw = cloneRawData()
    for (const file of GAME_DATA_FILES) {
      expect(raw[file], `${file}.json`).toBeDefined()
    }
  })
})
