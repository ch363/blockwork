/**
 * Hit-target audit helpers (T2.9 acceptance).
 *
 * Walks a rendered DOM and reports every interactive control whose layout box
 * is under `--hit-min` (44pt). Used by the audit test; also available to a
 * future debug overlay.
 */

import { MIN_HIT_TARGET_PT } from '../constants'

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="tab"]'

export interface HitTargetViolation {
  readonly label: string
  readonly width: number
  readonly height: number
  readonly tag: string
}

function controlLabel(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria !== null && aria.trim() !== '') return aria.trim()
  const title = el.getAttribute('title')
  if (title !== null && title.trim() !== '') return title.trim()
  const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (text !== '') return text.slice(0, 80)
  return el.tagName.toLowerCase()
}

/**
 * Every interactive descendant whose bounding box is under the minimum on
 * either axis. Hidden / `aria-hidden` / `disabled` controls are skipped: they
 * are not targets a finger can hit.
 */
export function auditHitTargets(
  root: ParentNode,
  minPt: number = MIN_HIT_TARGET_PT,
): readonly HitTargetViolation[] {
  const violations: HitTargetViolation[] = []
  const nodes = root.querySelectorAll(INTERACTIVE)

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue
    if (node.getAttribute('aria-hidden') === 'true') continue
    if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') continue

    const style = globalThis.getComputedStyle?.(node)
    if (style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) continue
    if (style !== undefined && style.pointerEvents === 'none') continue

    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue

    if (rect.width + 0.5 < minPt || rect.height + 0.5 < minPt) {
      violations.push({
        label: controlLabel(node),
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        tag: node.tagName.toLowerCase(),
      })
    }
  }

  return violations
}

/**
 * Every interactive control must expose a meaningful accessible name for
 * VoiceOver (PRD 7.9 / T2.9 acceptance).
 */
export function auditAccessibleNames(root: ParentNode): readonly string[] {
  const missing: string[] = []
  const nodes = root.querySelectorAll(INTERACTIVE)

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue
    if (node.getAttribute('aria-hidden') === 'true') continue

    const name = accessibleName(node)
    if (name === '') {
      missing.push(`${node.tagName.toLowerCase()}${node.className ? `.${node.className}` : ''}`)
    }
  }

  return missing
}

function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')
  if (aria !== null && aria.trim() !== '') return aria.trim()

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter((part) => part !== '')
    if (parts.length > 0) return parts.join(' ')
  }

  const title = el.getAttribute('title')
  if (title !== null && title.trim() !== '') return title.trim()

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.labels !== null && el.labels.length > 0) {
      const fromLabel = [...el.labels]
        .map((label) => label.textContent?.trim() ?? '')
        .filter((part) => part !== '')
        .join(' ')
      if (fromLabel !== '') return fromLabel
    }
  }

  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}
