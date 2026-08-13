/**
 * Capacitor 6 configuration for iPadOS (T8.21).
 *
 * The app targets iPad as the primary device (PRD 2.2) with landscape as the
 * primary orientation. Portrait is supported with the rail layout (PRD 6.1).
 *
 * Additional iOS configuration in `ios/App/App/Info.plist` handles:
 * - UIDesignRequiresCompatibility: YES (iPadOS 26 window control overlap fix)
 * - Orientation lock: iPad supports all, iPhone landscape only
 * - Safe area insets handled via CSS env() variables in index.html
 */

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.blockwork.app',
  appName: 'Blockwork',
  webDir: 'dist',

  ios: {
    scheme: 'App',
    contentInset: 'automatic',
    backgroundColor: '#14171c',
    allowsLinkPreview: false,
    preferredContentMode: 'mobile',
  },

  server: {
    iosScheme: 'https',
    androidScheme: 'https',
  },

  plugins: {
    App: {
      handleApplicationNotifications: true,
    },
  },
}

export default config
