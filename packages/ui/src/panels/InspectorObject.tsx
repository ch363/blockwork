/**
 * Object inspector body (PRD 6.2).
 */

import type { JSX } from 'preact'

import type { ObjectInspectorModel } from './inspectorTypes'

export interface InspectorObjectProps {
  readonly model: ObjectInspectorModel
}

export function InspectorObject({ model }: InspectorObjectProps): JSX.Element {
  const utility = (label: string, needs: boolean, has: boolean): JSX.Element => (
    <div class="bw-kv">
      <span class="k">{label}</span>
      <span class="v" style={needs && !has ? 'color:var(--danger)' : undefined}>
        {!needs ? 'Not required' : has ? 'Connected' : 'Missing'}
      </span>
    </div>
  )

  const conditionPct =
    model.conditionMax <= 0 ? 0 : Math.round((model.condition / model.conditionMax) * 100)

  return (
    <div class="bw-insp-body">
      <div class="bw-block">
        <h4>Utilities</h4>
        {utility('Power', model.needsPower, model.hasPower)}
        {utility('Water', model.needsWater, model.hasWater)}
      </div>

      <div class="bw-block">
        <h4>Condition</h4>
        <div class="bw-kv">
          <span class="k">Hit points</span>
          <span class="v bw-num">
            {model.condition} / {model.conditionMax}
          </span>
        </div>
        <div
          class="bw-bar"
          role="meter"
          aria-valuenow={conditionPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Object condition"
          style="margin-top:var(--s2)"
        >
          <i
            style={{
              width: `${String(conditionPct)}%`,
              background: conditionPct < 30 ? 'var(--danger)' : 'var(--ok)',
            }}
          />
        </div>
      </div>

      <div class="bw-block">
        <h4>Details</h4>
        <div class="bw-kv">
          <span class="k">Cost</span>
          <span class="v bw-num">${model.cost}</span>
        </div>
        <div class="bw-kv">
          <span class="k">Room</span>
          <span class="v" style={model.roomName === null ? 'color:var(--text-faint)' : undefined}>
            {model.roomName ?? 'None'}
          </span>
        </div>
        <div class="bw-kv">
          <span class="k">Contraband risk</span>
          <span class="v bw-num" style={model.contrabandRisk > 0 ? 'color:var(--warn)' : undefined}>
            {model.contrabandRisk}%
          </span>
        </div>
      </div>

      <div class="bw-block">
        <h4>Needs served</h4>
        {model.needsServed.length === 0 ? (
          <p style="font-size:var(--f-sm);color:var(--text-faint)">None.</p>
        ) : (
          <div class="bw-pills">
            {model.needsServed.map((need) => (
              <span key={need} class="bw-pill info">
                {need}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
