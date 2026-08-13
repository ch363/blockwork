/**
 * Undo: how a build stops having happened (T1.5, PRD 3.3).
 *
 * The rule is that **undo is a build, not a rewind**. Nothing here snapshots
 * the simulation and restores it. Every action the player commits is paired,
 * at the moment it is applied, with the list of `BuildAction`s that reverses
 * it, and undoing means running that list forwards through exactly the same
 * code path that ran the original. A world state that undo can reach is
 * therefore a world state the player could have built by hand, which is the
 * property that keeps undo from becoming a way to smuggle impossible prisons
 * into the simulation.
 *
 * Three consequences.
 *
 * **The inverse is captured before the action, not derived after it.** The
 * inverse of `PaintFloor` is "the floor that was there", and after painting
 * nobody knows what that was. So `captureInverse` reads the world first and
 * hands back a `restore` action holding the tiles' prior structure and
 * designation. That is also why one primitive inverts six different build
 * commands: they all end up writing the same six facts about a tile.
 *
 * **Objects are named by tile, not by entity id.** The main thread issues the
 * commit and never learns the entity ids the worker allocated, so the inverse
 * of `PlaceObject` has to be `RemoveObjectAt(tile)`. It resolves through the
 * anchor the grid already stores, which the renderer needs anyway.
 *
 * **Money settles at undo time, not at capture time.** How much a cancelled
 * build refunds depends on how much of it got built, and that is not known
 * until the player actually undoes. `blueprint.ts` owns the arithmetic
 * (`siteCancellationRefund`, `salvage`); this module owns when it runs.
 *
 * The two stacks. `UndoStack` is the player-facing one and belongs on the main
 * thread: it interleaves blueprint strokes, which undo locally and instantly,
 * with commits, which undo by sending a command. `CommitLedger` is the
 * worker's half, holding the inverses themselves, because only the thread with
 * the world can capture them. Both are capped at
 * `balance.construction.undoDepth`, and both are session state — deliberately
 * outside the determinism fingerprint and outside the save file, because an
 * undo history that survived a reload would let a player undo their way past
 * the point they saved.
 */

import type { GameData } from '../data/loader'
import { ObjectWorld } from '../entities/objects'

import {
  BLUEPRINT_COMMANDS,
  actionFromJson,
  actionTiles,
  applyBuildActions,
  tileRestoreRefund,
} from './blueprint'
import type { BuildAction, BuildDeps, BuildRun, TileRestore } from './blueprint'
import { isJsonArray } from './commands'
import type { Command, JsonValue } from './commands'
import type { CommandHandler, EventSink, SystemContext } from './simulation'

/* -------------------------------------------------------------------------- */
/* Capturing inverses                                                          */
/* -------------------------------------------------------------------------- */

/** Everything a build command can change about one tile, as it is right now. */
export function snapshotTile(world: ObjectWorld, index: number): TileRestore {
  const grid = world.grid
  const wall = grid.getAt('wallMaterial', index)
  const floor = grid.getAt('floorMaterial', index)
  const door = world.doors.get(index)

  return {
    index,
    wall: world.materials.isNone(wall) ? null : world.materials.idAt(wall),
    floor: world.materials.isNone(floor) ? null : world.materials.idAt(floor),
    door: door?.type ?? null,
    doorLocked: door?.locked ?? false,
    outdoors: grid.getAt('outdoors', index) === 1,
    designation: world.rooms.designationIdAt(index) ?? null,
  }
}

/**
 * The action that reverses `action`, read against the world as it stands.
 *
 * Must be called **before** the action runs. Returns `undefined` when there is
 * nothing to reverse: an action naming an object that does not exist, or a
 * rectangle entirely off the grid, would have done nothing in the first place.
 */
export function captureInverse(
  world: ObjectWorld,
  data: GameData,
  action: BuildAction,
): BuildAction | undefined {
  switch (action.kind) {
    case 'placeObject': {
      // The tile is not yet occupied, so the inverse is simply "take back
      // whatever ends up anchored here".
      if (!world.grid.inBounds(action.tile.x, action.tile.y)) return undefined
      return { kind: 'removeObjectAt', tile: action.tile }
    }

    case 'removeObject': {
      const entity = world.objects.get(action.entityId)
      if (entity === undefined) return undefined
      return {
        kind: 'placeObject',
        tile: { x: entity.tx, y: entity.ty },
        objectDefId: entity.object.defId,
        rotation: entity.object.rotation,
      }
    }

    case 'removeObjectAt': {
      if (!world.grid.inBounds(action.tile.x, action.tile.y)) return undefined
      const index = world.grid.idx(action.tile.x, action.tile.y)
      const entity = world.objects.at(index)
      if (entity === undefined || entity.tileIndex !== index) return undefined
      return {
        kind: 'placeObject',
        tile: action.tile,
        objectDefId: entity.object.defId,
        rotation: entity.object.rotation,
      }
    }

    default: {
      const tiles = actionTiles(world, data, action)
      if (tiles.length === 0) return undefined
      return { kind: 'restore', tiles: tiles.map((index) => snapshotTile(world, index)) }
    }
  }
}

/**
 * The inverses of a whole list, in the order they must be applied to undo it.
 *
 * Applies each action as it goes: the inverse of action N is the world after
 * actions 0..N-1, which is the only world that knows what N is about to
 * overwrite. Capturing against the pristine world would miss a `removeObjectAt`
 * that targets something an earlier action in the same commit just placed.
 *
 * Returns the bill as well, so the commit handler does not have to run the
 * list a second time.
 */
export function captureInverses(
  deps: BuildDeps,
  actions: readonly BuildAction[],
): { readonly inverse: readonly BuildAction[]; readonly run: BuildRun } {
  const captured: BuildAction[] = []
  let tiles = 0
  let objects = 0
  let cost = 0
  let refund = 0

  for (const action of actions) {
    const inverse = captureInverse(deps.world, deps.data, action)
    if (inverse !== undefined) captured.push(inverse)

    const step = applyBuildActions(deps, [action])
    tiles += step.tiles
    objects += step.objects
    cost += step.cost
    refund += step.refund
  }

  captured.reverse()
  return { inverse: captured, run: { tiles, objects, cost, refund } }
}

/* -------------------------------------------------------------------------- */
/* Refunds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What undoing a commit would pay back if it happened now.
 *
 * Exposed separately from the undo itself so the UI can offer the number
 * before the player commits to the decision, and so the arithmetic is
 * testable without a command queue. It is the sum over every site the commit
 * queued of `siteCancellationRefund`, plus the full purchase price of every
 * object it bought — see `blueprint.ts` for why those two rules differ.
 */
export function commitRefund(world: ObjectWorld, data: GameData, record: CommitRecord): number {
  let refund = 0

  for (const action of record.inverse) {
    switch (action.kind) {
      case 'removeObjectAt': {
        if (!world.grid.inBounds(action.tile.x, action.tile.y)) break
        const entity = world.objects.at(world.grid.idx(action.tile.x, action.tile.y))
        if (entity === undefined) break
        refund += data.objects.find(entity.object.defId)?.cost ?? 0
        break
      }
      case 'restore': {
        for (const entry of action.tiles) refund += tileRestoreRefund(world, data, entry)
        break
      }
      default:
        break
    }
  }

  return refund
}

/* -------------------------------------------------------------------------- */
/* The player-facing stack                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One reversible thing the player did.
 *
 * Two kinds because they undo in two different places. A blueprint stroke has
 * never left the main thread, so taking it back is an array pop with no round
 * trip and no tick of latency, which is what PRD 6.3's two-finger tap has to
 * feel like. A commit has to go back to the worker.
 */
export type UndoEntry =
  | { readonly kind: 'blueprint'; readonly strokeId: number }
  | { readonly kind: 'commit'; readonly sequence: number; readonly cost: number }

/**
 * The last `depth` things the player did, newest last.
 *
 * Depth is `balance.construction.undoDepth`, which is 50 (PRD 3.3). Past it,
 * the oldest entry falls off the bottom: an undo history is a convenience, not
 * a transaction log, and holding every stroke of a four-hour session would
 * pin every tile snapshot those strokes captured.
 */
export class UndoStack {
  readonly depth: number

  #entries: UndoEntry[] = []

  constructor(depth: number) {
    if (!Number.isInteger(depth) || depth < 1) {
      throw new RangeError(`undo depth must be a positive integer, received ${depth}`)
    }
    this.depth = depth
  }

  get size(): number {
    return this.#entries.length
  }

  /** Oldest first. */
  entries(): readonly UndoEntry[] {
    return this.#entries.slice()
  }

  /** What the next undo would take back, without taking it back. */
  peek(): UndoEntry | undefined {
    return this.#entries[this.#entries.length - 1]
  }

  push(entry: UndoEntry): void {
    this.#entries.push(entry)
    if (this.#entries.length > this.depth) {
      this.#entries.splice(0, this.#entries.length - this.depth)
    }
  }

  pop(): UndoEntry | undefined {
    return this.#entries.pop()
  }

  clear(): void {
    this.#entries = []
  }
}

/** An `UndoStack` sized from the data layer, per CLAUDE.md rule 4. */
export function createUndoStack(data: GameData): UndoStack {
  return new UndoStack(data.balance.construction.undoDepth)
}

/* -------------------------------------------------------------------------- */
/* The worker's ledger                                                         */
/* -------------------------------------------------------------------------- */

/** A committed build, and the actions that would take it back. */
export interface CommitRecord {
  /** Matches the `sequence` in the main thread's `UndoEntry`. */
  readonly sequence: number
  readonly tick: number
  /** What the commit deducted. */
  readonly cost: number
  /** Applied in order to reverse the commit. */
  readonly inverse: readonly BuildAction[]
  /** The forward actions the commit applied, kept so redo can replay them. */
  readonly actions: readonly BuildAction[]
  /** Net refund the undo settled. Redo pulls this back from the outbox. */
  readonly undoNet?: number
}

/**
 * Commits awaiting a possible undo, newest last.
 *
 * Session state, like `UndoStack`: it never reaches the fingerprint and never
 * reaches the save file. Determinism is unaffected because the ledger is a
 * pure function of the command history, so two runs given the same commands
 * build the same ledger and undo the same way.
 */
export class CommitLedger {
  readonly depth: number

  #records: CommitRecord[] = []
  #redo: CommitRecord[] = []
  #nextSequence = 1

  constructor(depth: number) {
    if (!Number.isInteger(depth) || depth < 1) {
      throw new RangeError(`undo depth must be a positive integer, received ${depth}`)
    }
    this.depth = depth
  }

  get size(): number {
    return this.#records.length
  }

  /** Commits awaiting a possible redo, newest last. */
  get redoSize(): number {
    return this.#redo.length
  }

  /** The sequence number the next commit will be given. */
  get nextSequence(): number {
    return this.#nextSequence
  }

  records(): readonly CommitRecord[] {
    return this.#records.slice()
  }

  redoRecords(): readonly CommitRecord[] {
    return this.#redo.slice()
  }

  peek(): CommitRecord | undefined {
    return this.#records[this.#records.length - 1]
  }

  peekRedo(): CommitRecord | undefined {
    return this.#redo[this.#redo.length - 1]
  }

  record(commit: Omit<CommitRecord, 'sequence'>): CommitRecord {
    this.#redo = []
    return this.#pushUndo({ ...commit, sequence: this.#nextSequence++ })
  }

  /**
   * Restores a redone commit onto the undo stack without clearing the remaining
   * redo entries (undo×N → redo×1 must leave N-1 redos).
   */
  recordFromRedo(commit: Omit<CommitRecord, 'sequence'>): CommitRecord {
    return this.#pushUndo({ ...commit, sequence: this.#nextSequence++ })
  }

  #pushUndo(stored: CommitRecord): CommitRecord {
    this.#records.push(stored)
    if (this.#records.length > this.depth) {
      this.#records.splice(0, this.#records.length - this.depth)
    }
    return stored
  }

  take(): CommitRecord | undefined {
    return this.#records.pop()
  }

  pushRedo(record: CommitRecord): void {
    this.#redo.push(record)
    if (this.#redo.length > this.depth) {
      this.#redo.splice(0, this.#redo.length - this.depth)
    }
  }

  takeRedo(): CommitRecord | undefined {
    return this.#redo.pop()
  }

  clear(): void {
    this.#records = []
    this.#redo = []
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a commit, undo, or redo, or part of one, produced nothing. */
export type BlueprintRejection =
  | 'invalid-payload'
  | 'invalid-action'
  | 'empty-blueprint'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'wrong-world'

function reject(
  events: EventSink,
  tick: number,
  command: string,
  reason: BlueprintRejection,
  detail: Readonly<Record<string, JsonValue>> = {},
): void {
  events.emit({
    tick,
    kind: 'blueprint.rejected',
    causeIds: [],
    data: { command, reason, ...detail },
  })
}

function asRecord(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || isJsonArray(value)) return undefined
  return value
}

export interface BlueprintCommands {
  /** The worker's undo history. Exposed so a host can clear it on load. */
  readonly ledger: CommitLedger
  readonly handlers: Record<string, CommandHandler>
}

/**
 * The two commands a blueprint sends: commit, and take it back.
 *
 * The ledger is held in this closure rather than on the world, because it is
 * session state and the world is saved state. That does mean one call per
 * simulation rather than one per process, which is how the rest of the command
 * handler factories are wired anyway.
 *
 * **Commit is atomic** (PRD 3.2): the whole action list is applied inside one
 * command, so the entire build appears in the queue on a single tick and the
 * cost is deducted once. Individual actions may still be refused — a door
 * ordered off the grid, an object on an occupied tile — and each refusal
 * raises its own `CausalEvent` from the layer that refused it. A commit is not
 * all-or-nothing, because a player who draws one bad tile out of four hundred
 * wants the three hundred and ninety-nine.
 */
export function blueprintCommandHandlers(data: GameData): BlueprintCommands {
  const ledger = new CommitLedger(data.balance.construction.undoDepth)

  const bind = (
    context: SystemContext,
    command: Command,
    run: (deps: BuildDeps, payload: Readonly<Record<string, JsonValue>>) => void,
  ): void => {
    const world = context.world
    const tick = context.clock.tick

    if (!(world instanceof ObjectWorld)) {
      reject(context.events, tick, command.type, 'wrong-world')
      return
    }

    const payload = asRecord(command.payload)
    if (payload === undefined) {
      reject(context.events, tick, command.type, 'invalid-payload')
      return
    }

    run({ world, data, events: context.events, tick }, payload)
  }

  return {
    ledger,

    handlers: {
      [BLUEPRINT_COMMANDS.commit]: (command, context) => {
        bind(context, command, (deps, payload) => {
          const raw = payload['actions']
          if (raw === undefined || !isJsonArray(raw)) {
            reject(deps.events, deps.tick, command.type, 'invalid-payload')
            return
          }

          const actions: BuildAction[] = []
          for (const entry of raw) {
            const action = actionFromJson(entry)
            if (action === undefined) {
              reject(deps.events, deps.tick, command.type, 'invalid-action')
              continue
            }
            actions.push(action)
          }

          if (actions.length === 0) {
            reject(deps.events, deps.tick, command.type, 'empty-blueprint')
            return
          }

          const { inverse, run } = captureInverses(deps, actions)
          settle(deps, run)

          const record = ledger.record({
            tick: deps.tick,
            cost: run.cost,
            inverse,
            actions,
          })

          deps.events.emit({
            tick: deps.tick,
            kind: 'blueprint.committed',
            causeIds: [],
            data: {
              sequence: record.sequence,
              actions: actions.length,
              tiles: run.tiles,
              objects: run.objects,
              cost: run.cost,
            },
          })
        })
      },

      [BLUEPRINT_COMMANDS.undo]: (command, context) => {
        bind(context, command, (deps) => {
          const record = ledger.take()
          if (record === undefined) {
            reject(deps.events, deps.tick, command.type, 'nothing-to-undo')
            return
          }

          const run = applyBuildActions(deps, record.inverse)
          settle(deps, run)
          ledger.pushRedo({ ...record, undoNet: run.refund - run.cost })

          deps.events.emit({
            tick: deps.tick,
            kind: 'blueprint.undone',
            causeIds: [],
            data: {
              sequence: record.sequence,
              spent: record.cost,
              refund: run.refund - run.cost,
            },
          })
        })
      },

      [BLUEPRINT_COMMANDS.redo]: (command, context) => {
        bind(context, command, (deps) => {
          const record = ledger.takeRedo()
          if (record === undefined) {
            reject(deps.events, deps.tick, command.type, 'nothing-to-redo')
            return
          }

          const { inverse, run } = captureInverses(deps, record.actions)
          settleRedo(deps, run, record)

          const restored = ledger.recordFromRedo({
            tick: deps.tick,
            cost: run.cost,
            inverse,
            actions: record.actions,
          })

          deps.events.emit({
            tick: deps.tick,
            kind: 'blueprint.redone',
            causeIds: [],
            data: {
              sequence: restored.sequence,
              actions: record.actions.length,
              tiles: run.tiles,
              objects: run.objects,
              cost: run.cost,
            },
          })
        })
      },
    },
  }
}

/**
 * Books a run's money against the world's two tallies.
 *
 * Netted first, so an undo that both scraps a wall and rebuilds a floor
 * produces one entry rather than two that partly cancel. T3.6 drains both
 * sides into the real ledger.
 */
function settle(deps: BuildDeps, run: BuildRun): void {
  const net = run.refund - run.cost
  if (net > 0) deps.world.addRefund(net)
  else if (net < 0) deps.world.addSpend(-net)
}

/** Pulls `amount` out of the refund outbox, leaving any remainder untouched. */
function pullRefunds(deps: BuildDeps, amount: number): void {
  if (amount <= 0 || deps.world.refundsOwed <= 0) return
  const taken = deps.world.takeRefunds()
  const keep = Math.max(0, taken - amount)
  if (keep > 0) deps.world.addRefund(keep)
}

/** Pulls `amount` out of the spend outbox, leaving any remainder untouched. */
function pullSpend(deps: BuildDeps, amount: number): void {
  if (amount <= 0 || deps.world.spendOwed <= 0) return
  const taken = deps.world.takeSpend()
  const keep = Math.max(0, taken - amount)
  if (keep > 0) deps.world.addSpend(keep)
}

/**
 * Redo's money: take back the undo refund, re-book the build, then drop only
 * the spend that would double-charge residual original commit spend still
 * sitting in the outbox. After T8.1's minute drain that residual is often
 * already zero — redo must still charge the full cost in that case.
 */
function settleRedo(deps: BuildDeps, run: BuildRun, record: CommitRecord): void {
  const undoNet = record.undoNet ?? 0
  const residualSpend = Math.min(deps.world.spendOwed, record.cost)
  pullRefunds(deps, undoNet)
  settle(deps, run)
  if (residualSpend <= 0) return
  const redoSpend = Math.max(0, run.cost - run.refund)
  if (redoSpend > 0) pullSpend(deps, Math.min(redoSpend, residualSpend))
}
