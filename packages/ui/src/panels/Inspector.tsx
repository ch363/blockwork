/**
 * The inspector (PRD 6.1, 6.2).
 *
 * Slides over the world from the right, never resizes it, dismissible. Variants
 * for inmate, staff, room, object and bare tile share one frame so the chrome
 * (avatar, close, foot actions) stays consistent while the body swaps.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'
import { InspectorInmate } from './InspectorInmate'
import { InspectorObject } from './InspectorObject'
import { InspectorRoom } from './InspectorRoom'
import { InspectorStaff } from './InspectorStaff'
import type { InspectorModel } from './inspectorTypes'

export type {
  CategoryToken,
  InmateInspectorModel,
  InspectorGrade,
  InspectorMisconduct,
  InspectorModel,
  InspectorNeed,
  InspectorReputation,
  ObjectInspectorModel,
  RoomInspectorModel,
  StaffInspectorModel,
  TileInspectorModel,
} from './inspectorTypes'
export { categoryToken } from './inspectorTypes'
export { requirementLabel } from './InspectorRoom'

export interface InspectorProps {
  /** Null closes the panel. It stays mounted, so the close animation runs. */
  readonly model: InspectorModel | null
  readonly onClose: () => void
  /** Pans the camera to the subject. */
  readonly onFocus?: () => void
  /** Removes the subject from the world. Absent where there is nothing to remove. */
  readonly onDemolish?: () => void
  readonly onSearch?: () => void
  readonly onReclassify?: () => void
  readonly onPunish?: () => void
  readonly onProtective?: () => void
  readonly onNeedSelect?: (needId: string) => void
  readonly onFire?: () => void
  readonly onAcceptPayDemand?: () => void
  readonly onRefusePayDemand?: () => void
  readonly onAssignLabour?: () => void
  readonly onUnassignLabour?: () => void
}

function heading(model: InspectorModel): {
  title: string
  sub: string
  icon: 'staff' | 'rooms' | 'objects' | 'select'
  catbar: string | null
  pills: JSX.Element | null
} {
  switch (model.kind) {
    case 'inmate':
      return {
        title: model.name,
        sub: model.subtitle,
        icon: 'staff',
        catbar: `var(--${model.categoryToken})`,
        pills: (
          <div class="bw-pills" style="margin-top:7px">
            <span class="bw-pill cat" style={{ background: `var(--${model.categoryToken})` }}>
              {model.categoryName}
            </span>
            {model.criticalNeedCount > 0 && (
              <span class="bw-pill bad">
                {model.criticalNeedCount} critical need{model.criticalNeedCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        ),
      }
    case 'staff':
      return {
        title: model.name,
        sub: model.roleName,
        icon: 'staff',
        catbar: 'var(--info)',
        pills: null,
      }
    case 'room':
      return {
        title: model.name,
        sub: model.typeName,
        icon: 'rooms',
        catbar: model.functional ? 'var(--ok)' : 'var(--danger)',
        pills: null,
      }
    case 'object':
      return {
        title: model.name,
        sub: model.roomName ?? 'Unassigned',
        icon: 'objects',
        catbar: null,
        pills: null,
      }
    case 'tile':
      return {
        title: 'Tile',
        sub: `${String(model.x)}, ${String(model.y)}`,
        icon: 'select',
        catbar: null,
        pills: null,
      }
  }
}

function TileBody({
  model,
}: {
  readonly model: Extract<InspectorModel, { kind: 'tile' }>
}): JSX.Element {
  return (
    <div class="bw-insp-body">
      <div class="bw-block">
        <h4>Tile</h4>
        <div class="bw-kv">
          <span class="k">Position</span>
          <span class="v bw-num">
            {model.x}, {model.y}
          </span>
        </div>
        <div class="bw-kv">
          <span class="k">Floor</span>
          <span class="v">{model.floorName}</span>
        </div>
        <div class="bw-kv">
          <span class="k">Wall</span>
          <span class="v" style={model.wallName === null ? 'color:var(--text-faint)' : undefined}>
            {model.wallName ?? 'None'}
          </span>
        </div>
        <div class="bw-kv">
          <span class="k">Room</span>
          <span class="v" style={model.roomName === null ? 'color:var(--text-faint)' : undefined}>
            {model.roomName ?? 'Unassigned'}
          </span>
        </div>
        <div class="bw-kv">
          <span class="k">Passable</span>
          <span class="v">{model.walkable ? 'Yes' : 'No'}</span>
        </div>
      </div>
    </div>
  )
}

export function Inspector({
  model,
  onClose,
  onFocus,
  onDemolish,
  onSearch,
  onReclassify,
  onPunish,
  onProtective,
  onNeedSelect,
  onFire,
  onAcceptPayDemand,
  onRefusePayDemand,
  onAssignLabour,
  onUnassignLabour,
}: InspectorProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })
  const head = model === null ? null : heading(model)
  const showGenericFoot = model !== null && (model.kind === 'room' || model.kind === 'object')

  return (
    <aside
      ref={trapRef}
      class="bw-inspector"
      data-open={open}
      data-kind={model?.kind ?? 'none'}
      role="dialog"
      aria-label="Inspector"
      aria-modal={open ? 'true' : undefined}
      aria-hidden={!open}
    >
      {model !== null && head !== null && (
        <>
          <div class="bw-insp-head">
            <div class="bw-avatar" aria-hidden="true">
              <Icon name={head.icon} size={26} />
              {head.catbar !== null && <span class="catbar" style={{ background: head.catbar }} />}
            </div>
            <div class="who">
              <h3>{head.title}</h3>
              <div class="sub">{head.sub}</div>
              {head.pills}
            </div>
            <IconButton ariaLabel="Close inspector" onClick={onClose} title="Close">
              <Icon name="close" size={16} />
            </IconButton>
          </div>

          {model.kind === 'inmate' && (
            <InspectorInmate
              model={model}
              {...(onSearch === undefined ? {} : { onSearch })}
              {...(onReclassify === undefined ? {} : { onReclassify })}
              {...(onPunish === undefined ? {} : { onPunish })}
              {...(onProtective === undefined ? {} : { onProtective })}
              {...(onNeedSelect === undefined ? {} : { onNeedSelect })}
              {...(onAssignLabour === undefined ? {} : { onAssignLabour })}
              {...(onUnassignLabour === undefined ? {} : { onUnassignLabour })}
            />
          )}
          {model.kind === 'staff' && (
            <InspectorStaff
              model={model}
              {...(onNeedSelect === undefined ? {} : { onNeedSelect })}
              {...(onFire === undefined ? {} : { onFire })}
              {...(onAcceptPayDemand === undefined ? {} : { onAcceptPayDemand })}
              {...(onRefusePayDemand === undefined ? {} : { onRefusePayDemand })}
            />
          )}
          {model.kind === 'room' && <InspectorRoom model={model} />}
          {model.kind === 'object' && <InspectorObject model={model} />}
          {model.kind === 'tile' && <TileBody model={model} />}

          {showGenericFoot && (
            <div class="bw-insp-foot">
              <Button
                onClick={onFocus}
                disabled={onFocus === undefined}
                ariaLabel="Centre on selection"
              >
                <Icon name="search" size={16} />
                Centre
              </Button>
              <Button
                variant="danger"
                onClick={onDemolish}
                disabled={onDemolish === undefined}
                ariaLabel="Demolish selection"
              >
                <Icon name="demolish" size={16} />
                Demolish
              </Button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}
