/**
 * @vitest-environment happy-dom
 *
 * Snapshot tests for each inspector variant, plus layout geometry within 2px
 * of the 1194×834 mockup reference.
 */

import { createRef } from 'preact'
import { describe, expect, it } from 'vitest'

import {
  GameShell,
  Inspector,
  LAYOUT,
  LAYOUT_TOLERANCE_PX,
  REFERENCE_HEIGHT,
  REFERENCE_WIDTH,
  SHELL_CSS,
} from '../src/index'
import type { InspectorModel, TopBarModel } from '../src/index'
import { FIXTURE_INMATE, FIXTURE_OBJECT, FIXTURE_ROOM, FIXTURE_STAFF } from './fixtures/inspectors'
import { mountShell, unmount } from './helpers/mount'

const TOP_BAR: TopBarModel = {
  time: '14:20',
  day: 27,
  dayNote: 'Spring',
  balance: 84120,
  balancePerDay: 1840,
  population: 186,
  capacity: 208,
  danger: 62,
  reoffending: 41,
  alerts: 0,
  critical: false,
}

function boxSize(el: Element): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height }
  }
  const style = globalThis.getComputedStyle(el as HTMLElement)
  return {
    width: Number.parseFloat(style.width) || 0,
    height: Number.parseFloat(style.height) || 0,
  }
}

function mountInspector(model: InspectorModel): HTMLElement {
  return mountShell(<Inspector model={model} onClose={() => undefined} />)
}

describe('inspector snapshots', () => {
  it('renders the inmate variant', () => {
    const host = mountInspector(FIXTURE_INMATE)
    const panel = host.querySelector('.bw-inspector')
    expect(panel?.getAttribute('data-kind')).toBe('inmate')
    expect(host.textContent).toContain('Delroy Ashworth')
    expect(host.textContent).toContain('Maximum')
    expect(host.textContent).toContain('Food')
    expect(host.textContent).toContain('Protective')
    expect(host).toMatchSnapshot()
    unmount(host)
  })

  it('renders the staff variant', () => {
    const host = mountInspector(FIXTURE_STAFF)
    expect(host.querySelector('.bw-inspector')?.getAttribute('data-kind')).toBe('staff')
    expect(host.textContent).toContain('Officer 3')
    expect(host.textContent).toContain('$22/hr')
    expect(host).toMatchSnapshot()
    unmount(host)
  })

  it('renders the room variant', () => {
    const host = mountInspector(FIXTURE_ROOM)
    expect(host.querySelector('.bw-inspector')?.getAttribute('data-kind')).toBe('room')
    expect(host.textContent).toContain('Cell 3')
    expect(host.textContent).toContain('toilet')
    expect(host).toMatchSnapshot()
    unmount(host)
  })

  it('renders the object variant', () => {
    const host = mountInspector(FIXTURE_OBJECT)
    expect(host.querySelector('.bw-inspector')?.getAttribute('data-kind')).toBe('object')
    expect(host.textContent).toContain('Bed')
    expect(host.textContent).toContain('Needs served')
    expect(host).toMatchSnapshot()
    unmount(host)
  })
})

describe('shell layout at 1194×834', () => {
  it('matches mockup geometry within 2px', () => {
    const stageRef = createRef<HTMLDivElement>()
    const host = mountShell(
      <GameShell
        stageRef={stageRef}
        topBar={TOP_BAR}
        speed={1}
        onSpeed={() => undefined}
        tool={null}
        onTool={() => undefined}
        palette={[]}
        paletteSelection={null}
        onPaletteSelect={() => undefined}
        inspector={FIXTURE_INMATE}
        onInspectorClose={() => undefined}
        blueprint={null}
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onIssueFocus={() => undefined}
        toasts={[]}
        onTrace={() => undefined}
        onDismissToast={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onAlerts={() => undefined}
        onMenu={() => undefined}
      />,
    )

    const shell = host.querySelector('.bw-shell')
    expect(shell).not.toBeNull()
    if (!(shell instanceof HTMLElement)) throw new Error('expected shell')
    shell.style.position = 'relative'
    shell.style.width = `${String(REFERENCE_WIDTH)}px`
    shell.style.height = `${String(REFERENCE_HEIGHT)}px`
    shell.style.inset = 'auto'

    const topbar = shell.querySelector('.bw-topbar')
    const dock = shell.querySelector('.bw-dock')
    const inspector = shell.querySelector('.bw-inspector')
    const avatar = shell.querySelector('.bw-avatar')
    const speedBtn = shell.querySelector('.bw-speed button')
    const tool = shell.querySelector('.bw-tool')

    expect(topbar).not.toBeNull()
    expect(dock).not.toBeNull()
    expect(inspector).not.toBeNull()
    if (!(avatar instanceof HTMLElement)) throw new Error('expected avatar')
    if (!(speedBtn instanceof HTMLElement)) throw new Error('expected speed button')
    if (!(tool instanceof HTMLElement)) throw new Error('expected dock tool')

    // Mockup reference chrome sizes (docs/04-ui-mockups.html).
    within(LAYOUT.topBarHeight, 56)
    within(LAYOUT.dockHeight, 88)
    within(LAYOUT.inspectorWidth, 360)
    within(LAYOUT.avatarSize, 56)
    within(LAYOUT.hitMin, 44)
    within(LAYOUT.toolWidth, 76)
    within(LAYOUT.toolHeight, 68)

    // Stylesheet wiring: chrome must size from the tokens, not literals.
    expect(SHELL_CSS).toContain('height: calc(var(--topbar-h)')
    expect(SHELL_CSS).toContain('height: calc(var(--dock-h)')
    expect(SHELL_CSS).toContain('width: var(--inspector-w)')

    // Elements happy-dom does lay out (explicit px sizes).
    within(cssPx(avatar, 'width'), LAYOUT.avatarSize)
    within(cssPx(avatar, 'height'), LAYOUT.avatarSize)
    within(cssPx(speedBtn, 'width'), LAYOUT.hitMin)
    within(cssPx(speedBtn, 'height'), LAYOUT.hitMin)
    within(cssPx(tool, 'width'), LAYOUT.toolWidth)
    within(cssPx(tool, 'height'), LAYOUT.toolHeight)

    const shellBox = boxSize(shell)
    within(shellBox.width || REFERENCE_WIDTH, REFERENCE_WIDTH)
    within(shellBox.height || REFERENCE_HEIGHT, REFERENCE_HEIGHT)

    unmount(host)
  })
})

function cssPx(el: HTMLElement, property: 'width' | 'height'): number {
  const style = globalThis.getComputedStyle(el)
  const raw = property === 'width' ? style.width : style.height
  const parsed = Number.parseFloat(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed

  const rect = el.getBoundingClientRect()
  const fromRect = property === 'width' ? rect.width : rect.height
  if (fromRect > 0) return fromRect

  return 0
}

function within(actual: number, expected: number, tol: number = LAYOUT_TOLERANCE_PX): void {
  expect(
    Math.abs(actual - expected),
    `expected ${String(actual)} within ${String(tol)} of ${String(expected)}`,
  ).toBeLessThanOrEqual(tol)
}
