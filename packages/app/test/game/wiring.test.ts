/**
 * T8.10 acceptance test: every registered command handler has a route from the
 * interface.
 *
 * This test enumerates command types that players invoke from UI controls and
 * asserts each one appears somewhere in the app package's session.ts. A missing
 * command type means a player-facing control is inert (greyed out or does
 * nothing).
 *
 * The list is manually maintained rather than derived from sim exports because:
 * - Not all command handlers are UI-invoked (some are simulation-internal)
 * - Blueprint commands go via commit, not as direct strings
 * - New UI commands need explicit wiring, so the test failing is the reminder
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Commands that require explicit wiring in session.ts because they are
 * directly invoked from UI controls. This is the authoritative list for T8.10.
 */
const UI_INVOKED_COMMANDS: string[] = [
  // Intake panel (T8.9)
  'intake.setContinuous',
  'intake.setRequested',
  'intake.clearRequested',

  // Inmate inspector actions (T8.10)
  'inmate.reclassify',
  'inmate.punish',
  'inmate.protectiveCustody',

  // Routine panel (T8.9)
  'routine.setCategory',

  // Staff dock
  'staff.hire',
  'staff.fire',

  // Morale (T8.10)
  'morale.acceptPayDemand',
  'morale.refusePayDemand',

  // Contracts panel (T8.9)
  'contracts.accept',
  'contracts.cancel',
  'contracts.takeLoan',
  'contracts.repayLoan',

  // Sector / Posts (T4.1)
  'sector.create',
  'sector.configure',
  'sector.paintRegion',
  'post.create',
  'post.createPatrol',

  // Standing Orders (T4.3)
  'search.individual',
  'standingOrders.setPunishment',
  'standingOrders.setSearchTrigger',
  'standingOrders.setMeals',
  'standingOrders.setStrictness',

  // Emergency (T4.6)
  'emergency.sectorLockdown',
  'emergency.liftSectorLockdown',
  'emergency.fullLockdown',
  'emergency.liftFullLockdown',
  'emergency.callRiotSquad',
  'emergency.dismissRiotSquad',
  'emergency.authoriseFreeFire',
  'emergency.revokeFreeFire',
  'emergency.callNationalGuard',

  // Directorate (T5.1)
  'directorate.start',

  // Programs (T5.3)
  'program.enrol',
  'program.withdraw',
  'program.pin',
  'program.unpin',

  // Intelligence (T5.6)
  'intelligence.recruit',

  // Labour (T5.7)
  'labour.assign',
  'labour.unassign',
]

function readFilesRecursively(dir: string, ext: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...readFilesRecursively(fullPath, ext))
    } else if (entry.endsWith(ext)) {
      files.push(readFileSync(fullPath, 'utf8'))
    }
  }
  return files
}

describe('command handler wiring', () => {
  it('every UI-invoked command has a caller in packages/app', () => {
    const appDir = join(__dirname, '../..')
    const srcDir = join(appDir, 'src')

    const sourceContents = readFilesRecursively(srcDir, '.ts').join('\n')

    const missing: string[] = []
    for (const commandType of UI_INVOKED_COMMANDS) {
      // Check if the command type string appears anywhere in the source.
      // This catches both `type: 'command.type'` and string references.
      if (!sourceContents.includes(`'${commandType}'`)) {
        missing.push(commandType)
      }
    }

    expect(
      missing,
      `The following UI commands have handlers but no caller in packages/app:\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('New Prison, Quit, object appearances and world pins have callers (T8.8 / T8.22 / T8.23)', () => {
    const srcDir = join(__dirname, '../../src')
    const source = readFilesRecursively(srcDir, '.ts').join('\n')
    expect(source).toContain('startNewPrison')
    expect(source).toContain('quitToNewPrison')
    expect(source).toContain('unlockAudio')
    expect(source).toContain('appearanceFor')
    expect(source).toContain('setPin')
    expect(source).toContain('setSelections')
  })
})
