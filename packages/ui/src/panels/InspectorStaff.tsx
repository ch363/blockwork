/**
 * Staff inspector body (PRD 6.2).
 */

import type { JSX } from 'preact'

import { NeedRow } from '../controls/NeedRow'
import type { StaffInspectorModel } from './inspectorTypes'

export interface InspectorStaffProps {
  readonly model: StaffInspectorModel
  readonly onNeedSelect?: (needId: string) => void
}

export function InspectorStaff({ model, onNeedSelect }: InspectorStaffProps): JSX.Element {
  return (
    <div class="bw-insp-body">
      <div class="bw-block">
        <h4>Role</h4>
        <div class="bw-kv">
          <span class="k">Title</span>
          <span class="v">{model.roleName}</span>
        </div>
        <div class="bw-kv">
          <span class="k">Wage</span>
          <span class="v bw-num">${model.wagePerHour}/hr</span>
        </div>
        <div class="bw-kv">
          <span class="k">Morale contribution</span>
          <span class="v bw-num">{model.moraleContribution}</span>
        </div>
      </div>

      <div class="bw-block">
        <h4>Needs</h4>
        {model.needs.length === 0 ? (
          <p style="font-size:var(--f-sm);color:var(--text-faint)">No needs tracked yet.</p>
        ) : (
          <div class="bw-needs">
            {model.needs.map((need) => (
              <NeedRow key={need.id} need={need} onSelect={onNeedSelect} />
            ))}
          </div>
        )}
      </div>

      <div class="bw-block">
        <h4>Assignment</h4>
        <div class="bw-kv">
          <span class="k">Current task</span>
          <span class="v">{model.currentTask}</span>
        </div>
        <div class="bw-kv">
          <span class="k">Post</span>
          <span
            class="v"
            style={model.postAssignment === 'Unassigned' ? 'color:var(--text-faint)' : undefined}
          >
            {model.postAssignment}
          </span>
        </div>
      </div>

      <div class="bw-block">
        <h4>Equipment</h4>
        {model.equipment.length === 0 ? (
          <p style="font-size:var(--f-sm);color:var(--text-faint)">None issued.</p>
        ) : (
          <div class="bw-pills">
            {model.equipment.map((item) => (
              <span key={item} class="bw-pill">
                {item}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
