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
 *     scan of the entity store. The default answers zero, so a simulation
 *     wired up without one builds nothing and says why.
 *
 * A blocked site emits a `CausalEvent` when the reason it is blocked
 * *changes*, not on every update. A prison with two hundred stalled sites
 * would otherwise emit two hundred events a minute forever, and the Trace
 * panel would be useless precisely when it matters.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { ConstructionWorld, completeSite, deliverAll, isDelivered } from '../world/construction'
import type { ConstructionBlocker, ConstructionDeps, ConstructionSite } from '../world/construction'

/**
 * Who is available to build, asked per tile.
 *
 * T2.3's job assignment supplies the real implementation. Keeping it an
 * interface means the construction rules can be tested without an agent, and
 * that the system never scans the entity store itself.
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

export function createConstructionSystem(options: ConstructionSystemOptions): System {
  const { data } = options
  const workforce = options.workforce ?? NO_WORKFORCE
  const stubDelivery = data.balance.construction.stubMaterialDelivery
  let reportedWrongWorld = false

  return {
    name: CONSTRUCTION_SYSTEM_NAME,
    period: CONSTRUCTION_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

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

      const deps: ConstructionDeps = { world, data, events: context.events, tick }

      for (const site of world.sites.all()) {
        if (!isDelivered(site)) {
          if (!stubDelivery) {
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
        }
      }
    },
  }
}
