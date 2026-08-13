/**
 * Emergency response panel (T4.6, PRD 3.7).
 *
 * Graduated escalation ladder: five levels with stated costs and side effects.
 * Presentational only — the host resolves sim state into {@link EmergencyModel}
 * and routes gestures as callbacks / commands.
 */

import type { JSX } from 'preact'

import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type EmergencyLevelId =
  'sector_lockdown' | 'full_lockdown' | 'riot_squad' | 'free_fire' | 'national_guard'

export interface EmergencyLevelModel {
  readonly id: EmergencyLevelId
  readonly level: 1 | 2 | 3 | 4 | 5
  readonly label: string
  readonly costLabel: string
  readonly sideEffect: string
  readonly active: boolean
  /** Soft-disable when the action cannot run (e.g. no sector selected). */
  readonly disabled: boolean
  readonly disabledReason: string | null
}

export interface EmergencyModel {
  readonly danger: number
  readonly riotActive: boolean
  readonly riotingCount: number
  /** Minutes of quiet progress toward containment, or null when not counting. */
  readonly containmentQuietMinutes: number | null
  readonly containmentNeededMinutes: number
  /** Failure warning already issued. */
  readonly failureWarning: boolean
  /** Absolute tick of failure, or null. */
  readonly failureAtTick: number | null
  readonly playerFired: boolean
  readonly riotSquadHourlyCost: number
  readonly nationalGuardCost: number
  readonly levels: readonly EmergencyLevelModel[]
  /** Selected sector for level-1, or null. */
  readonly selectedSectorId: number | null
  readonly selectedSectorName: string | null
}

export interface EmergencyProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: EmergencyModel | null
  readonly onClose: () => void
  readonly onSectorLockdown?: () => void
  readonly onLiftSectorLockdown?: () => void
  readonly onFullLockdown?: () => void
  readonly onLiftFullLockdown?: () => void
  readonly onCallRiotSquad?: () => void
  readonly onDismissRiotSquad?: () => void
  readonly onAuthoriseFreeFire?: () => void
  readonly onRevokeFreeFire?: () => void
  readonly onCallNationalGuard?: () => void
}

export function Emergency({
  model,
  onClose,
  onSectorLockdown,
  onLiftSectorLockdown,
  onFullLockdown,
  onLiftFullLockdown,
  onCallRiotSquad,
  onDismissRiotSquad,
  onAuthoriseFreeFire,
  onRevokeFreeFire,
  onCallNationalGuard,
}: EmergencyProps): JSX.Element {
  const open = model !== null
  const handlers = {
    ...(onSectorLockdown === undefined ? {} : { onSectorLockdown }),
    ...(onLiftSectorLockdown === undefined ? {} : { onLiftSectorLockdown }),
    ...(onFullLockdown === undefined ? {} : { onFullLockdown }),
    ...(onLiftFullLockdown === undefined ? {} : { onLiftFullLockdown }),
    ...(onCallRiotSquad === undefined ? {} : { onCallRiotSquad }),
    ...(onDismissRiotSquad === undefined ? {} : { onDismissRiotSquad }),
    ...(onAuthoriseFreeFire === undefined ? {} : { onAuthoriseFreeFire }),
    ...(onRevokeFreeFire === undefined ? {} : { onRevokeFreeFire }),
    ...(onCallNationalGuard === undefined ? {} : { onCallNationalGuard }),
  }

  return (
    <div
      class="bw-emergency-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Emergency"
    >
      {model !== null && (
        <>
          <div class="bw-emergency-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Emergency</h2>
              <div class="sub">
                Danger {Math.round(model.danger)}
                {model.riotActive ? ` · ${model.riotingCount} rioting` : ' · no active riot'}
              </div>
            </div>
            <div class="bw-spacer" />
            {model.playerFired && <span class="bw-pill bad">Dismissed</span>}
          </div>

          <div class="bw-emergency-body">
            <div class="bw-emergency-status">
              {model.riotActive && model.containmentQuietMinutes !== null && (
                <div class="bw-emergency-meter">
                  <span class="k">Containment</span>
                  <span class="v">
                    {model.containmentQuietMinutes} / {model.containmentNeededMinutes} quiet min
                  </span>
                </div>
              )}
              {model.failureWarning && (
                <div class="bw-emergency-warn">
                  Directorate warning — facility seizure pending
                  {model.failureAtTick !== null ? ` (tick ${model.failureAtTick})` : ''}.
                </div>
              )}
              {model.selectedSectorName !== null && (
                <div class="bw-emergency-meter">
                  <span class="k">Target sector</span>
                  <span class="v">{model.selectedSectorName}</span>
                </div>
              )}
            </div>

            <ol class="bw-emergency-ladder">
              {model.levels.map((level) => (
                <li
                  key={level.id}
                  class="bw-emergency-rung"
                  data-active={level.active ? 'true' : 'false'}
                  data-level={level.level}
                >
                  <div class="rung-head">
                    <span class="lvl">{level.level}</span>
                    <div class="copy">
                      <h3>{level.label}</h3>
                      <p>{level.sideEffect}</p>
                    </div>
                    <span class="cost">{level.costLabel}</span>
                  </div>
                  <div class="rung-actions">{levelAction(level, handlers)}</div>
                  {level.disabled && level.disabledReason !== null && (
                    <div class="rung-hint">{level.disabledReason}</div>
                  )}
                </li>
              ))}
            </ol>

            <div class="bw-emergency-footnote">
              Riot squad costs ${model.riotSquadHourlyCost}/hour while deployed. National guard
              costs ${model.nationalGuardCost} once.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function levelAction(
  level: EmergencyLevelModel,
  handlers: {
    readonly onSectorLockdown?: () => void
    readonly onLiftSectorLockdown?: () => void
    readonly onFullLockdown?: () => void
    readonly onLiftFullLockdown?: () => void
    readonly onCallRiotSquad?: () => void
    readonly onDismissRiotSquad?: () => void
    readonly onAuthoriseFreeFire?: () => void
    readonly onRevokeFreeFire?: () => void
    readonly onCallNationalGuard?: () => void
  },
): JSX.Element {
  switch (level.id) {
    case 'sector_lockdown':
      return level.active ? (
        <Button variant="ghost" disabled={level.disabled} onClick={handlers.onLiftSectorLockdown}>
          Lift
        </Button>
      ) : (
        <Button variant="danger" disabled={level.disabled} onClick={handlers.onSectorLockdown}>
          Lock sector
        </Button>
      )
    case 'full_lockdown':
      return level.active ? (
        <Button variant="ghost" onClick={handlers.onLiftFullLockdown}>
          Lift
        </Button>
      ) : (
        <Button variant="danger" onClick={handlers.onFullLockdown}>
          Lock facility
        </Button>
      )
    case 'riot_squad':
      return level.active ? (
        <Button variant="ghost" onClick={handlers.onDismissRiotSquad}>
          Dismiss
        </Button>
      ) : (
        <Button variant="danger" onClick={handlers.onCallRiotSquad}>
          Call squad
        </Button>
      )
    case 'free_fire':
      return level.active ? (
        <Button variant="ghost" onClick={handlers.onRevokeFreeFire}>
          Revoke
        </Button>
      ) : (
        <Button variant="danger" onClick={handlers.onAuthoriseFreeFire}>
          Authorise
        </Button>
      )
    case 'national_guard':
      return (
        <Button
          variant="danger"
          disabled={level.active || level.disabled}
          onClick={handlers.onCallNationalGuard}
        >
          {level.active ? 'Deployed' : 'Call guard'}
        </Button>
      )
  }
}
