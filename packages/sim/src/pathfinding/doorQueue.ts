/**
 * Door queues (T2.3, PRD 4.5).
 *
 * A doorway with more than `doorQueueThreshold` agents waiting stops being a
 * free-for-all and becomes an ordered line. Agents join the tail and are
 * released one at a time when the door tile is clear. This prevents the scrum
 * that forms when dozens of movers all claim the same one-tile choke point.
 *
 * Threshold comes from `balance.pathfinding.doorQueueThreshold` (start at 2):
 * three or more waiters form a queue; once formed, the line drains in order
 * even if the live waiter count dips back to the threshold.
 */

export interface DoorQueueOptions {
  /** `balance.pathfinding.doorQueueThreshold`. */
  readonly doorQueueThreshold: number
}

/**
 * Per-door ordered lines of agent ids.
 *
 * The movement system asks `mayEnter` before letting an agent step onto a door
 * tile. Agents that must wait are enrolled with `enqueue`; the head is popped
 * with `release` once it has claimed the door.
 */
export class DoorQueueRegistry {
  readonly doorQueueThreshold: number

  /** Door tile index → ordered agent ids (head at index 0). */
  readonly #queues = new Map<number, number[]>()
  /** Agent id → door tile they are lined up for. */
  readonly #agentDoor = new Map<number, number>()

  constructor(options: DoorQueueOptions) {
    this.doorQueueThreshold = options.doorQueueThreshold
  }

  /** Number of agents currently lined up at a door (0 if none). */
  queueLength(doorTile: number): number {
    return this.#queues.get(doorTile)?.length ?? 0
  }

  /** Door tile this agent is queued for, or `-1`. */
  doorOf(agentId: number): number {
    return this.#agentDoor.get(agentId) ?? -1
  }

  isQueued(agentId: number): boolean {
    return this.#agentDoor.has(agentId)
  }

  /**
   * Whether `agentId` may step onto `doorTile` this tick.
   *
   * Free entry is allowed while fewer than `threshold + 1` agents want the
   * door and no line already exists. Once a queue exists (or would form), only
   * the head of the line may enter, and only when they are that head.
   *
   * `waitingCount` is the number of agents whose next desired tile is this
   * door, including `agentId`, before enrollment.
   */
  mayEnter(doorTile: number, agentId: number, waitingCount: number): boolean {
    const existing = this.#queues.get(doorTile)
    if (existing !== undefined && existing.length > 0) {
      return existing[0] === agentId
    }
    if (waitingCount > this.doorQueueThreshold) {
      return false
    }
    return true
  }

  /**
   * Ensures `agentId` is on the queue for `doorTile` (joins the tail if new).
   *
   * Moving an agent from another door's line is supported: they leave the old
   * line first so an agent is never in two queues.
   */
  enqueue(doorTile: number, agentId: number): void {
    const priorDoor = this.#agentDoor.get(agentId)
    if (priorDoor !== undefined && priorDoor !== doorTile) {
      this.#removeFrom(priorDoor, agentId)
    }
    if (this.#agentDoor.get(agentId) === doorTile) return

    let line = this.#queues.get(doorTile)
    if (line === undefined) {
      line = []
      this.#queues.set(doorTile, line)
    }
    line.push(agentId)
    this.#agentDoor.set(agentId, doorTile)
  }

  /**
   * Removes the head of the queue when it matches `agentId` (they entered).
   *
   * Safe to call when the agent was never queued — it is a no-op then.
   */
  release(doorTile: number, agentId: number): void {
    const line = this.#queues.get(doorTile)
    if (line === undefined || line.length === 0) {
      this.#agentDoor.delete(agentId)
      return
    }
    if (line[0] !== agentId) return
    line.shift()
    this.#agentDoor.delete(agentId)
    if (line.length === 0) this.#queues.delete(doorTile)
  }

  /** Drops an agent from whatever line they are in (goal change, despawn). */
  leave(agentId: number): void {
    const door = this.#agentDoor.get(agentId)
    if (door === undefined) return
    this.#removeFrom(door, agentId)
  }

  /** Clears every line. Used by tests. */
  clear(): void {
    this.#queues.clear()
    this.#agentDoor.clear()
  }

  #removeFrom(doorTile: number, agentId: number): void {
    const line = this.#queues.get(doorTile)
    if (line === undefined) {
      this.#agentDoor.delete(agentId)
      return
    }
    const index = line.indexOf(agentId)
    if (index >= 0) line.splice(index, 1)
    this.#agentDoor.delete(agentId)
    if (line.length === 0) this.#queues.delete(doorTile)
  }
}

/**
 * Count how many movers currently desire a given door tile as their next step.
 *
 * Used by the movement system to decide when a free doorway becomes a queue.
 */
export function countDoorWaiters(doorTile: number, desires: ReadonlyMap<number, number>): number {
  let count = 0
  for (const desired of desires.values()) {
    if (desired === doorTile) count += 1
  }
  return count
}
