/**
 * The new-prison flow (T6.5).
 *
 * One screen, not a wizard. Every choice here changes what kind of game the
 * player is about to have, and a wizard would hide half of them behind a Next
 * button — which is how someone ends up three hours into a prison discovering
 * that escapes were never going to end it.
 *
 * The failure conditions are individually armable rather than a single
 * difficulty dial, because they are not a difficulty dial: turning off
 * insolvency and turning off deaths are different games, and PRD 7.9's
 * "no failure" mode is simply all of them off, which the panel says out loud
 * when it happens.
 *
 * Presentational only: the host owns the config and applies the change.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'

export type MapSizePreset = 'small' | 'medium' | 'large' | 'huge'

export interface MapSizeOption {
  readonly id: MapSizePreset
  readonly label: string
  /** Tiles per axis, so the player can see what they are choosing. */
  readonly tiles: number
}

export interface ToggleModel {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly enabled: boolean
}

export interface NewPrisonModel {
  readonly sizePreset: MapSizePreset
  readonly sizes: readonly MapSizeOption[]
  readonly startingFunds: number
  readonly continuousIntake: boolean
  readonly randomEvents: boolean
  /** First-order material grace until a Store is designated (T8.4). */
  readonly firstOrderGrace: boolean
  readonly seedInput: string
  readonly failures: readonly ToggleModel[]
  readonly mutators: readonly ToggleModel[]
}

export interface NewPrisonProps {
  /** Null closes the screen. */
  readonly model: NewPrisonModel | null
  readonly onSize: (preset: MapSizePreset) => void
  readonly onStartingFunds: (amount: number) => void
  readonly onContinuousIntake: (enabled: boolean) => void
  readonly onRandomEvents: (enabled: boolean) => void
  readonly onFirstOrderGrace: (enabled: boolean) => void
  readonly onSeed: (input: string) => void
  readonly onFailure: (id: string, enabled: boolean) => void
  readonly onMutator: (id: string, enabled: boolean) => void
  readonly onStart: () => void
  readonly onCancel: () => void
}

/** Starting-funds stops. A slider over money invites nonsense values. */
export const FUNDS_STOPS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 250_000]

export function formatFunds(amount: number): string {
  return `$${amount.toLocaleString('en-GB')}`
}

/** PRD 7.9: every failure condition off is the no-failure mode. */
export function isNoFailureMode(failures: readonly ToggleModel[]): boolean {
  return failures.length > 0 && failures.every((entry) => !entry.enabled)
}

export function NewPrison({
  model,
  onSize,
  onStartingFunds,
  onContinuousIntake,
  onRandomEvents,
  onFirstOrderGrace,
  onSeed,
  onFailure,
  onMutator,
  onStart,
  onCancel,
}: NewPrisonProps): JSX.Element | null {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onCancel })

  if (model === null) return null

  return (
    <div ref={trapRef} class="bw-newprison" role="dialog" aria-label="New prison" aria-modal="true">
      <header>
        <h2>New prison</h2>
        <p>Everything here is fixed for the life of this prison. Choose carefully.</p>
      </header>

      <div class="bw-newprison-body">
        <section>
          <h3>Map size</h3>
          <div class="bw-newprison-sizes" role="radiogroup" aria-label="Map size">
            {model.sizes.map((size) => (
              <button
                key={size.id}
                type="button"
                role="radio"
                aria-checked={model.sizePreset === size.id}
                data-on={model.sizePreset === size.id ? 'true' : 'false'}
                onClick={() => onSize(size.id)}
              >
                <b>{size.label}</b>
                <span>
                  {size.tiles}×{size.tiles}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Starting funds</h3>
          <div class="bw-newprison-funds" role="radiogroup" aria-label="Starting funds">
            {FUNDS_STOPS.map((amount) => (
              <button
                key={amount}
                type="button"
                role="radio"
                aria-checked={model.startingFunds === amount}
                data-on={model.startingFunds === amount ? 'true' : 'false'}
                onClick={() => onStartingFunds(amount)}
              >
                {formatFunds(amount)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Seed</h3>
          <label class="bw-newprison-seed">
            <input
              type="text"
              value={model.seedInput}
              placeholder="Leave blank for a random prison"
              aria-label="Seed"
              onInput={(event) => onSeed((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <p class="bw-newprison-hint">
            A word or a number. The same seed and the same choices give the same prison.
          </p>
        </section>

        <section>
          <h3>Intake</h3>
          <label class="bw-newprison-toggle">
            <input
              type="checkbox"
              checked={model.continuousIntake}
              aria-label="Continuous intake"
              onChange={(event) =>
                onContinuousIntake((event.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>
              <b>Continuous intake</b>
              <em>Buses keep arriving to fill free beds. Off means you request every inmate.</em>
            </span>
          </label>
          <label class="bw-newprison-toggle">
            <input
              type="checkbox"
              checked={model.randomEvents}
              aria-label="Random events"
              onChange={(event) =>
                onRandomEvents((event.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>
              <b>Random events</b>
              <em>Inspections, weather and the occasional bad day.</em>
            </span>
          </label>
          <label class="bw-newprison-toggle">
            <input
              type="checkbox"
              checked={model.firstOrderGrace}
              aria-label="Starter deliveries"
              onChange={(event) =>
                onFirstOrderGrace((event.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>
              <b>Starter deliveries</b>
              <em>
                Early builds receive materials until you designate a Store. The south edge always
                opens with a delivery dock, approach road and a maintenance crew.
              </em>
            </span>
          </label>
        </section>

        <section>
          <h3>Failure conditions</h3>
          {isNoFailureMode(model.failures) && (
            <p class="bw-newprison-note">
              Every condition is off. This prison cannot be lost — build freely.
            </p>
          )}
          {model.failures.map((entry) => (
            <label key={entry.id} class="bw-newprison-toggle">
              <input
                type="checkbox"
                checked={entry.enabled}
                aria-label={entry.label}
                onChange={(event) =>
                  onFailure(entry.id, (event.currentTarget as HTMLInputElement).checked)
                }
              />
              <span>
                <b>{entry.label}</b>
                <em>{entry.description}</em>
              </span>
            </label>
          ))}
        </section>

        <section>
          <h3>Mutators</h3>
          {model.mutators.map((entry) => (
            <label key={entry.id} class="bw-newprison-toggle">
              <input
                type="checkbox"
                checked={entry.enabled}
                aria-label={entry.label}
                onChange={(event) =>
                  onMutator(entry.id, (event.currentTarget as HTMLInputElement).checked)
                }
              />
              <span>
                <b>{entry.label}</b>
                <em>{entry.description}</em>
              </span>
            </label>
          ))}
        </section>
      </div>

      <footer>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onStart}>
          Open the prison
        </Button>
      </footer>
    </div>
  )
}
