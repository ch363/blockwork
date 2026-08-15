/**
 * Intake panel (T8.9, PRD 6.2).
 *
 * Requested counts per security category, continuous intake toggle, capacity
 * readout, next bus ETA. Presentational only: the host resolves simulation
 * state and turns controls into `intake.setRequested`, `intake.setContinuous`,
 * and `intake.clearRequested` commands.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export interface IntakeCategoryModel {
  readonly id: string
  readonly name: string
  readonly requested: number
  readonly locked: boolean
  readonly lockReason: string | null
}

export interface IntakeCapacityModel {
  readonly population: number
  readonly capacity: number
  readonly housing: {
    readonly cells: number
    readonly dormitories: number
    readonly holdingPens: number
  }
}

export interface IntakeModel {
  readonly continuous: boolean
  readonly categories: readonly IntakeCategoryModel[]
  readonly capacityModel: IntakeCapacityModel
  readonly nextBusLabel: string
  readonly nextBusTick: number | null
}

export interface IntakeProps {
  readonly model: IntakeModel | null
  readonly onClose: () => void
  readonly onSetContinuous?: (continuous: boolean) => void
  readonly onSetRequested?: (categoryId: string, count: number) => void
  readonly onClearRequested?: () => void
}

export function Intake({
  model,
  onClose,
  onSetContinuous,
  onSetRequested,
  onClearRequested,
}: IntakeProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  const totalRequested =
    model === null ? 0 : model.categories.reduce((sum, cat) => sum + cat.requested, 0)

  const freeCapacity =
    model === null ? 0 : model.capacityModel.capacity - model.capacityModel.population

  return (
    <div
      ref={trapRef}
      class="bw-intake-panel"
      data-anchor="panel:intake"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Intake"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-intake-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Intake</h2>
              <div class="sub">Manage prisoner arrivals</div>
            </div>
          </div>

          <div class="bw-intake-body">
            <section class="bw-intake-card">
              <header>
                <h3>Arrival mode</h3>
              </header>
              <div class="bw-intake-card-body">
                <div class="bw-intake-toggle">
                  <button
                    type="button"
                    class="bw-intake-mode-btn"
                    data-on={model.continuous ? 'true' : 'false'}
                    aria-pressed={model.continuous}
                    onClick={() => onSetContinuous?.(true)}
                  >
                    Continuous
                  </button>
                  <button
                    type="button"
                    class="bw-intake-mode-btn"
                    data-on={!model.continuous ? 'true' : 'false'}
                    aria-pressed={!model.continuous}
                    onClick={() => onSetContinuous?.(false)}
                  >
                    Requested only
                  </button>
                </div>
                <p class="bw-intake-hint">
                  {model.continuous
                    ? 'Buses arrive automatically when housing is available.'
                    : 'Buses bring only the categories you request below.'}
                </p>
              </div>
            </section>

            <section class="bw-intake-card">
              <header>
                <h3>Next bus</h3>
                <span class="bw-intake-pill">{model.nextBusLabel}</span>
              </header>
              <div class="bw-intake-card-body">
                <div class="bw-intake-kv">
                  <span class="k">Total requested</span>
                  <span class="v">{totalRequested}</span>
                </div>
                <div class="bw-intake-kv">
                  <span class="k">Free housing</span>
                  <span class="v">{freeCapacity}</span>
                </div>
              </div>
            </section>

            <section class="bw-intake-card">
              <header>
                <h3>Request by category</h3>
                {totalRequested > 0 && (
                  <Button variant="ghost" onClick={() => onClearRequested?.()}>
                    Clear all
                  </Button>
                )}
              </header>
              <div class="bw-intake-card-body">
                <ul class="bw-intake-categories">
                  {model.categories.map((category) => (
                    <li key={category.id} data-locked={category.locked ? 'true' : 'false'}>
                      <span class="bw-intake-cat-name">{category.name}</span>
                      {category.locked ? (
                        <span class="bw-intake-cat-lock">{category.lockReason}</span>
                      ) : (
                        <div class="bw-intake-cat-controls">
                          <button
                            type="button"
                            class="bw-intake-cat-btn"
                            disabled={category.requested <= 0}
                            aria-label={`Decrease ${category.name}`}
                            onClick={() =>
                              onSetRequested?.(category.id, Math.max(0, category.requested - 1))
                            }
                          >
                            −
                          </button>
                          <span class="bw-intake-cat-count">{category.requested}</span>
                          <button
                            type="button"
                            class="bw-intake-cat-btn"
                            aria-label={`Increase ${category.name}`}
                            onClick={() => onSetRequested?.(category.id, category.requested + 1)}
                          >
                            +
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section class="bw-intake-card">
              <header>
                <h3>Housing capacity</h3>
              </header>
              <div class="bw-intake-card-body">
                <div class="bw-intake-kv">
                  <span class="k">Population</span>
                  <span class="v">
                    {model.capacityModel.population}/{model.capacityModel.capacity}
                  </span>
                </div>
                <div class="bw-intake-capacity-bar">
                  <i
                    style={{
                      width: `${String(Math.min(100, Math.round((model.capacityModel.population / Math.max(1, model.capacityModel.capacity)) * 100)))}%`,
                    }}
                    data-full={
                      model.capacityModel.population >= model.capacityModel.capacity
                        ? 'true'
                        : 'false'
                    }
                  />
                </div>
                <div class="bw-intake-kv">
                  <span class="k">Cells</span>
                  <span class="v">{model.capacityModel.housing.cells}</span>
                </div>
                <div class="bw-intake-kv">
                  <span class="k">Dormitory beds</span>
                  <span class="v">{model.capacityModel.housing.dormitories}</span>
                </div>
                <div class="bw-intake-kv">
                  <span class="k">Holding pens</span>
                  <span class="v">{model.capacityModel.housing.holdingPens}</span>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
