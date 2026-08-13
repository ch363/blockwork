/**
 * Live Phase 5 panel summaries: Directorate, Programs, Intelligence.
 *
 * Built on the worker from authoritative `InmateWorld` state so the main
 * thread never walks registries. Shapes match `@blockwork/ui` panel models.
 * Selection (`selectedId`) is left null here — the session overlays it.
 */

import {
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  administratorStatus,
  blowChance,
  checkRecruit,
  checkStartResearch,
  contrabandByRoom,
  contrabandMarket,
  describeBlocker,
  hasFeature,
  missingPrerequisites,
  type DirectorateNode,
  type GameData,
  type InmateWorld,
  type ProgramBlocker,
  type ReadonlyClock,
} from '@blockwork/sim'
import type {
  DirectorateBlocker,
  DirectorateBranchId,
  DirectorateModel,
  DirectorateNodeModel,
  DirectorateNodeStatus,
  IntelligenceModel,
  ProgramBlockerModel,
  ProgramRowModel,
  ProgramsModel,
} from '@blockwork/ui'

const BRANCH_X: Readonly<Record<DirectorateBranchId, number>> = {
  root: 16,
  security: 240,
  legal: 464,
  works: 688,
  finance: 912,
}

const NODE_ROW = 78

export interface DepthHud {
  readonly directorate: DirectorateModel
  readonly programs: ProgramsModel
  readonly intelligence: IntelligenceModel
}

export function buildDepthHud(
  world: InmateWorld,
  data: GameData,
  clock: ReadonlyClock,
  inspectedInmateId: number | null,
): DepthHud {
  return {
    directorate: buildDirectorateModel(world, data, clock),
    programs: buildProgramsModel(world, data, clock),
    intelligence: buildIntelligenceModel(world, data, inspectedInmateId),
  }
}

/* -------------------------------------------------------------------------- */
/* Directorate                                                                 */
/* -------------------------------------------------------------------------- */

function buildDirectorateModel(
  world: InmateWorld,
  data: GameData,
  clock: ReadonlyClock,
): DirectorateModel {
  const positions = layoutNodes(data.directorate.all)
  const nodes: DirectorateNodeModel[] = []

  for (const node of data.directorate.all) {
    const pos = positions.get(node.id) ?? { x: 16, y: 16 }
    nodes.push(nodeModel(world, data, clock, node, pos.x, pos.y))
  }

  nodes.sort((a, b) => (a.id < b.id ? -1 : 1))

  return {
    nodes,
    completeCount: world.directorate.completed().length,
    totalCount: data.directorate.all.length,
    activeCount: world.directorate.active().length,
    balance: world.economy.balance,
    selectedId: null,
  }
}

function nodeModel(
  world: InmateWorld,
  data: GameData,
  _clock: ReadonlyClock,
  node: DirectorateNode,
  x: number,
  y: number,
): DirectorateNodeModel {
  const adminDef = data.staff.find(node.administrator)
  const adminName = adminDef?.name ?? node.administrator
  const pause = administratorStatus(world, data, node.administrator)
  const active = world.directorate.activeResearch(node.id)

  let status: DirectorateNodeStatus
  let progress = 0
  let remainingLabel: string | null = null
  let pausedReason: string | null = null
  const blockers: DirectorateBlocker[] = []

  if (world.directorate.isComplete(node.id)) {
    status = 'complete'
  } else if (active !== undefined) {
    status = 'active'
    const total = node.durationHours * TICKS_PER_HOUR
    progress = total > 0 ? Math.min(1, active.elapsedTicks / total) : 0
    const left = Math.max(0, total - active.elapsedTicks)
    remainingLabel = formatRemaining(left)
    if (active.pausedReason !== null) {
      pausedReason =
        active.pausedReason === 'no-administrator'
          ? `No ${adminName} is in post.`
          : `${adminName} has no functional office.`
    }
  } else {
    const check = checkStartResearch({
      data,
      state: world.directorate,
      world,
      nodeId: node.id,
      balance: world.economy.balance,
    })
    if (check.ok || check.reason === 'insufficient-funds') {
      status = 'available'
      if (check.reason === 'insufficient-funds') {
        blockers.push({
          kind: 'funds',
          sentence: `Needs $${node.cost.toLocaleString('en-GB')}; balance is $${world.economy.balance.toLocaleString('en-GB')}.`,
        })
      }
    } else {
      status = 'locked'
      for (const id of missingPrerequisites(world.directorate, node)) {
        const prereq = data.directorate.find(id)
        blockers.push({
          kind: 'prerequisite',
          sentence: `${prereq?.name ?? id} must complete first.`,
        })
      }
      if (check.reason === 'no-administrator') {
        blockers.push({ kind: 'administrator', sentence: `No ${adminName} is in post.` })
      } else if (check.reason === 'no-office') {
        blockers.push({
          kind: 'office',
          sentence: `${adminName} needs a functional office.`,
        })
      } else if (check.reason === 'branch-locked') {
        blockers.push({
          kind: 'branch',
          sentence: `The ${node.branch} branch is not open yet.`,
        })
      }
    }
  }

  return {
    id: node.id,
    name: node.name,
    branch: node.branch,
    status,
    cost: node.cost,
    durationHours: node.durationHours,
    x,
    y,
    prerequisites: node.prerequisites,
    progress,
    remainingLabel,
    pausedReason,
    summary: node.summary,
    why: node.why,
    unlocks: unlockLabels(data, node.id),
    administrator: adminName,
    administratorReady: pause === null,
    blockers,
  }
}

function unlockLabels(data: GameData, nodeId: string): string[] {
  const unlocks = data.unlocks.get(nodeId)
  if (unlocks === undefined) return []
  const labels: string[] = []

  for (const id of unlocks.features) {
    labels.push(featureLabel(id))
  }
  for (const id of unlocks.rooms) {
    labels.push(data.rooms.find(id)?.name ?? id)
  }
  for (const id of unlocks.staff) {
    labels.push(data.staff.find(id)?.name ?? id)
  }
  for (const id of unlocks.programs) {
    labels.push(data.programs.find(id)?.name ?? id)
  }
  for (const id of unlocks.objects) {
    labels.push(data.objects.find(id)?.name ?? id)
  }
  return labels
}

function featureLabel(id: string): string {
  return id
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatRemaining(ticks: number): string {
  const minutes = Math.ceil(ticks / TICKS_PER_MINUTE)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** Column-per-branch layout; rows ordered by prerequisite depth then id. */
function layoutNodes(nodes: readonly DirectorateNode[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depth = new Map<string, number>()

  const depthOf = (id: string, stack: Set<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0
    stack.add(id)
    const node = byId.get(id)
    let best = 0
    if (node !== undefined) {
      for (const prereq of node.prerequisites) {
        best = Math.max(best, depthOf(prereq, stack) + 1)
      }
    }
    stack.delete(id)
    depth.set(id, best)
    return best
  }

  for (const node of nodes) depthOf(node.id, new Set())

  const columns = new Map<DirectorateBranchId, DirectorateNode[]>()
  for (const node of nodes) {
    const list = columns.get(node.branch) ?? []
    list.push(node)
    columns.set(node.branch, list)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [branch, list] of columns) {
    list.sort((a, b) => {
      const da = depth.get(a.id) ?? 0
      const db = depth.get(b.id) ?? 0
      if (da !== db) return da - db
      return a.id < b.id ? -1 : 1
    })
    const x = BRANCH_X[branch] ?? 16
    list.forEach((node, index) => {
      positions.set(node.id, { x, y: 16 + index * NODE_ROW })
    })
  }
  return positions
}

/* -------------------------------------------------------------------------- */
/* Programs                                                                    */
/* -------------------------------------------------------------------------- */

function buildProgramsModel(
  world: InmateWorld,
  data: GameData,
  clock: ReadonlyClock,
): ProgramsModel {
  const rows: ProgramRowModel[] = data.programs.all.map((def) => {
    const blocker = describeBlocker(world, data, def)
    const schedule = world.programs.schedules.get(def.id)
    const session = world.programs.sessions.get(def.id)
    const categoryName =
      schedule === undefined
        ? ''
        : (data.securityCategories.find(schedule.categoryId)?.name ?? schedule.categoryId)

    return {
      id: def.id,
      name: def.name,
      roomName: data.rooms.find(def.roomId)?.name ?? def.roomId,
      tutorName: data.staff.find(def.tutorStaffId)?.name ?? def.tutorStaffId,
      hours: def.hours,
      seats: def.seats,
      sessionsRequired: def.sessionsRequired,
      costPerSession: def.costPerSession,
      attendance: def.attendance,
      enrolled: world.programs.enrolledIn(def.id).length,
      completed: world.programs.completedCount(def.id),
      slot:
        schedule === undefined
          ? null
          : {
              categoryName,
              startHour: schedule.startHour,
              hours: schedule.hours,
              pinned: schedule.pinned,
            },
      session:
        session === undefined
          ? null
          : {
              attending: session.attendees.size,
              hoursRemaining: Math.max(
                0,
                Math.ceil((session.endsAtTick - clock.tick) / TICKS_PER_HOUR),
              ),
            },
      blocker: blocker === undefined ? null : toBlockerModel(data, blocker),
    }
  })

  rows.sort((a, b) => (a.name < b.name ? -1 : 1))

  return {
    rows,
    selectedId: null,
    canPin: hasFeature(data, world.directorate, 'delegation'),
  }
}

function toBlockerModel(data: GameData, blocker: ProgramBlocker): ProgramBlockerModel {
  return {
    kind: blocker.kind,
    have: blocker.have,
    need: blocker.need,
    subjectName: subjectDisplayName(data, blocker),
  }
}

function subjectDisplayName(data: GameData, blocker: ProgramBlocker): string {
  const id = blocker.subject
  switch (blocker.kind) {
    case 'locked':
      return data.directorate.find(id)?.name ?? id
    case 'no_tutor':
      return data.staff.find(id)?.name ?? id
    case 'no_room':
    case 'room_not_functional':
      return data.rooms.find(id)?.name ?? id
    case 'not_enough_seats':
      return data.objects.find(id)?.name ?? id
    case 'no_contiguous_work_block':
      return data.securityCategories.find(id)?.name ?? id
    default:
      return id
  }
}

/* -------------------------------------------------------------------------- */
/* Intelligence                                                                */
/* -------------------------------------------------------------------------- */

function buildIntelligenceModel(
  world: InmateWorld,
  data: GameData,
  inspectedInmateId: number | null,
): IntelligenceModel {
  const balance = data.balance.intelligence
  const sources = contrabandByRoom(world).map((row) => ({
    roomId: row.roomId,
    roomName: data.rooms.find(row.roomDefId)?.name ?? row.roomDefId,
    revealed: row.revealedStashes,
    actual: row.actualStashes,
  }))

  const market = contrabandMarket(world, data).map((row) => ({
    itemId: row.itemId,
    itemName: data.contraband.find(row.itemId)?.name ?? row.itemId,
    price: row.price,
    supply: row.supply,
    demand: row.demand,
  }))

  const informants = [...world.intelligence.informants.values()]
    .sort((a, b) => a.inmateId - b.inmateId)
    .map((informant) => {
      const entity = world.inmates.get(informant.inmateId)
      return {
        inmateId: informant.inmateId,
        name: entity?.inmate.name ?? `Inmate ${String(informant.inmateId)}`,
        blown: informant.blown,
        revealCount: informant.revealCount,
        coverageRadius: balance.revealRadiusTiles,
        blowChance: blowChance(balance, informant),
        carelesslyHandled: informant.carelesslyHandled,
      }
    })

  const reputations: {
    inmateId: number
    inmateName: string
    reputationName: string
  }[] = []
  for (const entity of world.inmates.all()) {
    for (const entry of entity.inmate.reputations) {
      if (!entry.revealed) continue
      const def = data.reputations.find(entry.id)
      reputations.push({
        inmateId: entity.id,
        inmateName: entity.inmate.name,
        reputationName: def?.name ?? entry.id,
      })
    }
  }
  reputations.sort(
    (a, b) => a.inmateId - b.inmateId || (a.reputationName < b.reputationName ? -1 : 1),
  )

  let recruitCandidate: IntelligenceModel['recruitCandidate'] = null
  if (inspectedInmateId !== null) {
    const entity = world.inmates.get(inspectedInmateId)
    if (entity !== undefined) {
      const check = checkRecruit(world, data, entity)
      recruitCandidate = {
        inmateId: inspectedInmateId,
        name: entity.inmate.name,
        loyalty: check.loyalty,
        fear: check.fear,
        cost: balance.recruitCost,
        refusal: check.ok ? null : recruitRefusal(check.reason),
      }
    }
  }

  return {
    sources,
    market,
    informants,
    reputations,
    maxInformants: balance.maxInformants,
    recruitCandidate,
  }
}

function recruitRefusal(reason: string | undefined): string {
  switch (reason) {
    case 'already-informant':
      return 'Already an informant.'
    case 'too-loyal':
      return 'Too loyal to turn.'
    case 'not-afraid-enough':
      return 'Not afraid enough.'
    case 'roster-full':
      return 'Informant roster is full.'
    case 'insufficient-funds':
      return 'Not enough funds to recruit.'
    case 'feature-locked':
      return 'Intelligence is not researched yet.'
    case 'unknown-inmate':
      return 'Inmate not found.'
    default:
      return 'Cannot be recruited.'
  }
}
