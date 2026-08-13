/**
 * The Guided Contract checklist and its coach marks (T6.4, PRD 3.8).
 *
 * Two pieces that deliberately look nothing alike:
 *
 *   - A small, permanent **checklist** in the corner. It is the contract's own
 *     to-do list, so it is useful long after the tutorial stops being a
 *     tutorial, and it never covers the world.
 *   - A **coach mark**: a bubble pointing at the control the player needs,
 *     shown only when the host says they are stuck. It has a dismiss and the
 *     checklist has a skip, because PRD 3.8 says fully skippable and means it.
 *
 * The bubble is positioned from an anchor rect the host measures, not from a
 * hardcoded coordinate — the shell reflows for portrait and for 130% dynamic
 * type, and a bubble that did not follow would end up pointing at nothing.
 *
 * Presentational only.
 */

import type { JSX } from 'preact'

import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type OnboardingMode = 'guided' | 'veteran' | 'off'

export interface OnboardingObjectiveModel {
  readonly index: number
  readonly label: string
  readonly done: boolean
  readonly current: boolean
}

/** Screen-space rect of the control a mark points at. */
export interface CoachAnchorRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CoachMarkModel {
  readonly objectiveIndex: number
  readonly title: string
  readonly body: string
  /** Null when the anchor is off screen or not mounted; the bubble centres. */
  readonly anchorRect: CoachAnchorRect | null
}

export interface OnboardingModel {
  readonly mode: OnboardingMode
  readonly contractName: string
  readonly objectives: readonly OnboardingObjectiveModel[]
  readonly marks: readonly CoachMarkModel[]
  /** Viewport, so a bubble can be kept on screen. */
  readonly viewport: { readonly width: number; readonly height: number }
}

export interface OnboardingProps {
  /** Null hides the guide entirely — a skipped tutorial leaves nothing behind. */
  readonly model: OnboardingModel | null
  readonly onSkip: () => void
  readonly onDismissMark: (objectiveIndex: number) => void
  readonly onMode?: (mode: OnboardingMode) => void
}

/** Bubble geometry. Exported so the placement rule can be tested directly. */
export const COACH_BUBBLE_WIDTH = 280
export const COACH_BUBBLE_MARGIN = 12

export interface BubblePlacement {
  readonly left: number
  readonly top: number
  /** Which side of the anchor the tail comes out of. */
  readonly side: 'above' | 'below' | 'centre'
}

/**
 * Where to put a bubble so it points at its anchor and stays on screen.
 *
 * Prefers above the anchor — the tool dock and the top bar are the two things
 * marks point at, and a bubble below a dock item would sit off the bottom of
 * the screen. Falls back to below when there is no room above, and centres when
 * there is no anchor at all.
 */
export function placeBubble(
  anchor: CoachAnchorRect | null,
  viewport: { readonly width: number; readonly height: number },
  bubbleHeight = 120,
): BubblePlacement {
  if (anchor === null) {
    return {
      left: Math.max(0, (viewport.width - COACH_BUBBLE_WIDTH) / 2),
      top: Math.max(0, (viewport.height - bubbleHeight) / 2),
      side: 'centre',
    }
  }

  const centred = anchor.x + anchor.width / 2 - COACH_BUBBLE_WIDTH / 2
  const left = Math.min(
    Math.max(COACH_BUBBLE_MARGIN, centred),
    Math.max(COACH_BUBBLE_MARGIN, viewport.width - COACH_BUBBLE_WIDTH - COACH_BUBBLE_MARGIN),
  )

  const above = anchor.y - bubbleHeight - COACH_BUBBLE_MARGIN
  if (above >= COACH_BUBBLE_MARGIN) return { left, top: above, side: 'above' }

  return { left, top: anchor.y + anchor.height + COACH_BUBBLE_MARGIN, side: 'below' }
}

export function Onboarding({
  model,
  onSkip,
  onDismissMark,
  onMode,
}: OnboardingProps): JSX.Element | null {
  if (model === null || model.mode === 'off') return null

  const remaining = model.objectives.filter((objective) => !objective.done).length

  return (
    <>
      <aside class="bw-onboarding" aria-label="Guided contract">
        <header>
          <div class="ttl">
            <b>{model.contractName}</b>
            <span>
              {remaining === 0
                ? 'All objectives met'
                : `${String(remaining)} of ${String(model.objectives.length)} to go`}
            </span>
          </div>
          <IconButton ariaLabel="Skip the guide" onClick={onSkip}>
            <Icon name="close" size={14} />
          </IconButton>
        </header>

        <ol class="bw-onboarding-list">
          {model.objectives.map((objective) => (
            <li
              key={objective.index}
              data-done={objective.done ? 'true' : 'false'}
              data-current={objective.current ? 'true' : 'false'}
            >
              <span class="tick" aria-hidden="true">
                {objective.done ? '✓' : '○'}
              </span>
              <span class="lbl">{objective.label}</span>
            </li>
          ))}
        </ol>

        {onMode !== undefined && model.mode === 'guided' && (
          <Button variant="ghost" onClick={() => onMode('veteran')}>
            Show me everything
          </Button>
        )}
      </aside>

      {model.marks.map((mark) => {
        const placement = placeBubble(mark.anchorRect, model.viewport)
        return (
          <div
            key={mark.objectiveIndex}
            class="bw-coach"
            role="dialog"
            aria-label={mark.title}
            data-side={placement.side}
            style={{
              left: `${String(placement.left)}px`,
              top: `${String(placement.top)}px`,
              width: `${String(COACH_BUBBLE_WIDTH)}px`,
            }}
          >
            <h4>{mark.title}</h4>
            <p>{mark.body}</p>
            <Button variant="ghost" onClick={() => onDismissMark(mark.objectiveIndex)}>
              Got it
            </Button>
          </div>
        )
      })}
    </>
  )
}
