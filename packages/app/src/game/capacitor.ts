/**
 * Capacitor lifecycle handlers for iPadOS (T8.21).
 *
 * Handles app state changes (background/foreground) from the native Capacitor
 * shell. These hooks are no-ops in the browser, where the visibilitychange
 * event in main.tsx already handles backgrounding.
 *
 * **Background/foreground autosave.** On iPadOS, backgrounding the app fires
 * both `visibilitychange` and Capacitor's `pause` event. The visibilitychange
 * handler in main.tsx catches the former; this catches the latter for
 * Capacitor-specific behaviour like preparing for potential termination.
 *
 * **Memory warning.** iOS memory warnings are not exposed through the standard
 * Capacitor App plugin. However, the aggressive autosave strategy (on every
 * background, on visibility change, and on timed intervals) means work is
 * rarely more than a few minutes old. For true memory warning handling, a
 * native Swift plugin would be needed to observe UIApplication's
 * didReceiveMemoryWarningNotification.
 */

import { App } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { Capacitor } from '@capacitor/core'

export interface CapacitorLifecycleCallbacks {
  onBackground: () => void | Promise<void>
  onForeground: () => void | Promise<void>
}

interface ListenerHandles {
  pause: PluginListenerHandle | null
  resume: PluginListenerHandle | null
}

const handles: ListenerHandles = {
  pause: null,
  resume: null,
}

let isNativePlatform = false

/**
 * Installs Capacitor lifecycle listeners when running in a native shell.
 *
 * Safe to call unconditionally: does nothing on web where Capacitor APIs are
 * unavailable or return no-op values.
 */
export async function installCapacitorLifecycle(
  callbacks: CapacitorLifecycleCallbacks,
): Promise<void> {
  isNativePlatform = Capacitor.isNativePlatform()

  if (!isNativePlatform) {
    return
  }

  try {
    handles.pause = await App.addListener('pause', () => {
      void callbacks.onBackground()
    })

    handles.resume = await App.addListener('resume', () => {
      void callbacks.onForeground()
    })
  } catch (error) {
    console.warn('Blockwork: failed to install Capacitor lifecycle listeners', error)
  }
}

/**
 * Removes installed listeners on teardown. Called during hot reload or cleanup.
 */
export async function removeCapacitorLifecycle(): Promise<void> {
  if (!isNativePlatform) {
    return
  }

  try {
    await handles.pause?.remove()
    await handles.resume?.remove()
    handles.pause = null
    handles.resume = null
  } catch (error) {
    console.warn('Blockwork: failed to remove Capacitor lifecycle listeners', error)
  }
}

/**
 * Whether the app is running in a native Capacitor shell (iPad/iPhone).
 * Use this to conditionally enable native-only features.
 */
export function isCapacitorNative(): boolean {
  return isNativePlatform
}
