/**
 * Smoke tests for Capacitor iPadOS configuration (T8.21).
 *
 * These verify that the Capacitor configuration is valid and the build
 * dependencies are correctly installed. Full device testing requires Xcode
 * and a physical iPad.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')

describe('Capacitor iOS configuration', () => {
  it('capacitor.config.ts exists', () => {
    const configPath = resolve(appRoot, 'capacitor.config.ts')
    expect(existsSync(configPath)).toBe(true)
  })

  it('capacitor.config.ts has correct app ID', async () => {
    const config = await import('../capacitor.config')
    expect(config.default.appId).toBe('dev.blockwork.app')
  })

  it('capacitor.config.ts targets dist as webDir', async () => {
    const config = await import('../capacitor.config')
    expect(config.default.webDir).toBe('dist')
  })

  it('capacitor.config.ts has iOS configuration', async () => {
    const config = await import('../capacitor.config')
    expect(config.default.ios).toBeDefined()
    expect(config.default.ios?.backgroundColor).toBe('#14171c')
    expect(config.default.ios?.contentInset).toBe('automatic')
  })

  it('package.json has Capacitor dependencies', () => {
    const pkgPath = resolve(appRoot, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    expect(pkg.dependencies['@capacitor/core']).toBeDefined()
    expect(pkg.dependencies['@capacitor/ios']).toBeDefined()
    expect(pkg.dependencies['@capacitor/app']).toBeDefined()
    expect(pkg.devDependencies['@capacitor/cli']).toBeDefined()
  })

  it('package.json has cap:sync script', () => {
    const pkgPath = resolve(appRoot, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    expect(pkg.scripts['cap:sync']).toBe('cap sync ios')
    expect(pkg.scripts['cap:open']).toBe('cap open ios')
  })
})

describe('index.html safe area handling', () => {
  it('includes safe area CSS custom properties', () => {
    const indexPath = resolve(appRoot, 'index.html')
    const html = readFileSync(indexPath, 'utf-8')

    expect(html).toContain('--safe-area-inset-top')
    expect(html).toContain('--safe-area-inset-right')
    expect(html).toContain('--safe-area-inset-bottom')
    expect(html).toContain('--safe-area-inset-left')
  })

  it('includes viewport-fit=cover for notch handling', () => {
    const indexPath = resolve(appRoot, 'index.html')
    const html = readFileSync(indexPath, 'utf-8')

    expect(html).toContain('viewport-fit=cover')
  })

  it('includes apple-mobile-web-app-capable', () => {
    const indexPath = resolve(appRoot, 'index.html')
    const html = readFileSync(indexPath, 'utf-8')

    expect(html).toContain('apple-mobile-web-app-capable')
  })
})

describe('Capacitor lifecycle handlers', () => {
  it('capacitor.ts exports lifecycle functions', async () => {
    const { installCapacitorLifecycle, removeCapacitorLifecycle, isCapacitorNative } =
      await import('../src/game/capacitor')

    expect(typeof installCapacitorLifecycle).toBe('function')
    expect(typeof removeCapacitorLifecycle).toBe('function')
    expect(typeof isCapacitorNative).toBe('function')
  })

  it('isCapacitorNative returns false in test environment', async () => {
    const { isCapacitorNative } = await import('../src/game/capacitor')
    expect(isCapacitorNative()).toBe(false)
  })
})
