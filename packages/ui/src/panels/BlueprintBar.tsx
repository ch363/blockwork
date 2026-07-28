/**
 * The blueprint bar: what the staged build will cost, and what is wrong with
 * it (T1.5, PRD 3.2 and 6.3, mockup screen 2).
 *
 * The bar is a **view of a `BlueprintReport` and nothing else**. It holds no
 * blueprint, prices nothing, and never reaches into the simulation; the report
 * arrives already costed and graded by `validateBlueprint`, which ran the
 * staged actions against a detached copy of the world. So the number on the
 * Commit button is the number the worker will deduct, and this file cannot
 * disagree with the simulation about what a wall costs, because it was never
 * told.
 *
 * That leaves this module two jobs, and they are the only two things worth
 * reading here.
 *
 * **Turning grouped issues into sentences.** The report says "requirement,
 * room `cell`, subject `toilet`, count 3". The bar says "3 cells have no
 * toilet". Names come from the report — the data layer owns display strings —
 * but the grammar has to live somewhere, and the alternative of shipping
 * pre-written sentences from `packages/sim` would put prose in the package
 * that is not allowed to know it is being looked at.
 *
 * **Walking the camera.** PRD 6.3 asks for a tappable issue that pans to the
 * problem. An issue that covers three rooms carries three tiles, so tapping
 * the row repeatedly steps through them and wraps, and the row says which one
 * it is on. Panning itself is the host's, via `onFocus`: this package cannot
 * import `render`, and should not want to.
 */

import type { BlueprintIssue, BlueprintReport, Tile } from '@blockwork/sim'
import { useCallback, useState } from 'preact/hooks'
import type { JSX } from 'preact'

import { Icon } from '../icons'

/* -------------------------------------------------------------------------- */
/* Prose                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * English plurals, to the depth the content files actually need.
 *
 * Every room and object name in `packages/data` is a regular noun or a
 * consonant-plus-y ("Dormitory"), so the two rules below cover all of them and
 * the sibilant rule covers the next few someone adds. This is deliberately not
 * a pluralisation library: when a name arrives that these rules get wrong, the
 * fix is a plural field on the definition, not more rules here.
 */
export function plural(noun: string, count: number): string {
  if (count === 1) return noun

  const last = noun.slice(-1)
  const penultimate = noun.slice(-2, -1)

  if (last === 'y' && !'aeiou'.includes(penultimate.toLowerCase())) {
    return `${noun.slice(0, -1)}ies`
  }
  if (/(?:s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`
  return `${noun}s`
}

/** "Mess hall" mid-sentence is "mess hall", but "C Wing" stays "C Wing". */
function lowerIfPlain(name: string): string {
  const rest = name.slice(1)
  // A name with a second capital is doing something deliberate with case.
  return rest !== rest.toLowerCase() ? name : name.charAt(0).toLowerCase() + rest
}

/** "3 cells", or "Cell" when there is only one and it opens the sentence. */
function subjectPhrase(issue: BlueprintIssue): string {
  if (issue.count === 1) return issue.sourceName
  return `${String(issue.count)} ${plural(lowerIfPlain(issue.sourceName), issue.count)}`
}

/**
 * One issue as a sentence.
 *
 * Split from the component and exported so the phrasing can be tested without
 * a DOM, and so a host rendering issues somewhere else — a tooltip, the trace
 * panel — words them the same way.
 */
export function issueSentence(issue: BlueprintIssue): string {
  const subject = subjectPhrase(issue)
  const many = issue.count !== 1

  if (issue.kind === 'rejected') {
    const verb = many ? 'were refused' : 'was refused'
    return `${subject} ${verb}: ${issue.subjectName.replace(/-/g, ' ')}`
  }

  const has = many ? 'have' : 'has'
  return `${subject} ${has} no ${lowerIfPlain(issue.subjectName)}`
}

const CURRENCY = '$'

/** Money as the top bar writes it: no decimals, grouped thousands. */
export function formatCost(amount: number): string {
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(Math.round(amount))
    .toString()
    .replace(/\B(?=(?:\d{3})+$)/g, ',')
  return `${sign}${CURRENCY}${digits}`
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface BlueprintBarProps {
  /** From `validateBlueprint`. The bar renders this and holds nothing else. */
  readonly report: BlueprintReport
  /** Sends the commit. Absent or disabled while one is already in flight. */
  readonly onCommit: () => void
  /** Throws the staged blueprint away. */
  readonly onDiscard: () => void
  /**
   * Pans the camera. Called with one tile at a time; tapping the same row
   * again passes the next tile the issue covers.
   */
  readonly onFocus: (tile: Tile, issue: BlueprintIssue) => void
  /** A commit is in flight, so both actions are held shut. */
  readonly busy?: boolean
  /**
   * Whether there is anything to commit.
   *
   * The host's call, not something to infer from the report. `tiles` and
   * `objects` count *construction*, and a blueprint can be neither: designating
   * a room queues no sites, costs nothing and moves no material, and a bar that
   * decided emptiness from those two counts refused to commit room zoning at
   * all — the commonest build action in the game, and one whose report is a
   * perfectly valid `$0 / 0 tiles / 0 objects`.
   */
  readonly canCommit?: boolean
  /** Shortens the bar so it does not run under an open inspector. */
  readonly inspectorOpen?: boolean
  /** False when no palette tray is showing, so the bar can sit lower. */
  readonly trayOpen?: boolean
}

/** The row's leading dot. Red will not happen; amber will, but will not work. */
function issueColour(issue: BlueprintIssue): string {
  return issue.kind === 'rejected' ? 'var(--danger)' : 'var(--warn)'
}

/** Stable across re-renders, so the walk position survives a re-validation. */
function issueKey(issue: BlueprintIssue): string {
  return `${issue.kind}|${issue.source}|${issue.subject}`
}

export function BlueprintBar({
  report,
  onCommit,
  onDiscard,
  onFocus,
  busy = false,
  canCommit = true,
  inspectorOpen = false,
  trayOpen = true,
}: BlueprintBarProps): JSX.Element {
  // Which of an issue's tiles the next tap goes to. Keyed by issue rather than
  // held as one index, so walking through a cell block's three problems does
  // not reset when the player adds a stroke and the report is rebuilt.
  const [walk, setWalk] = useState<Readonly<Record<string, number>>>({})

  const focusNext = useCallback(
    (issue: BlueprintIssue): void => {
      if (issue.focus.length === 0) return
      const key = issueKey(issue)
      const at = (walk[key] ?? 0) % issue.focus.length
      const tile = issue.focus[at]
      if (tile === undefined) return

      onFocus(tile, issue)
      setWalk((previous) => ({ ...previous, [key]: (at + 1) % issue.focus.length }))
    },
    [onFocus, walk],
  )

  const issues = report.issues

  return (
    <div
      class="bw-bpbar"
      data-inspector={inspectorOpen}
      data-tray={trayOpen}
      role="region"
      aria-label="Blueprint"
    >
      <div class="bp-top">
        <Metric label="Blueprint cost" value={formatCost(report.cost)} />
        <Metric label="Tiles" value={report.tiles.toLocaleString('en-GB')} />
        <Metric label="Objects" value={report.objects.toLocaleString('en-GB')} />
        <Metric label="Issues" value={String(issues.length)} bad={issues.length > 0} />

        <div class="bw-spacer" />

        <button type="button" class="bw-btn ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button
          type="button"
          class="bw-btn primary wide"
          onClick={onCommit}
          disabled={busy || !canCommit}
        >
          {busy ? 'Committing…' : 'Commit build'}
        </button>
      </div>

      {issues.length > 0 && (
        <ul class="bw-bp-issues">
          {issues.map((issue) => {
            const key = issueKey(issue)
            const at = (walk[key] ?? 0) % Math.max(1, issue.focus.length)

            return (
              <li key={key}>
                <button
                  type="button"
                  class="bw-issue"
                  onClick={() => {
                    focusNext(issue)
                  }}
                >
                  <i class="dot" style={{ background: issueColour(issue) }} aria-hidden="true" />
                  <span class="t">{issueSentence(issue)}</span>
                  <span class="go">
                    {issue.focus.length > 1
                      ? `Go ${String(at + 1)}/${String(issue.focus.length)}`
                      : 'Go'}
                    <Icon name="chevronRight" size={13} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  bad = false,
}: {
  readonly label: string
  readonly value: string
  readonly bad?: boolean
}): JSX.Element {
  return (
    <div class="bw-bp-metric">
      <span class="k">{label}</span>
      <span class={bad ? 'v bad' : 'v'}>{value}</span>
    </div>
  )
}
