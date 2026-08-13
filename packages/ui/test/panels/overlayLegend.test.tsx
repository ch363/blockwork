/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { OverlayLegend } from '../../src/panels/OverlayLegend'
import { mountShell, unmount } from '../helpers/mount'

describe('OverlayLegend', () => {
  it('renders a compact, text-labelled pattern legend', () => {
    const host = mountShell(
      <OverlayLegend
        trayOpen
        model={{
          title: 'Needs heatmap · Food',
          paletteLabel: 'Deuteranopia',
          entries: [
            { label: 'Satisfied', colour: '#173f5f', pattern: 'dots' },
            { label: 'Medium', colour: '#3caea3', pattern: 'diagonal' },
            { label: 'Critical', colour: '#ed8b35', pattern: 'solid' },
          ],
        }}
      />,
    )

    const legend = host.querySelector('.bw-overlay-legend')
    expect(legend?.getAttribute('data-open')).toBe('true')
    expect(legend?.getAttribute('data-tray-open')).toBe('true')
    expect(legend?.getAttribute('data-many')).toBe('false')
    expect(legend?.getAttribute('aria-label')).toBe('Needs heatmap · Food overlay legend')
    expect(host.textContent).toContain('Deuteranopia')
    expect(host.textContent).toContain('Critical')
    expect(
      [...host.querySelectorAll('.bw-overlay-swatch')].map((entry) =>
        entry.getAttribute('data-pattern'),
      ),
    ).toEqual(['dots', 'diagonal', 'solid'])
    unmount(host)
  })

  it('is absent from accessibility when inactive', () => {
    const host = mountShell(<OverlayLegend model={null} />)
    const legend = host.querySelector('.bw-overlay-legend')
    expect(legend?.getAttribute('data-open')).toBe('false')
    expect(legend?.getAttribute('aria-hidden')).toBe('true')
    unmount(host)
  })
})
