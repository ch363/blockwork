import { describe, expect, it } from 'vitest'

import {
  CausalEventLog,
  DEFAULT_SNAPSHOT_LIMITS,
  MAX_SAVED_LOG_ENTRIES,
  NOTIFICATION_SEVERITY,
  Rng,
  createInmateShell,
  generateInmate,
  loadFromBytes,
} from '@blockwork/sim'

import { newestCausalEvents } from '../../src/worker/reportData'
import { SimWorkerLoop } from '../../src/worker/simWorker'

function loop(): SimWorkerLoop {
  return new SimWorkerLoop({
    seed: 0xb10c_0602,
    mapSize: 32,
    limits: DEFAULT_SNAPSHOT_LIMITS,
    post: () => undefined,
    applyOpening: false,
  })
}

describe('worker report snapshots', () => {
  it('enforces Directorate access to Needs, Finance and Intelligence reports', () => {
    const worker = loop()
    const locked = worker.reports()

    expect(locked.needs).toBeNull()
    expect(locked.finance).toBeNull()
    expect(locked.intelligence).toBeNull()
    expect(locked.access.needs.requirement).toBe('Welfare')
    expect(locked.access.finance.requirement).toBe('Finance')
    expect(locked.access.intelligence.requirement).toBe('Intelligence')

    worker.world.directorate.grant('welfare')
    worker.world.directorate.grant('finance')
    worker.world.directorate.grant('intelligence')
    const unlocked = worker.reports()

    expect(unlocked.needs?.rows).toHaveLength(worker.game.data.needs.all.length)
    expect(unlocked.finance?.last7Days.length).toBeGreaterThan(0)
    expect(unlocked.finance?.last7Days.length).toBeLessThanOrEqual(7)
    expect(unlocked.intelligence).not.toBeNull()
  })

  it('keeps registry-qualified event entities and exposes only resolvable traces', async () => {
    const worker = loop()
    worker.events.emit({
      tick: 10,
      kind: 'intake.noHousing',
      causeIds: [],
      data: { inmateId: 7, name: 'Rowan Vale', severity: 'warn' },
    })
    worker.events.emit({
      tick: 11,
      kind: 'utilities.fixtureOffline',
      subjectId: 7,
      causeIds: [],
      data: { objectId: 7, name: 'Sink Seven', severity: 'warn' },
    })
    worker.events.emit({
      tick: 12,
      kind: 'misconduct.committed',
      subjectId: 7,
      causeIds: [],
      data: {
        inmateId: 7,
        name: 'Rowan Vale',
        misconductKind: 'damage',
        punishment: 'isolation',
        durationHours: 2,
        category: 'serious',
      },
    })

    const rows = worker.reports().log
    expect(rows.map((row) => row.entityKey)).toEqual(['inmate:7', 'object:7', 'inmate:7'])
    expect(rows.map((row) => row.entityName)).toEqual([
      'Rowan Vale · #7',
      'Sink Seven · #7',
      'Rowan Vale · #7',
    ])
    expect(rows.map((row) => row.severity)).toEqual(['warn', 'warn', 'warn'])
    expect(rows[0]?.traceId).toBe(rows[0]?.id)
    expect(worker.trace(rows[0]?.traceId ?? 0)).not.toBeNull()
    expect(rows[1]?.traceId).toBeNull()
    expect(rows[2]?.traceId).toBe(rows[2]?.id)
    expect(worker.trace(rows[2]?.traceId ?? 0)).not.toBeNull()

    const { bytes } = await worker.exportSave('2031-07-28T12:00:00.000Z')
    const loaded = await loadFromBytes(bytes)
    const savedIntake = loaded.log.find((row) => row['kind'] === 'intake.noHousing')
    expect(savedIntake?.['severity']).toBe(NOTIFICATION_SEVERITY.WARN)
    expect(savedIntake?.['traceId']).toBe(1)
    const savedUnregistered = loaded.log.find((row) => row['kind'] === 'utilities.fixtureOffline')
    expect(savedUnregistered?.['traceId']).toBe(0)
  })

  it('uses typed agent and generic entity ids without cross-registry collisions', () => {
    const worker = loop()
    const inmateId = worker.world.inmates.allocateId()
    const inmate = generateInmate({
      data: worker.game.data,
      rng: new Rng(0xb10c_6201).stream('report-entity'),
      category: 'medium',
    })
    worker.world.inmates.add(
      createInmateShell({
        id: inmateId,
        data: worker.game.data,
        inmate,
        tx: 1,
        ty: 1,
      }),
    )
    const staffId = worker.world.staff.allocateId()
    expect(staffId).toBe(inmateId)
    worker.world.staff.add({
      id: staffId,
      kind: 'staff',
      x: 2,
      y: 2,
      tx: 2,
      ty: 2,
      staff: {
        defId: 'officer',
        name: 'Officer One',
        officeRoomId: 0,
        assignedAreaId: 0,
        pinnedTile: -1,
        duty: { kind: 'idle' },
        wanderCooldown: 0,
        needs: new Float32Array(worker.game.data.needs.size),
        breakPending: false,
        breakCooldownMinutes: 0,
      },
    })
    worker.events.emit({
      tick: 20,
      kind: 'combat.died',
      subjectId: staffId,
      causeIds: [],
      data: { agentKind: 'staff', agentId: staffId, cause: 'fixture' },
    })
    worker.events.emit({
      tick: 21,
      kind: 'objects.unsupplied',
      causeIds: [],
      data: { entityId: inmateId, name: 'Pump One' },
    })

    const rows = worker.reports().log
    expect(rows.map((row) => row.entityKey)).toEqual(['object:1', 'staff:1'])
    expect(rows.map((row) => row.entityName)).toEqual(['Pump One · #1', 'Officer One · #1'])
  })

  it('reports lifetime and rolling release statistics separately', () => {
    const worker = loop()
    worker.world.release.lifetimeReleased = 5
    worker.world.release.lifetimeReoffended = 2
    worker.world.release.released.push({
      inmateId: 1,
      name: 'Release One',
      reason: 'parole',
      releasedTick: 0,
      reoffendChance: 0.4,
      rollsAtTick: 1,
      reoffended: true,
      reoffendedTick: 1,
    })

    const metrics = new Map(
      worker.reports().statistics.metrics.map((metric) => [metric.id, metric]),
    )
    expect(metrics.get('released')?.value).toBe('5')
    expect(metrics.get('reoffended')?.value).toBe('2')
    expect(metrics.get('recidivism')?.value).toBe('100%')
  })

  it('caps the persistent log at 2,000 newest rows and writes it into saves', async () => {
    const worker = loop()
    for (let index = 0; index < MAX_SAVED_LOG_ENTRIES + 3; index += 1) {
      worker.events.emit({
        tick: index,
        kind: 'report.sampled',
        causeIds: [],
        data: { index },
      })
    }

    const reports = worker.reports()
    expect(reports.log).toHaveLength(MAX_SAVED_LOG_ENTRIES)
    expect(reports.log[0]?.tick).toBe(MAX_SAVED_LOG_ENTRIES + 2)
    expect(reports.log.at(-1)?.tick).toBe(3)

    const { bytes } = await worker.exportSave('2031-07-28T12:00:00.000Z')
    const loaded = await loadFromBytes(bytes)
    expect(loaded.log).toHaveLength(MAX_SAVED_LOG_ENTRIES)
    expect(loaded.log[0]?.tick).toBe(3)
    expect(loaded.log.at(-1)?.tick).toBe(MAX_SAVED_LOG_ENTRIES + 2)
  })

  it('does not let an old pinned trace displace the newest chronological window', () => {
    const log = new CausalEventLog({ capacity: 2 })
    const old = log.record({ tick: 1, kind: 'old', causeIds: [], data: {} })
    log.pin(old.id)
    log.record({ tick: 2, kind: 'middle', causeIds: [], data: {} })
    log.record({ tick: 3, kind: 'newest', causeIds: [], data: {} })

    expect(newestCausalEvents(log.retainedEvents(), 2).map((event) => event.kind)).toEqual([
      'middle',
      'newest',
    ])
  })
})
