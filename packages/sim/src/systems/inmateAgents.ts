/**
 * Pathing agent view over live inmates (T2.3 + T2.4 integration).
 *
 * Pathing and movement expect a `MobileAgent` store. Inmates already carry the
 * same motion fields on their entity shells, so this store is a thin facade:
 * no second position source, no sync bridge. Escorted inmates are omitted so
 * staff BFS can move them without fighting the pathing stack.
 */

import type { InmateEntity, InmateRegistry } from '../entities/inmate'
import type { EscortJobQueue } from '../entities/staff'
import { ACCESS } from '../pathfinding/regionGraph'
import type { AgentStore, MobileAgent } from './pathingSystem'

export interface InmateAgentStoreOptions {
  readonly inmates: InmateRegistry
  readonly escorts: EscortJobQueue
  readonly tileWorldUnits: number
  readonly inmateSpeed: number
}

/**
 * `AgentStore` backed by `InmateRegistry`. Staff keep their own BFS stepper
 * until escorts migrate onto A* (later).
 */
export class InmateAgentStore implements AgentStore {
  readonly #inmates: InmateRegistry
  readonly #escorts: EscortJobQueue
  readonly #tileWorldUnits: number
  readonly #inmateSpeed: number
  /** Scratch list rebuilt each `all()` — pathing iterates once per tick. */
  readonly #scratch: MobileAgent[] = []

  constructor(options: InmateAgentStoreOptions) {
    this.#inmates = options.inmates
    this.#escorts = options.escorts
    this.#tileWorldUnits = options.tileWorldUnits
    this.#inmateSpeed = options.inmateSpeed
  }

  get size(): number {
    return this.all().length
  }

  all(): readonly MobileAgent[] {
    this.#scratch.length = 0
    for (const entity of this.#inmates.all()) {
      if (isInmateEscorted(this.#escorts, entity.id)) continue
      syncInmateMotion(entity, this.#inmateSpeed)
      this.#scratch.push(entity)
    }
    return this.#scratch
  }

  get(id: number): MobileAgent | undefined {
    const entity = this.#inmates.get(id)
    if (entity === undefined) return undefined
    if (isInmateEscorted(this.#escorts, id)) return undefined
    syncInmateMotion(entity, this.#inmateSpeed)
    return entity
  }

  setGoal(agentId: number, goalTile: number): void {
    const entity = this.#inmates.get(agentId)
    if (entity === undefined) return
    syncInmateMotion(entity, this.#inmateSpeed)
    entity.goalTile = goalTile
    entity.path = null
    entity.pathIndex = 0
    entity.awaitingPath = false
  }

  tileWorldUnits(): number {
    return this.#tileWorldUnits
  }
}

/** True while an escort job is actively moving / collecting this inmate. */
export function isInmateEscorted(escorts: EscortJobQueue, inmateId: number): boolean {
  for (const job of escorts.active()) {
    if (job.inmateId !== inmateId) continue
    if (job.state === 'approach_inmate' || job.state === 'escort_to_destination') {
      return true
    }
  }
  return false
}

/** Keeps access mask and speed aligned with current balance. */
export function syncInmateMotion(entity: InmateEntity, inmateSpeed: number): void {
  entity.accessMask = ACCESS.INMATE
  entity.speed = inmateSpeed
}
