/**
 * Programmes panel (T5.3, PRD 5.9).
 *
 * The panel's real job is the second column. A programme that is running needs
 * a progress bar; a programme that is *not* running needs the sentence that
 * makes it run, and PRD 5.9 is explicit that the sentence must carry the
 * number — "Classroom has 6 desks, this needs 10", not "not enough seats".
 * {@link blockerSentence} is where that promise is kept, and it is exported so
 * the copy can be tested directly rather than only through a rendered tree.
 *
 * Presentational only: the host resolves simulation state into a
 * {@link ProgramsModel} and turns taps back into commands.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type ProgramBlockerKind =
  | 'locked'
  | 'no_tutor'
  | 'no_room'
  | 'room_not_functional'
  | 'not_enough_seats'
  | 'no_contiguous_work_block'
  | 'no_enrolment'
  | 'insufficient_funds'

/** The shortfall, in the shape the simulation reports it. */
export interface ProgramBlockerModel {
  readonly kind: ProgramBlockerKind
  readonly have: number
  readonly need: number
  /** Display name of the subject: "Classroom desk", "Instructor", "Medium". */
  readonly subjectName: string
}

export interface ProgramRowModel {
  readonly id: string
  readonly name: string
  readonly roomName: string
  readonly tutorName: string
  readonly hours: number
  readonly seats: number
  readonly sessionsRequired: number
  readonly costPerSession: number
  readonly attendance: 'referred' | 'voluntary' | 'mandatory' | 'queue'
  readonly enrolled: number
  readonly completed: number
  /** Scheduled slot, or null when the programme has no slot. */
  readonly slot: {
    readonly categoryName: string
    readonly startHour: number
    readonly hours: number
    readonly pinned: boolean
  } | null
  /** Set while a session is under way. */
  readonly session: {
    readonly attending: number
    readonly hoursRemaining: number
  } | null
  /** Null when the programme can run. */
  readonly blocker: ProgramBlockerModel | null
}

export interface ProgramsModel {
  readonly rows: readonly ProgramRowModel[]
  readonly selectedId: string | null
  /** True once Delegation is researched; gates the pin control. */
  readonly canPin: boolean
}

export interface ProgramsProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: ProgramsModel | null
  readonly onSelect: (programId: string | null) => void
  readonly onClose: () => void
  readonly onPin?: (programId: string) => void
  readonly onUnpin?: (programId: string) => void
  readonly onEnrol?: (programId: string) => void
  readonly onWithdraw?: (programId: string) => void
}

/** `9` → `"09:00"`. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/**
 * The blocking sentence, with the number that makes it actionable.
 *
 * Every branch names both sides of the shortfall wherever there are two sides.
 * A sentence that omits the number is a sentence the player has to go and
 * investigate, which is the failure mode PRD 5.9 calls out.
 */
export function blockerSentence(blocker: ProgramBlockerModel): string {
  switch (blocker.kind) {
    case 'locked':
      return `Requires the ${blocker.subjectName} node in the Directorate.`
    case 'no_tutor':
      return `No ${blocker.subjectName} on the payroll. This needs ${blocker.need}.`
    case 'no_room':
      return `No ${blocker.subjectName} has been built.`
    case 'room_not_functional':
      return `The ${blocker.subjectName} is missing required objects, so it cannot be used.`
    case 'not_enough_seats':
      return `Room has ${blocker.have} × ${blocker.subjectName}, this needs ${blocker.need}.`
    case 'no_contiguous_work_block':
      return `Needs ${blocker.need} contiguous work hours; the longest block in the ${blocker.subjectName} routine is ${blocker.have}.`
    case 'no_enrolment':
      return 'Nobody is enrolled yet.'
    case 'insufficient_funds':
      return `A session costs $${blocker.need}; the balance is $${blocker.have}.`
  }
}

const ATTENDANCE_LABELS: Readonly<Record<ProgramRowModel['attendance'], string>> = {
  referred: 'Referred',
  voluntary: 'Voluntary',
  mandatory: 'Mandatory',
  queue: 'Queue',
}

export function Programs({
  model,
  onSelect,
  onClose,
  onPin,
  onUnpin,
  onEnrol,
  onWithdraw,
}: ProgramsProps): JSX.Element {
  const open = model !== null
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })
  const selected =
    model === null || model.selectedId === null
      ? null
      : (model.rows.find((row) => row.id === model.selectedId) ?? null)

  return (
    <div
      ref={trapRef}
      class="bw-programs-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Programmes"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-programs-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Programmes</h2>
              <div class="sub">
                {model.rows.filter((row) => row.blocker === null).length} of {model.rows.length}{' '}
                able to run
              </div>
            </div>
          </div>

          <div class="bw-programs-body">
            <ul class="bw-programs-list">
              {model.rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    class="bw-programs-row"
                    data-blocked={row.blocker === null ? 'false' : 'true'}
                    data-selected={row.id === model.selectedId ? 'true' : 'false'}
                    aria-label={`${row.name}, ${row.blocker === null ? 'running' : 'blocked'}`}
                    onClick={() => onSelect(row.id)}
                  >
                    <span class="nm">{row.name}</span>
                    <span class="meta">
                      {row.roomName} · {row.hours}h · {row.enrolled}/{row.seats} seats
                    </span>
                    <span class="state">
                      {row.session !== null
                        ? `In session · ${row.session.attending} present`
                        : row.blocker !== null
                          ? 'Blocked'
                          : row.slot !== null
                            ? `${formatHour(row.slot.startHour)} · ${row.slot.categoryName}`
                            : 'Unscheduled'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <aside class="bw-programs-detail">
              {selected === null ? (
                <p class="bw-programs-empty">
                  Select a programme to see its schedule, its effect, and what is stopping it.
                </p>
              ) : (
                <ProgramDetail
                  row={selected}
                  canPin={model.canPin}
                  {...(onPin === undefined ? {} : { onPin })}
                  {...(onUnpin === undefined ? {} : { onUnpin })}
                  {...(onEnrol === undefined ? {} : { onEnrol })}
                  {...(onWithdraw === undefined ? {} : { onWithdraw })}
                />
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

function ProgramDetail({
  row,
  canPin,
  onPin,
  onUnpin,
  onEnrol,
  onWithdraw,
}: {
  readonly row: ProgramRowModel
  readonly canPin: boolean
  readonly onPin?: (programId: string) => void
  readonly onUnpin?: (programId: string) => void
  readonly onEnrol?: (programId: string) => void
  readonly onWithdraw?: (programId: string) => void
}): JSX.Element {
  return (
    <div class="bw-programs-card">
      <header>
        <h3>{row.name}</h3>
        <span class="bw-pill">{ATTENDANCE_LABELS[row.attendance]}</span>
      </header>

      {row.blocker !== null && (
        <p class="bw-programs-blocker" role="status">
          {blockerSentence(row.blocker)}
        </p>
      )}

      {row.session !== null && (
        <div class="bw-programs-kv">
          <span class="k">In session</span>
          <span class="v">
            {row.session.attending} present · {row.session.hoursRemaining}h remaining
          </span>
        </div>
      )}

      <div class="bw-programs-kv">
        <span class="k">Tutor</span>
        <span class="v">{row.tutorName}</span>
      </div>
      <div class="bw-programs-kv">
        <span class="k">Room</span>
        <span class="v">{row.roomName}</span>
      </div>
      <div class="bw-programs-kv">
        <span class="k">Session</span>
        <span class="v">
          {row.hours}h · ${row.costPerSession}
        </span>
      </div>
      <div class="bw-programs-kv">
        <span class="k">To complete</span>
        <span class="v">{row.sessionsRequired} sessions</span>
      </div>
      <div class="bw-programs-kv">
        <span class="k">Enrolled</span>
        <span class="v">
          {row.enrolled} / {row.seats}
        </span>
      </div>
      <div class="bw-programs-kv">
        <span class="k">Completed</span>
        <span class="v">{row.completed}</span>
      </div>

      {row.slot !== null && (
        <div class="bw-programs-kv">
          <span class="k">Scheduled</span>
          <span class="v">
            {formatHour(row.slot.startHour)}–{formatHour(row.slot.startHour + row.slot.hours)} ·{' '}
            {row.slot.categoryName}
            {row.slot.pinned ? ' · pinned' : ''}
          </span>
        </div>
      )}

      {canPin ? (
        row.slot?.pinned === true ? (
          <Button variant="ghost" onClick={() => onUnpin?.(row.id)}>
            Unpin from this slot
          </Button>
        ) : (
          <Button variant="primary" disabled={row.slot === null} onClick={() => onPin?.(row.id)}>
            Pin to this slot
          </Button>
        )
      ) : (
        <p class="bw-programs-hint">
          Research Delegation to pin a programme to a slot of your choosing.
        </p>
      )}

      <Button onClick={() => onEnrol?.(row.id)} disabled={onEnrol === undefined}>
        Enrol inspected inmate
      </Button>
      <Button variant="ghost" onClick={() => onWithdraw?.(row.id)} disabled={onWithdraw === undefined}>
        Withdraw inspected inmate
      </Button>
    </div>
  )
}
