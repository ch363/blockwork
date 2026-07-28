/**
 * Pathing agent view over live inmates (T2.3 + T2.4 integration).
 *
 * Pathing and movement expect a `MobileAgent` store. Inmates already carry the
 * same motion fields on their entity shells, so this store is a thin facade:
 * no second position source, no sync bridge. Escorted inmates are omitted so
 * staff BFS can move them without fighting the pathing stack.
 */

import type { GameData } from '../data/loader'
import type { InmateEntity, InmateRegistry } from '../entities/inmate'
import type { EscortJobQueue } from '../entities/staff'
import { ACCESS } from '../pathfinding/regionGraph'
import type { AgentStore, MobileAgent } from './pathingSystem'
import type { FireGrid } from '../world/fireGrid'
import { smokeMovementMultiplier } from '../world/fireGrid'

export interface InmateAgentStoreOptions {
  readonly inmates: InmateRegistry
  readonly escorts: EscortJobQueue
  readonly tileWorldUnits: number
  readonly inmateSpeed: number
  /** When present, smoke on the agent's tile scales movement speed (T4.8). */
  readonly fire?: FireGrid
  readonly data?: GameData
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
  readonly #fire: FireGrid | undefined
  readonly #data: GameData | undefined
  /** Scratch list rebuilt each `all()` — pathing iterates once per tick. */
  readonly #scratch: MobileAgent[] = []

  constructor(options: InmateAgentStoreOptions) {
    this.#inmates = options.inmates
    this.#escorts = options.escorts
    this.#tileWorldUnits = options.tileWorldUnits
    this.#inmateSpeed = options.inmateSpeed
    this.#fire = options.fire
    this.#data = options.data
  }

  get size(): number {
    return this.all().length
  }

  all(): readonly MobileAgent[] {
    this.#scratch.length = 0
    for (const entity of this.#inmates.all()) {
      if (isInmateEscorted(this.#escorts, entity.id)) continue
      syncInmateMotion(entity, this.motionSpeed(entity))
      this.#scratch.push(entity)
    }
    return this.#scratch
  }

  get(id: number): MobileAgent | undefined {
    const entity = this.#inmates.get(id)
    if (entity === undefined) return undefined
    if (isInmateEscorted(this.#escorts, id)) return undefined
    syncInmateMotion(entity, this.motionSpeed(entity))
    return entity
  }

  setGoal(agentId: number, goalTile: number): void {
    const entity = this.#inmates.get(agentId)
    if (entity === undefined) return
    syncInmateMotion(entity, this.motionSpeed(entity))
    entity.goalTile = goalTile
    entity.path = null
    entity.pathIndex = 0
    entity.awaitingPath = false
  }

  motionSpeed(entity: InmateEntity): number {
    if (this.#fire === undefined || this.#data === undefined) return this.#inmateSpeed
    const tileIndex = entity.ty * this.#fire.size + entity.tx
    return this.#inmateSpeed * smokeMovementMultiplier(this.#fire, tileIndex, this.#data)
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
