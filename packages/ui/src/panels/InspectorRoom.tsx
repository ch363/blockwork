/**
 * Room inspector body (PRD 6.2).
 */

import type { RoomRequirement } from '@blockwork/sim'
import type { JSX } from 'preact'

import { Icon } from '../icons'
import type { RoomInspectorModel } from './inspectorTypes'

/**
 * A requirement as a sentence fragment.
 *
 * The subject is an id — `toilet`, `enclosed`, `minTiles` — because ids are
 * what the simulation deals in and the display name belongs to the data layer.
 */
export function requirementLabel(requirement: RoomRequirement): string {
  switch (requirement.kind) {
    case 'minTiles':
      return `At least ${String(requirement.required)} tiles`
    case 'minWidth':
      return `At least ${String(requirement.required)} tiles wide`
    case 'minHeight':
      return `At least ${String(requirement.required)} tiles deep`
    case 'property':
      return `Must be ${requirement.subject.replace(/-/g, ' ')}`
    case 'object':
      return `${requirement.required} × ${requirement.subject.replace(/_/g, ' ')}`
  }
}

function requirementValue(requirement: RoomRequirement): string {
  if (requirement.kind === 'property') return requirement.met ? 'Yes' : 'No'
  return `${String(requirement.actual)} of ${String(requirement.required)}`
}

export interface InspectorRoomProps {
  readonly model: RoomInspectorModel
}

export function InspectorRoom({ model }: InspectorRoomProps): JSX.Element {
  const failed = model.requirements.filter((requirement) => !requirement.met).length

  return (
    <div class="bw-insp-body">
      <div class="bw-block">
        <h4>Status</h4>
        <div class="bw-pills">
          <span class={model.functional ? 'bw-pill ok' : 'bw-pill bad'}>
            <Icon name={model.functional ? 'check' : 'warning'} size={13} />
            {model.functional ? 'Functional' : `${String(failed)} unmet`}
          </span>
          {model.properties.map((property) => (
            <span key={property} class="bw-pill">
              {property}
            </span>
          ))}
        </div>
      </div>

      <div class="bw-block">
        <h4>Requirements</h4>
        {model.requirements.length === 0 ? (
          <p style="font-size:var(--f-sm);color:var(--text-faint)">No requirements.</p>
        ) : (
          <ul>
            {model.requirements.map((requirement) => (
              <li
                key={`${requirement.kind}|${requirement.subject}`}
                class="bw-req"
                data-met={requirement.met}
              >
                <span class="mk">
                  <Icon name={requirement.met ? 'check' : 'close'} size={16} />
                </span>
                <span class="n">{requirementLabel(requirement)}</span>
                <span class="bw-num" style="color:var(--text-dim);font-size:var(--f-cap)">
                  {requirementValue(requirement)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="bw-block">
        <h4>Size</h4>
        <div class="bw-kv">
          <span class="k">Footprint</span>
          <span class="v bw-num">
            {model.width} &times; {model.height}
          </span>
        </div>
        <div class="bw-kv">
          <span class="k">Tiles</span>
          <span class="v bw-num">{model.tiles}</span>
        </div>
        <div class="bw-kv">
          <span class="k">Occupants</span>
          <span class="v bw-num">{model.occupants}</span>
        </div>
      </div>

      {model.grade !== null && (
        <div class="bw-block">
          <h4>
            Grade {model.grade} / {model.gradeMax}
          </h4>
          {model.gradeLines.length === 0 ? (
            <p style="font-size:var(--f-sm);color:var(--text-dim)">
              Nothing in this room scores. Furnish it to raise the grade.
            </p>
          ) : (
            model.gradeLines.map((line) => (
              <div key={`${line.label}:${line.detail ?? ''}`} class="bw-kv">
                <span class="k">
                  {line.label}
                  {line.detail === null ? '' : ` · ${line.detail}`}
                </span>
                <span class="v bw-num">{line.points > 0 ? `+${line.points}` : line.points}</span>
              </div>
            ))
          )}
        </div>
      )}

      {model.throughputLabel !== null && (
        <div class="bw-block">
          <h4>Throughput</h4>
          <p style="font-size:var(--f-sm);color:var(--text)">{model.throughputLabel}</p>
        </div>
      )}
    </div>
  )
}
