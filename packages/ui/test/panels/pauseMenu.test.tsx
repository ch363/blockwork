/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { PauseMenu } from '../../src/panels/PauseMenu'
import type { PauseMenuModel } from '../../src/panels/PauseMenu'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): PauseMenuModel {
  return {
    saves: [
      {
        key: 'auto:0',
        name: 'Autosave 1',
        savedAt: '2026-08-13T14:30:00.000Z',
        playedTicks: 7200,
        mapSize: 220,
      },
      {
        key: 'auto:1',
        name: 'Autosave 2',
        savedAt: '2026-08-13T12:15:00.000Z',
        playedTicks: 3600,
        mapSize: 220,
      },
      {
        key: 'manual:my-prison',
        name: 'My Prison',
        savedAt: '2026-08-12T10:00:00.000Z',
        playedTicks: 14400,
        mapSize: 320,
      },
    ],
    canSave: true,
    canExport: true,
  }
}

describe('PauseMenu panel', () => {
  it('renders menu buttons and save slots when open', () => {
    const calls: string[] = []
    const host = mountShell(
      <PauseMenu
        model={sampleModel()}
        onClose={() => calls.push('close')}
        onResume={() => calls.push('resume')}
        onSave={() => calls.push('save')}
        onLoad={(key) => calls.push(`load:${key}`)}
        onExport={() => calls.push('export')}
        onImport={() => calls.push('import')}
        onSettings={() => calls.push('settings')}
        onNewPrison={() => calls.push('newPrison')}
        onQuit={() => calls.push('quit')}
      />,
    )

    try {
      const root = host.querySelector('.bw-pause-menu')
      expect(root?.getAttribute('data-open')).toBe('true')

      expect(host.textContent).toContain('Resume')
      expect(host.textContent).toContain('Save')
      expect(host.textContent).toContain('Export')
      expect(host.textContent).toContain('Import')
      expect(host.textContent).toContain('Settings')
      expect(host.textContent).toContain('New Prison')
      expect(host.textContent).toContain('Quit')

      expect(host.textContent).toContain('Autosave 1')
      expect(host.textContent).toContain('Autosave 2')
      expect(host.textContent).toContain('My Prison')

      const resumeButton = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Resume'),
      )
      expect(resumeButton).toBeDefined()
      resumeButton?.click()
      expect(calls).toContain('resume')
    } finally {
      unmount(host)
    }
  })

  it('closes when the model is null', () => {
    const host = mountShell(
      <PauseMenu
        model={null}
        onClose={() => undefined}
        onResume={() => undefined}
      />,
    )

    try {
      const root = host.querySelector('.bw-pause-menu')
      expect(root?.getAttribute('data-open')).toBe('false')
    } finally {
      unmount(host)
    }
  })

  it('fires onLoad when a save slot is clicked', () => {
    const loaded: string[] = []
    const host = mountShell(
      <PauseMenu
        model={sampleModel()}
        onClose={() => undefined}
        onResume={() => undefined}
        onLoad={(key) => loaded.push(key)}
      />,
    )

    try {
      const savesList = host.querySelector('.bw-pause-saves ul')
      expect(savesList).not.toBeNull()

      const saveRow = [...(savesList?.querySelectorAll('li') ?? [])].find((el) =>
        (el.textContent ?? '').includes('Autosave 1'),
      )
      expect(saveRow).toBeDefined()

      const button = saveRow?.querySelector('button')
      button?.click()
      expect(loaded).toEqual(['auto:0'])
    } finally {
      unmount(host)
    }
  })

  it('fires onSave when the save button is clicked', () => {
    const saved: string[] = []
    const host = mountShell(
      <PauseMenu
        model={sampleModel()}
        onClose={() => undefined}
        onResume={() => undefined}
        onSave={() => saved.push('saved')}
      />,
    )

    try {
      const saveButton = [...host.querySelectorAll('button')].find(
        (b) => (b.textContent ?? '').trim() === 'Save',
      )
      expect(saveButton).toBeDefined()
      saveButton?.click()
      expect(saved).toEqual(['saved'])
    } finally {
      unmount(host)
    }
  })
})
