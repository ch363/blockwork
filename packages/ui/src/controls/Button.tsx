/**
 * Primary text button. Always at least `--hit-min` tall (PRD 2.3).
 */

import type { ComponentChildren, JSX } from 'preact'

export interface ButtonProps {
  readonly children: ComponentChildren
  readonly onClick?: (() => void) | undefined
  readonly disabled?: boolean
  readonly variant?: 'default' | 'primary' | 'danger' | 'ghost'
  readonly wide?: boolean
  readonly ariaLabel?: string
  readonly title?: string
  readonly type?: 'button' | 'submit' | 'reset'
}

export function Button({
  children,
  onClick,
  disabled = false,
  variant = 'default',
  wide = false,
  ariaLabel,
  title,
  type = 'button',
}: ButtonProps): JSX.Element {
  const classes = ['bw-btn']
  if (variant !== 'default') classes.push(variant)
  if (wide) classes.push('wide')

  return (
    <button
      type={type}
      class={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
    >
      {children}
    </button>
  )
}
