/**
 * Shared DOM mount for UI shell tests.
 *
 * Injects the shell stylesheet and mounts into a fixed 1194×834 frame so
 * layout measurements match the mockup reference size.
 */

import { render } from 'preact'
import type { ComponentChild, VNode } from 'preact'

import { REFERENCE_HEIGHT, REFERENCE_WIDTH, injectShellCss } from '../../src/index'

export function mountShell(vnode: VNode | ComponentChild): HTMLElement {
  injectShellCss(document)

  const host = document.createElement('div')
  host.style.width = `${String(REFERENCE_WIDTH)}px`
  host.style.height = `${String(REFERENCE_HEIGHT)}px`
  host.style.position = 'relative'
  document.body.appendChild(host)

  render(vnode, host)
  return host
}

export function unmount(host: HTMLElement): void {
  render(null, host)
  host.remove()
}
