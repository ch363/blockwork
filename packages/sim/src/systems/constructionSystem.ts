/**
 * `ConstructionSystem`: turns queued work into structure (PRD 4.4 slot 9).
 *
 * It runs every ten ticks — one in-game minute, per the PRD's period table —
 * and does one thing per site, in ascending tile order: check the bill of
 * materials, check for a worker, add the work they did, and finish the site if
 * that was enough.
 *
 * Two of those steps are honest stubs today, and both are stubs with a seam
 * rather than a shortcut:
 *
 *   - **Materials.** Real delivery is T3.4 (`supply` / `deliveries`). While
 *     `balance.construction.stubMaterialDelivery` is true the bill fills
 *     itself the first time a site is looked at — kept for isolated
 *     construction fixtures that have no dock. With the stub off, sites block
 *     on `materials` until logistics delivers.
 *   - **Workers.** The workforce is an interface the system asks rather than a
 *     scan of the entity store. When no override is supplied and the world is
 *     an `InmateWorld`, claimed `build` jobs with staff on the tile supply the
 *     count. Tests and isolated fixtures pass `uniformWorkforce(n)` instead.
 *
 * A blocked site emits a `CausalEvent` when the reason it is blocked
 * *changes*, not on every update. A prison with two hundred stalled sites
 * would otherwise emit two hundred events a minute forever, and the Trace
 * panel would be useless precisely when it matters.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext, World } from '../core/simulation'
import type { GameData } from '../data/loader'
import { ConstructionWorld, completeSite, deliverAll, isDelivered } from '../world/construction'
import type { ConstructionBlocker, ConstructionDeps, ConstructionSite } from '../world/construction'
import { firstOrderGraceActive, syncFirstOrderGrace } from '../world/opening'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { completeJob, postJob } from './jobSystem'

/**
 * Who is available to build, asked per tile.
 *
 * T3.2's job assignment supplies the real implementation via
 * {@link createJobWorkforce}. Keeping it an interface means the construction
 * rules can be tested without an agent, and that the system never scans the
 * entity store itself unless wired to do so.
 */
export interface Workforce {
  /** Workers on the tile who are building it this update. */
  workersAt(tileIndex: number): number
}

/** The default: nobody builds anything. */
export const NO_WORKFORCE: Workforce = {
  workersAt(): number {
    return 0
  },
}

/** A workforce that reports the same headcount everywhere, for tests and tools. */
export function uniformWorkforce(workers: number): Workforce {
  return {
    workersAt(): number {
      return workers
    },
  }
}

/**
 * Counts staff who have claimed a `build` job at `tileIndex` and are standing
 * on that tile. Exported for tests that set up jobs manually.
 */
export function countBuildWorkersAt(world: InmateWorld, tileIndex: number): number {
  let count = 0
  for (const job of world.jobs.claimed()) {
    if (job.kind !== 'build') continue
    if (job.location !== tileIndex) continue
    if (job.claimantKind !== 'staff') continue
    const staff = world.staff.get(job.claimedBy)
    if (staff === undefined) continue
    if (world.grid.idx(staff.tx, staff.ty) === tileIndex) count += 1
  }
  return count
}

/** Live-game workforce: one claimed builder on site counts as one worker-tick. */
export function createJobWorkforce(world: InmateWorld): Workforce {
  return {
    workersAt(tileIndex: number): number {
      return countBuildWorkersAt(world, tileIndex)
    },
  }
}

export interface ConstructionSystemOptions {
  readonly data: GameData
  readonly workforce?: Workforce
}

export const CONSTRUCTION_SYSTEM_NAME = 'construction'

/** PRD 4.4: construction is one of the ten-tick systems. */
export const CONSTRUCTION_SYSTEM_PERIOD = TICKS_PER_MINUTE

function setBlocked(
  deps: ConstructionDeps,
  site: ConstructionSite,
  reason: ConstructionBlocker,
): void {
  if (site.blockedBy === reason) return
  site.blockedBy = reason
  if (reason === 'none') return

  deps.events.emit({
    tick: deps.tick,
    kind: 'construction.blocked',
    causeIds: [site.id],
    data: { tileIndex: site.tileIndex, job: site.job.kind, reason },
  })
}

function resolveWorkforce(options: ConstructionSystemOptions, world: World): Workforce {
  if (options.workforce !== undefined) return options.workforce
  if (isInmateWorld(world)) return createJobWorkforce(world)
  return NO_WORKFORCE
}

function hasActiveBuildJob(world: InmateWorld, tileIndex: number): boolean {
  for (const job of world.jobs.all()) {
    if (job.kind !== 'build') continue
    if (job.location !== tileIndex) continue
    if (job.state === 'open' || job.state === 'claimed') return true
  }
  return false
}

/** Keeps one open `build` job per pending site and drops jobs for removed tiles. */
function syncBuildJobs(deps: ConstructionDeps, world: InmateWorld): void {
  const { data, events, tick } = deps
  const priority = data.balance.jobs.supply.carryPriorityStoreToSite
  const liveTiles = new Set<number>()

  for (const site of world.sites.all()) {
    liveTiles.add(site.tileIndex)
    if (hasActiveBuildJob(world, site.tileIndex)) continue
    postJob({
      world,
      kind: 'build',
      priority,
      location: site.tileIndex,
      tick,
      events,
    })
  }

  for (const job of world.jobs.all()) {
    if (job.kind !== 'build') continue
    if (liveTiles.has(job.location)) continue
    if (job.state === 'completed' || job.state === 'cancelled') continue
    world.jobs.cancel(job.id)
  }
}

function finishBuildJob(world: InmateWorld, tileIndex: number, context: SystemContext): void {
  for (const job of world.jobs.all()) {
    if (job.kind !== 'build') continue
    if (job.location !== tileIndex) continue
    if (job.state !== 'claimed') continue
    completeJob(world, job.id, context.events, context.clock.tick)
  }
}

export function createConstructionSystem(options: ConstructionSystemOptions): System {
  const { data } = options
  const stubDelivery = data.balance.construction.stubMaterialDelivery
  let reportedWrongWorld = false

  return {
    name: CONSTRUCTION_SYSTEM_NAME,
    period: CONSTRUCTION_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick
      const workforce = resolveWorkforce(options, world)

      if (!(world instanceof ConstructionWorld)) {
        // Once, not once a minute: the wiring is either right or it is not.
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'construction.rejected',
          causeIds: [],
          data: { command: CONSTRUCTION_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      if (isInmateWorld(world)) {
        syncBuildJobs({ world, data, events: context.events, tick }, world)
        syncFirstOrderGrace(world)
      }

      const deps: ConstructionDeps = { world, data, events: context.events, tick }
      // Isolated construction fixtures are a ConstructionWorld, not an
      // InmateWorld. Stub delivery still has to fill the bill there, or every
      // T1.2 test stalls on materials. First-order grace is the live-game
      // equivalent and only exists on InmateWorld.
      const grace =
        stubDelivery || (isInmateWorld(world) && firstOrderGraceActive(world))

      for (const site of world.sites.all()) {
        if (!isDelivered(site)) {
          if (!grace) {
            setBlocked(deps, site, 'materials')
            continue
          }
          deliverAll(site)
        }

        const workers = workforce.workersAt(site.tileIndex)
        if (workers <= 0) {
          setBlocked(deps, site, 'worker')
          continue
        }

        setBlocked(deps, site, 'none')
        site.workTicksDone += workers * CONSTRUCTION_SYSTEM_PERIOD

        if (site.workTicksDone >= site.workTicksRequired) {
          completeSite(deps, site)
          if (isInmateWorld(world)) {
            finishBuildJob(world, site.tileIndex, context)
          }
        }
      }
    },
  }
}
