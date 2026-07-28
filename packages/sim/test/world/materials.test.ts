import { describe, expect, it } from 'vitest'

import {
  MAX_MATERIALS,
  MaterialTable,
  NO_MATERIAL,
  NO_MATERIAL_ID,
} from '../../src/world/materials'
import { TileGrid } from '../../src/world/tileGrid'

describe('MaterialTable (PRD 4.3)', () => {
  it('reserves index 0 for the empty slot', () => {
    const table = MaterialTable.empty()

    expect(NO_MATERIAL).toBe(0)
    expect(table.size).toBe(1)
    expect(table.idAt(NO_MATERIAL)).toBe(NO_MATERIAL_ID)
    expect(table.isNone(NO_MATERIAL)).toBe(true)
  })

  it('indexes materials in the order they were supplied, after the empty slot', () => {
    const table = MaterialTable.from(['concrete', 'tiles', 'brick'])

    expect(table.size).toBe(4)
    expect(table.ids()).toEqual([NO_MATERIAL_ID, 'concrete', 'tiles', 'brick'])
    expect(table.indexOf('concrete')).toBe(1)
    expect(table.indexOf('brick')).toBe(3)
    expect(table.idAt(2)).toBe('tiles')
    expect(table.isNone(1)).toBe(false)
  })

  it('reports unknown materials rather than guessing', () => {
    const table = MaterialTable.from(['concrete'])

    expect(table.has('concrete')).toBe(true)
    expect(table.has('marble')).toBe(false)
    expect(table.tryIndexOf('marble')).toBeUndefined()
    expect(() => table.indexOf('marble')).toThrow(/unknown material/)
    expect(() => table.idAt(9)).toThrow(RangeError)
  })

  it('rejects duplicates, empty ids and the reserved id', () => {
    expect(() => MaterialTable.from(['concrete', 'concrete'])).toThrow(/duplicate/)
    expect(() => MaterialTable.from([''])).toThrow(TypeError)
    expect(() => MaterialTable.from([NO_MATERIAL_ID])).toThrow(/reserved/)
  })

  it('will not exceed the Uint8 width the grid stores it in', () => {
    const ids = Array.from({ length: MAX_MATERIALS - 1 }, (_, i) => `material_${i}`)
    const table = MaterialTable.from(ids)

    expect(table.size).toBe(MAX_MATERIALS)
    expect(table.indexOf('material_254')).toBe(255)
    expect(() => MaterialTable.from([...ids, 'one_too_many'])).toThrow(RangeError)
  })

  it('produces indices the grid can store', () => {
    const table = MaterialTable.from(['concrete', 'tiles'])
    const grid = TileGrid.allocate(8)

    grid.set('floorMaterial', 1, 1, table.indexOf('tiles'))
    grid.set('wallMaterial', 1, 1, table.indexOf('concrete'))

    expect(table.idAt(grid.get('floorMaterial', 1, 1))).toBe('tiles')
    expect(table.idAt(grid.get('wallMaterial', 1, 1))).toBe('concrete')
    // Untouched tiles read as the empty slot: bare ground and no wall.
    expect(table.isNone(grid.get('floorMaterial', 2, 1))).toBe(true)
    expect(table.isNone(grid.get('wallMaterial', 2, 1))).toBe(true)
  })
})
