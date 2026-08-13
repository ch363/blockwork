/**
 * Routine editor panel (T8.9, PRD 5.7, PRD 6.2).
 *
 * A 24-hour strip per security category. The player drags to paint blocks;
 * conflict strip below shows when schedules cannot satisfy programmes.
 * Presentational only: the host resolves simulation state and turns edits
 * into `routine.setCategory` commands.
 */

import type { JSX } from 'preact'
import { useState } from 'preact/hooks'

import { useFocusTrap } from '../components/FocusTrap'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type RoutineBlockId =
  | 'lockup'
  | 'sleep'
  | 'meal'
  | 'yard'
  | 'wash'
  | 'free'
  | 'work_free'
  | 'work_lockup'

export interface RoutineCategoryModel {
  readonly id: string
  readonly name: string
  readonly blocks: readonly RoutineBlockId[]
}

export interface RoutineConflictModel {
  readonly message: string
  readonly severity: 'warn' | 'info'
}

export interface RoutineModel {
  readonly categories: readonly RoutineCategoryModel[]
  readonly conflicts: readonly RoutineConflictModel[]
}

export interface RoutineProps {
  readonly model: RoutineModel | null
  readonly onClose: () => void
  readonly onSetCategory?: (categoryId: string, blocks: readonly RoutineBlockId[]) => void
}

const BLOCK_LABELS: Readonly<Record<RoutineBlockId, string>> = {
  lockup: 'Lockup',
  sleep: 'Sleep',
  meal: 'Meal',
  yard: 'Yard',
  wash: 'Wash',
  free: 'Free',
  work_free: 'Work',
  work_lockup: 'Work (locked)',
}

const BLOCK_IDS: readonly RoutineBlockId[] = [
  'lockup',
  'sleep',
  'meal',
  'yard',
  'wash',
  'free',
  'work_free',
  'work_lockup',
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

export function Routine({ model, onClose, onSetCategory }: RoutineProps): JSX.Element {
  const open = model !== null
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [paintBlock, setPaintBlock] = useState<RoutineBlockId | null>(null)
  const [localBlocks, setLocalBlocks] = useState<Map<string, RoutineBlockId[]>>(new Map())
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  const activeCategory =
    model === null
      ? null
      : selectedCategory !== null
        ? (model.categories.find((c) => c.id === selectedCategory) ?? model.categories[0] ?? null)
        : (model.categories[0] ?? null)

  const handleCategoryTab = (categoryId: string): void => {
    setSelectedCategory(categoryId)
    setPaintBlock(null)
  }

  const getBlocks = (category: RoutineCategoryModel): readonly RoutineBlockId[] => {
    return localBlocks.get(category.id) ?? category.blocks
  }

  const handleBlockClick = (category: RoutineCategoryModel, hour: number): void => {
    if (paintBlock === null) return
    const current = [...getBlocks(category)]
    current[hour] = paintBlock
    setLocalBlocks(new Map(localBlocks).set(category.id, current))
    onSetCategory?.(category.id, current)
  }

  const handlePointerDown = (
    event: JSX.TargetedPointerEvent<HTMLButtonElement>,
    category: RoutineCategoryModel,
    hour: number,
  ): void => {
    if (paintBlock === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    handleBlockClick(category, hour)
  }

  const handlePointerEnter = (category: RoutineCategoryModel, hour: number): void => {
    if (paintBlock === null) return
    handleBlockClick(category, hour)
  }

  return (
    <div
      ref={trapRef}
      class="bw-routine-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Routine"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-routine-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Routine</h2>
              <div class="sub">24-hour schedule per security category</div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-routine-tabs" role="tablist" aria-label="Security category">
              {model.categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={activeCategory?.id === category.id}
                  data-on={activeCategory?.id === category.id ? 'true' : 'false'}
                  onClick={() => handleCategoryTab(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-routine-body">
            <div class="bw-routine-palette">
              <span class="bw-routine-palette-label">Paint block:</span>
              {BLOCK_IDS.map((blockId) => (
                <button
                  key={blockId}
                  type="button"
                  class="bw-routine-block-btn"
                  data-block={blockId}
                  data-selected={paintBlock === blockId ? 'true' : 'false'}
                  onClick={() => setPaintBlock(paintBlock === blockId ? null : blockId)}
                  aria-pressed={paintBlock === blockId}
                >
                  {BLOCK_LABELS[blockId]}
                </button>
              ))}
            </div>

            {activeCategory !== null && (
              <div class="bw-routine-strip-container">
                <div class="bw-routine-hours">
                  {HOURS.map((hour) => (
                    <span key={hour} class="bw-routine-hour-label">
                      {hour % 6 === 0 ? formatHour(hour) : ''}
                    </span>
                  ))}
                </div>
                <div class="bw-routine-strip" role="group" aria-label={activeCategory.name}>
                  {HOURS.map((hour) => {
                    const blocks = getBlocks(activeCategory)
                    const blockId = blocks[hour] ?? 'free'
                    return (
                      <button
                        key={hour}
                        type="button"
                        class="bw-routine-cell"
                        data-block={blockId}
                        aria-label={`${formatHour(hour)}: ${BLOCK_LABELS[blockId]}`}
                        onPointerDown={(event) => handlePointerDown(event, activeCategory, hour)}
                        onPointerEnter={() => handlePointerEnter(activeCategory, hour)}
                      >
                        <span class="bw-routine-cell-label">{BLOCK_LABELS[blockId]}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {model.conflicts.length > 0 && (
              <div class="bw-routine-conflicts" role="status">
                <h4>Conflicts</h4>
                <ul>
                  {model.conflicts.map((conflict, index) => (
                    <li key={index} data-severity={conflict.severity}>
                      {conflict.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {activeCategory === null && (
              <div class="bw-routine-empty" role="status">
                No security categories configured.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
