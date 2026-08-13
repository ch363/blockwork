/**
 * Focus trap for modal dialogs (T8.17).
 *
 * Wraps dialog content to implement the ARIA modal pattern:
 *   - Tab / Shift+Tab cycles within the dialog
 *   - Focus moves to the first focusable element on open
 *   - Focus returns to the trigger element on close
 *
 * This makes VoiceOver and keyboard navigation work correctly in every panel
 * that uses `role="dialog"`. Without it, Tab escapes into the canvas and the
 * browser chrome, and closing leaves focus nowhere in particular.
 */

import type { ComponentChildren, JSX, RefObject } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

/** Selectors for naturally focusable elements inside a dialog. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Returns all focusable elements in container, in DOM order. */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetWidth > 0 && element.offsetHeight > 0,
  )
}

export interface FocusTrapProps {
  readonly children: ComponentChildren
  /** Whether the trap is currently active. Inactive traps render children but don't trap focus. */
  readonly active: boolean
  /** Optional ref to the container element; if provided, uses that instead of creating a wrapper. */
  readonly containerRef?: RefObject<HTMLElement>
  /** Called when Escape is pressed. */
  readonly onEscape?: () => void
  /** Element to focus when the trap activates. Defaults to the first focusable child. */
  readonly initialFocus?: RefObject<HTMLElement>
  /** Element to return focus to when the trap deactivates. Defaults to the previously focused element. */
  readonly returnFocus?: RefObject<HTMLElement>
  /** Whether to wrap in a div or render children directly (when using containerRef). */
  readonly wrapless?: boolean
}

/**
 * Traps focus within a modal dialog and restores it on close.
 *
 * Usage with a wrapper div (default):
 * ```tsx
 * <FocusTrap active={open}>
 *   <div role="dialog" aria-label="Settings">...</div>
 * </FocusTrap>
 * ```
 *
 * Usage without a wrapper (wrapless):
 * ```tsx
 * <div ref={containerRef} role="dialog" aria-label="Settings">
 *   <FocusTrap active={open} containerRef={containerRef} wrapless>
 *     ... children ...
 *   </FocusTrap>
 * </div>
 * ```
 */
export function FocusTrap({
  children,
  active,
  containerRef,
  onEscape,
  initialFocus,
  returnFocus,
  wrapless = false,
}: FocusTrapProps): JSX.Element {
  const internalRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  const getContainer = (): HTMLElement | null => containerRef?.current ?? internalRef.current

  useEffect(() => {
    if (!active) return

    const container = getContainer()
    if (container === null) return

    // Store the currently focused element to restore later
    const previouslyFocused = document.activeElement as HTMLElement | null
    previouslyFocusedRef.current = previouslyFocused

    // Move focus into the dialog
    const focusTarget = initialFocus?.current ?? getFocusableElements(container)[0]
    if (focusTarget != null) {
      // Delay to allow render to complete
      requestAnimationFrame(() => {
        focusTarget.focus()
      })
    }

    return () => {
      // Restore focus when deactivating
      const restoreTo = returnFocus?.current ?? previouslyFocusedRef.current
      if (restoreTo != null && typeof restoreTo.focus === 'function') {
        requestAnimationFrame(() => {
          restoreTo.focus()
        })
      }
    }
  }, [active, initialFocus, returnFocus])

  useEffect(() => {
    if (!active) return

    const container = getContainer()
    if (container === null) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      // Handle Escape
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onEscape?.()
        return
      }

      // Only trap Tab
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(container)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      // Allow Tab to cycle within the dialog
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, onEscape])

  if (wrapless) {
    return <>{children}</>
  }

  return (
    <div ref={internalRef} class="bw-focus-trap">
      {children}
    </div>
  )
}

/**
 * Hook for using focus trap functionality without a wrapper component.
 * Returns a ref to attach to the container and a handler for keydown.
 *
 * Example:
 * ```tsx
 * const trapRef = useFocusTrap({ active: open, onEscape: onClose })
 * return <div ref={trapRef} role="dialog">...</div>
 * ```
 */
export function useFocusTrap(options: {
  readonly active: boolean
  readonly onEscape?: () => void
  readonly initialFocus?: RefObject<HTMLElement>
  readonly returnFocus?: RefObject<HTMLElement>
}): RefObject<HTMLDivElement> {
  const { active, onEscape, initialFocus, returnFocus } = options
  const containerRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    const container = containerRef.current
    if (container === null) return

    // Store the currently focused element to restore later
    const previouslyFocused = document.activeElement as HTMLElement | null
    previouslyFocusedRef.current = previouslyFocused

    // Move focus into the dialog
    const focusTarget = initialFocus?.current ?? getFocusableElements(container)[0]
    if (focusTarget != null) {
      requestAnimationFrame(() => {
        focusTarget.focus()
      })
    }

    return () => {
      // Restore focus when deactivating
      const restoreTo = returnFocus?.current ?? previouslyFocusedRef.current
      if (restoreTo != null && typeof restoreTo.focus === 'function') {
        requestAnimationFrame(() => {
          restoreTo.focus()
        })
      }
    }
  }, [active, initialFocus, returnFocus])

  useEffect(() => {
    if (!active) return

    const container = containerRef.current
    if (container === null) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onEscape?.()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(container)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, onEscape])

  return containerRef
}
