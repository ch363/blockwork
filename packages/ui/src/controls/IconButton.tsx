/**
 * Square icon control. Sized to `--hit-min` so VoiceOver and a finger agree.
 */

import type { ComponentChildren, JSX } from 'preact'

export interface IconButtonProps {
  readonly children: ComponentChildren
  /** Required: icon-only controls have no visible text for VoiceOver. */
  readonly ariaLabel: string
  readonly onClick?: (() => void) | undefined
  readonly disabled?: boolean
  readonly pressed?: boolean
  readonly title?: string
}

export function IconButton({
  children,
  ariaLabel,
  onClick,
  disabled = false,
  pressed,
  title,
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class="bw-iconbtn"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed, 'data-on': pressed })}
    >
      {children}
    </button>
  )
}
