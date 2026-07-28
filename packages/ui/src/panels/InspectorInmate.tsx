/**
 * Inmate inspector body (PRD 6.2, mockup screen 1).
 */

import type { JSX } from 'preact'
import { useState } from 'preact/hooks'

import { Button } from '../controls/Button'
import { NeedRow } from '../controls/NeedRow'
import type { InmateInspectorModel } from './inspectorTypes'

export interface InspectorInmateProps {
  readonly model: InmateInspectorModel
  readonly onSearch?: () => void
  readonly onReclassify?: () => void
  readonly onPunish?: () => void
  readonly onProtective?: () => void
  readonly onNeedSelect?: (needId: string) => void
}

type InmateTab = 'status' | 'record' | 'grades'

export function InspectorInmate({
  model,
  onSearch,
  onReclassify,
  onPunish,
  onProtective,
  onNeedSelect,
}: InspectorInmateProps): JSX.Element {
  const [tab, setTab] = useState<InmateTab>('status')
  const shownNeeds = model.needs.slice(0, 8)
  const hiddenNeeds = model.needs.length - shownNeeds.length

  return (
    <>
      <div class="bw-tabs" role="tablist" aria-label="Inmate sections">
        <TabButton id="status" label="Status" active={tab === 'status'} onSelect={setTab} />
        <TabButton id="record" label="Record" active={tab === 'record'} onSelect={setTab} />
        <TabButton id="grades" label="Grades" active={tab === 'grades'} onSelect={setTab} />
      </div>

      <div class="bw-insp-body">
        {tab === 'status' && (
          <>
            <div class="bw-block">
              <h4>Sentence</h4>
              <div class="bw-sentence">
                <div class="row">
                  <span>Served {model.sentenceServedLabel}</span>
                  <b>of {model.sentenceTotalLabel}</b>
                </div>
                <div
                  class="bw-track"
                  role="meter"
                  aria-valuenow={model.sentenceProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Sentence progress"
                >
                  <i style={{ width: `${String(model.sentenceProgress)}%` }} />
                </div>
                {model.paroleLabel !== null && (
                  <div class="row" style="margin:6px 0 0">
                    <span>Parole eligible</span>
                    <b>{model.paroleLabel}</b>
                  </div>
                )}
              </div>
            </div>

            <div class="bw-block">
              <h4>Needs · tap to trace</h4>
              <div class="bw-needs">
                {shownNeeds.map((need) => (
                  <NeedRow key={need.id} need={need} onSelect={onNeedSelect} />
                ))}
              </div>
              {hiddenNeeds > 0 && (
                <p style="text-align:center;padding-top:6px;font-size:var(--f-cap);color:var(--text-faint)">
                  +{hiddenNeeds} more needs
                </p>
              )}
            </div>

            <div class="bw-block">
              <h4>Known reputation</h4>
              <div class="bw-pills">
                {model.reputations.map((rep) => (
                  <span key={rep.id} class={`bw-pill ${rep.tone}`}>
                    {rep.name}
                  </span>
                ))}
                {model.traits.map((trait) => (
                  <span key={trait} class="bw-pill">
                    {trait}
                  </span>
                ))}
                {model.unknownReputationCount > 0 && (
                  <span class="bw-pill ghost">{model.unknownReputationCount} unknown</span>
                )}
              </div>
            </div>

            <div class="bw-block">
              <h4>Current</h4>
              <div class="bw-kv">
                <span class="k">Activity</span>
                <span class="v">{model.activity}</span>
              </div>
              <div class="bw-kv">
                <span class="k">Cell</span>
                <span class="v">{model.cellLabel}</span>
              </div>
              <div class="bw-kv">
                <span class="k">Entitlement</span>
                <span class="v bw-num">{model.entitlement}</span>
              </div>
              <div class="bw-kv">
                <span class="k">Suppression</span>
                <span
                  class="v bw-num"
                  style={model.suppression >= 40 ? 'color:var(--warn)' : undefined}
                >
                  {model.suppression}
                </span>
              </div>
              <div class="bw-kv">
                <span class="k">Work</span>
                <span
                  class="v"
                  style={model.workLabel === 'Unassigned' ? 'color:var(--text-faint)' : undefined}
                >
                  {model.workLabel}
                </span>
              </div>
              <div class="bw-kv">
                <span class="k">Programme</span>
                <span
                  class="v"
                  style={model.programmeLabel === 'None' ? 'color:var(--text-faint)' : undefined}
                >
                  {model.programmeLabel}
                </span>
              </div>
            </div>
          </>
        )}

        {tab === 'record' && (
          <div class="bw-block">
            <h4>Recent misconduct</h4>
            {model.misconduct.length === 0 ? (
              <p style="font-size:var(--f-sm);color:var(--text-faint)">No misconduct recorded.</p>
            ) : (
              model.misconduct.map((entry) => (
                <div key={`${entry.day}-${entry.label}`} class="bw-kv">
                  <span class="k">
                    Day {entry.day} · {entry.label}
                  </span>
                  <span class="v">{entry.outcome}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'grades' && (
          <div class="bw-block">
            <h4>Grades</h4>
            <div class="bw-grades">
              {model.grades.map((grade) => (
                <div key={grade.id} class="bw-grade">
                  <div class="g-k">{grade.label}</div>
                  <div class="g-v">{grade.letter}</div>
                  <div class="g-b">
                    <i
                      style={{
                        width: `${String(grade.score)}%`,
                        background:
                          grade.tone === 'ok'
                            ? 'var(--ok)'
                            : grade.tone === 'warn'
                              ? 'var(--warn)'
                              : 'var(--danger)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div class="bw-kv" style="margin-top:var(--s2)">
              <span class="k">Estimated re-offending</span>
              <span class="v bw-num" style="color:var(--danger)">
                {model.reoffendPercent}%
              </span>
            </div>
          </div>
        )}
      </div>

      <div class="bw-insp-foot bw-insp-foot-4">
        <Button onClick={onSearch} disabled={onSearch === undefined} ariaLabel="Search inmate">
          Search
        </Button>
        <Button
          onClick={onReclassify}
          disabled={onReclassify === undefined}
          ariaLabel="Reclassify inmate"
        >
          Reclassify
        </Button>
        <Button
          variant="danger"
          onClick={onPunish}
          disabled={onPunish === undefined}
          ariaLabel="Isolate inmate for 24 hours"
        >
          Isolation 24h
        </Button>
        <Button
          variant="primary"
          onClick={onProtective}
          disabled={onProtective === undefined}
          ariaLabel="Place inmate in protective custody"
        >
          Protective
        </Button>
      </div>
    </>
  )
}

function TabButton({
  id,
  label,
  active,
  onSelect,
}: {
  readonly id: InmateTab
  readonly label: string
  readonly active: boolean
  readonly onSelect: (id: InmateTab) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-on={active}
      onClick={() => {
        onSelect(id)
      }}
    >
      {label}
    </button>
  )
}
