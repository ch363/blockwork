/**
 * The Guided Contract (T6.4, PRD 3.8).
 *
 * Blockwork has no campaign and no tutorial level. The first contract *is* the
 * tutorial: its to-do list is already an ordered set of objectives with real
 * predicates the simulation already evaluates, so making it teach costs no new
 * content and — more importantly — cannot drift out of step with the game the
 * way a scripted tutorial does. Finish the contract and you have learned the
 * game by playing it.
 *
 * The only thing added on top is a **coach mark**, and the rule for showing one
 * is deliberately narrow: sixty seconds with no action toward the *current*
 * objective. Not sixty seconds idle — a player happily building a corridor is
 * not stuck — and not on arrival, because a hint offered before anyone has
 * tried anything is just a modal in the way.
 *
 * Three modes:
 *
 *   - `guided` — the default for a first prison. One objective at a time, one
 *     coach mark when stuck.
 *   - `veteran` — PRD 3.8's "show me everything": every mark available at
 *     once, no idle gate, nothing withheld.
 *   - `off` — skipped. Fully, and for good.
 *
 * Real milliseconds, not ticks: the sixty seconds is about the *player* being
 * stuck, and a player staring at a paused game is every bit as stuck as one
 * staring at a running one.
 */

/** PRD 3.8: "no action taken toward the current objective for 60 seconds". */
export const COACH_MARK_IDLE_MS = 60_000

export const ONBOARDING_MODES = ['guided', 'veteran', 'off'] as const
export type OnboardingMode = (typeof ONBOARDING_MODES)[number]

/**
 * Where a coach mark points.
 *
 * Named rather than positional so the panel can look up the live rect of the
 * control — a bubble pinned to a coordinate would be wrong the moment the
 * layout reflows for a different device or a larger dynamic type setting.
 */
export type CoachAnchor =
  | 'tool:build'
  | 'tool:rooms'
  | 'tool:objects'
  | 'tool:utilities'
  | 'tool:staff'
  | 'tool:reports'
  | 'topbar:speed'
  | 'topbar:alerts'
  | 'panel:directorate'
  | 'panel:intake'
  | 'none'

export interface OnboardingObjective {
  readonly index: number
  readonly label: string
  readonly done: boolean
  /** Contract predicate type; picks the coach mark. */
  readonly predicateType: string
  /** Predicate subject, where it has one — a room id, a staff id. */
  readonly subject: string
}

export interface CoachMark {
  readonly objectiveIndex: number
  readonly anchor: CoachAnchor
  readonly title: string
  readonly body: string
}

/* -------------------------------------------------------------------------- */
/* Coach mark copy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What to say, keyed by the predicate the objective is waiting on.
 *
 * This lives in the app rather than in `packages/data` because it is not
 * balance and not content — it is a sentence about *this interface*, naming
 * this tool dock and this panel, and it has to change when they do.
 */
interface CoachTemplate {
  readonly anchor: CoachAnchor
  readonly title: string
  readonly body: (subject: string) => string
}

const COACH_TEMPLATES: Readonly<Record<string, CoachTemplate>> = {
  roomCount: {
    anchor: 'tool:rooms',
    title: 'Designate the room',
    body: (subject) =>
      `Walls first, then Rooms. Drag a rectangle inside the walls and pick ${label(subject)} — a room is a designation over enclosed floor, not a building.`,
  },
  roomGrade: {
    anchor: 'tool:objects',
    title: 'Furnish it',
    body: (subject) =>
      `A ${label(subject)} is graded on what is in it. Open Objects and add the things the room inspector lists as missing.`,
  },
  objectCount: {
    anchor: 'tool:objects',
    title: 'Place the object',
    body: (subject) => `Open Objects and place a ${label(subject)}. Objects are bought and delivered, not built.`,
  },
  staffHired: {
    anchor: 'tool:staff',
    title: 'Hire someone',
    body: (subject) =>
      `Open Staff and hire a ${label(subject)}. Administrators need an office of their own before they will take the post.`,
  },
  capacityAtLeast: {
    anchor: 'tool:rooms',
    title: 'Make room for them',
    body: () =>
      'Capacity is beds, not floor space: a functional cell holds one, a dormitory holds its bunks. Build more cells before the next bus.',
  },
  populationAtLeast: {
    anchor: 'panel:intake',
    title: 'Accept some inmates',
    body: () =>
      'Intake runs on a bus timetable. Leave continuous intake on, or request a specific category, and make sure there are beds waiting.',
  },
  programCompletions: {
    anchor: 'panel:directorate',
    title: 'Run a programme',
    body: (subject) =>
      `${label(subject)} needs its Directorate node, a tutor, a functional room and a contiguous work block in the Routine. The Programmes panel names whichever one you are missing.`,
  },
  directorateComplete: {
    anchor: 'panel:directorate',
    title: 'Research it',
    body: (subject) =>
      `Open the Directorate and start ${label(subject)}. Research needs its administrator hired and sitting in a functional office, or it will not advance.`,
  },
  needBelow: {
    anchor: 'tool:reports',
    title: 'Find out what they need',
    body: (subject) =>
      `Open Reports and drill into ${label(subject)}. The needs report names the bottleneck rather than making you guess.`,
  },
  daysWithout: {
    anchor: 'topbar:alerts',
    title: 'Keep it quiet',
    body: () =>
      'This one is a waiting game. Watch the alerts for the incident that resets the streak, and open its Trace to see what caused it.',
  },
  balanceAtLeast: {
    anchor: 'tool:reports',
    title: 'Balance the books',
    body: () =>
      'Reports shows where the money goes. Intake fees and daily payments arrive on their own; wages and utilities do not stop.',
  },
  staffMoraleAtLeast: {
    anchor: 'tool:staff',
    title: 'Look after the staff',
    body: () =>
      'Morale is mostly met staff needs. Build a staff room and a canteen, and check nobody is stuck on a post through their break.',
  },
}

const FALLBACK: CoachTemplate = {
  anchor: 'topbar:speed',
  title: 'Keep going',
  body: () =>
    'Let the clock run and watch what happens. Anything that goes wrong raises an alert you can open to see the chain of causes.',
}

/** `mess_hall` → `Mess hall`. Ids are the only name available here. */
function label(subject: string): string {
  if (subject === '') return 'it'
  const words = subject.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The mark for one objective, whatever its predicate. */
export function coachMarkFor(objective: OnboardingObjective): CoachMark {
  const template = COACH_TEMPLATES[objective.predicateType] ?? FALLBACK
  return {
    objectiveIndex: objective.index,
    anchor: template.anchor,
    title: template.title,
    body: template.body(objective.subject),
  }
}

/* -------------------------------------------------------------------------- */
/* Which actions count                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Command types that count as progress toward a predicate.
 *
 * "Action toward the current objective" has to mean something specific, or the
 * idle timer is just an idle timer. Opening a panel is not progress; committing
 * a blueprint that designates a room is.
 */
const RELEVANT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  roomCount: ['rooms.designate', 'blueprint.commit', 'construction.placeFoundation'],
  roomGrade: ['objects.place', 'blueprint.commit'],
  objectCount: ['objects.place', 'blueprint.commit'],
  staffHired: ['staff.hire'],
  capacityAtLeast: ['rooms.designate', 'objects.place', 'blueprint.commit'],
  populationAtLeast: ['intake.setContinuous', 'intake.setRequested'],
  programCompletions: ['program.enrol', 'program.pin', 'directorate.start'],
  directorateComplete: ['directorate.start'],
  needBelow: ['objects.place', 'blueprint.commit', 'routine.setCategory'],
  daysWithout: ['standingOrders.setPunishment', 'post.create', 'search.shakedown'],
  balanceAtLeast: ['contract.accept', 'labour.assign'],
  staffMoraleAtLeast: ['staff.hire', 'rooms.designate', 'blueprint.commit'],
}

/** Whether `commandType` is work toward this objective. */
export function isProgressToward(objective: OnboardingObjective, commandType: string): boolean {
  const relevant = RELEVANT_COMMANDS[objective.predicateType]
  if (relevant === undefined) return false
  return relevant.includes(commandType)
}

/* -------------------------------------------------------------------------- */
/* The controller                                                              */
/* -------------------------------------------------------------------------- */

export interface OnboardingState {
  readonly mode: OnboardingMode
  readonly objectives: readonly OnboardingObjective[]
  /** The objective the guide is on, or null when they are all done. */
  readonly currentIndex: number | null
  /** Marks to render now. One in `guided`, all outstanding in `veteran`. */
  readonly marks: readonly CoachMark[]
}

export interface OnboardingSnapshot {
  readonly mode: OnboardingMode
  readonly dismissed: readonly number[]
}

/**
 * Tracks what the player is on, and whether they are stuck on it.
 *
 * Deliberately free of any dependency on the simulation, the DOM or a clock:
 * it is handed the objectives and the current time, and everything about
 * PRD 3.8 falls out of those two inputs.
 */
export class Onboarding {
  #mode: OnboardingMode
  #objectives: readonly OnboardingObjective[] = []
  /** Real ms of the last action toward the current objective. */
  #lastProgressAt = 0
  #currentIndex: number | null = null
  /** Objectives whose mark the player has waved away. */
  readonly #dismissed = new Set<number>()

  constructor(mode: OnboardingMode = 'guided', startedAtMs = 0) {
    this.#mode = mode
    this.#lastProgressAt = startedAtMs
  }

  get mode(): OnboardingMode {
    return this.#mode
  }

  get objectives(): readonly OnboardingObjective[] {
    return this.#objectives
  }

  /**
   * Switches mode.
   *
   * Changing mode restarts the idle clock: a player who has just turned the
   * guide on should get a minute to try before being told what to do.
   */
  setMode(mode: OnboardingMode, nowMs: number): void {
    this.#mode = mode
    this.#lastProgressAt = nowMs
  }

  /** PRD 3.8: fully skippable. */
  skip(nowMs: number): void {
    this.setMode('off', nowMs)
  }

  /**
   * Replaces the objective list, usually once a frame from the contract book.
   *
   * When the current objective changes — because the last one completed — the
   * idle clock restarts. Finishing something is the clearest possible evidence
   * that the player is not stuck.
   */
  update(objectives: readonly OnboardingObjective[], nowMs: number): void {
    this.#objectives = objectives
    const next = objectives.find((objective) => !objective.done)?.index ?? null
    if (next !== this.#currentIndex) {
      this.#currentIndex = next
      this.#lastProgressAt = nowMs
    }
  }

  /** The player did something. Resets the clock if it was relevant. */
  noteCommand(commandType: string, nowMs: number): void {
    const current = this.#current()
    if (current === undefined) return
    if (!isProgressToward(current, commandType)) return
    this.#lastProgressAt = nowMs
  }

  /** Hides the mark for the current objective without leaving the guide. */
  dismissCurrent(): void {
    if (this.#currentIndex === null) return
    this.#dismissed.add(this.#currentIndex)
  }

  /** Milliseconds the player has gone without progress. */
  idleMs(nowMs: number): number {
    return Math.max(0, nowMs - this.#lastProgressAt)
  }

  /**
   * Everything the panel needs to draw, for this moment.
   *
   * `off` returns no objectives at all rather than an empty guide: a skipped
   * tutorial should leave nothing behind on screen.
   */
  state(nowMs: number): OnboardingState {
    if (this.#mode === 'off') {
      return { mode: 'off', objectives: [], currentIndex: null, marks: [] }
    }

    const outstanding = this.#objectives.filter((objective) => !objective.done)

    if (this.#mode === 'veteran') {
      // "Show me everything": no idle gate, nothing withheld, in order.
      return {
        mode: 'veteran',
        objectives: this.#objectives,
        currentIndex: this.#currentIndex,
        marks: outstanding.map(coachMarkFor),
      }
    }

    const current = this.#current()
    const stuck =
      current !== undefined &&
      !this.#dismissed.has(current.index) &&
      this.idleMs(nowMs) >= COACH_MARK_IDLE_MS

    return {
      mode: 'guided',
      objectives: this.#objectives,
      currentIndex: this.#currentIndex,
      marks: stuck && current !== undefined ? [coachMarkFor(current)] : [],
    }
  }

  serialise(): OnboardingSnapshot {
    return { mode: this.#mode, dismissed: [...this.#dismissed].sort((a, b) => a - b) }
  }

  restore(snapshot: OnboardingSnapshot, nowMs: number): void {
    this.#mode = snapshot.mode
    this.#dismissed.clear()
    for (const index of snapshot.dismissed) this.#dismissed.add(index)
    this.#lastProgressAt = nowMs
  }

  #current(): OnboardingObjective | undefined {
    if (this.#currentIndex === null) return undefined
    return this.#objectives.find((objective) => objective.index === this.#currentIndex)
  }
}

/* -------------------------------------------------------------------------- */
/* Building the objective list                                                 */
/* -------------------------------------------------------------------------- */

/** The shape the contract book hands over, narrowed to what this needs. */
export interface GuidedContractView {
  readonly todoItems: readonly {
    readonly label: string
    readonly predicate: { readonly type: string } & Record<string, unknown>
  }[]
  readonly itemPassed: readonly boolean[]
}

/**
 * Turns the active contract's to-do list into objectives.
 *
 * The subject is dug out of whichever field the predicate happens to name it
 * in, because the predicate union does not share one — a `roomCount` has a
 * `roomId`, a `staffHired` has a `staffId`. Missing is fine: the copy falls
 * back to "it".
 */
export function objectivesFromContract(
  contract: GuidedContractView | null,
): readonly OnboardingObjective[] {
  if (contract === null) return []
  return contract.todoItems.map((item, index) => ({
    index,
    label: item.label,
    done: contract.itemPassed[index] === true,
    predicateType: item.predicate.type,
    subject: subjectOf(item.predicate),
  }))
}

const SUBJECT_KEYS = [
  'roomId',
  'objectId',
  'staffId',
  'programId',
  'nodeId',
  'needId',
  'incident',
] as const

function subjectOf(predicate: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const value = predicate[key]
    if (typeof value === 'string') return value
  }
  return ''
}
