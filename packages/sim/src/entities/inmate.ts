/**
 * Inmates: generation, registry and housing assignment (T2.4, PRD 5.5).
 *
 * An inmate is the second entity kind after objects. Generation is pure over a
 * seeded RNG stream and content tables — no world reads — so distribution tests
 * can roll tens of thousands without a map. Arrival and cell assignment live in
 * `intakeSystem.ts`; this module owns the entity shape, the rolls, and the
 * occupancy index rooms ask through `RoomContents.occupants`.
 *
 * **Category sector matching is stubbed until T4.1.** With no sectors painted,
 * every functional cell matches every category. Entitlement matching is likewise
 * deferred to T5.2's grading pass: on arrival any free functional `cell` is
 * eligible (starting entitlement is still recorded on the inmate).
 */

import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { GameData } from '../data/loader'
import type { ConvictionDef, RiskTier, StatusEffectId } from '../data/schemas'
import { inmateAccessMask } from '../pathfinding/regionGraph'
import type { RoomContents } from '../world/rooms'
import { NO_ROOM } from '../world/rooms'
import type { ObjectRegistry } from './objects'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `cellId` 0 and missing registry lookups mean "unassigned". */
export const NO_INMATE = 0

/** Soft ceiling so ids stay JSON- and snapshot-friendly. */
export const MAX_INMATE_ID = 0xffff_ffff

export const ADDICTION_SUBSTANCES = ['narcotics', 'alcohol'] as const
export type AddictionSubstance = (typeof ADDICTION_SUBSTANCES)[number]

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

/** One rolled conviction on an inmate (id plus the sentence years drawn). */
export interface InmateConviction {
  readonly id: string
  readonly years: number
}

export interface InmateReputation {
  readonly id: string
  /** Revealed by intelligence (T4.4). Starts hidden. */
  readonly revealed: boolean
}

export interface InmateAddiction {
  readonly substance: AddictionSubstance
  /** 0..1. Gates the narcotics / alcohol needs (T2.5). */
  readonly strength: number
}

export interface InmateGrades {
  readonly punishment: number
  readonly reform: number
  readonly security: number
  readonly health: number
}

/**
 * Everything specific to being an inmate, per PRD 5.5.
 *
 * Position (`x`/`y`/`tx`/`ty`) lives on the entity shell so pathing can share
 * the same fields as staff later without reading this component.
 */
export interface InmateComponent {
  readonly name: string
  readonly portraitSeed: number
  readonly category: string
  readonly convictions: readonly InmateConviction[]
  readonly sentenceHours: number
  servedHours: number
  readonly traits: readonly string[]
  readonly reputations: readonly InmateReputation[]
  /** Indexed by `GameData.needs` file order (T2.5). */
  readonly needs: Float32Array
  readonly addictions: readonly InmateAddiction[]
  suppression: number
  entitlement: number
  /** Assigned housing room id, or `NO_ROOM` while in the intake hall. */
  cellId: number
  jobId: string | null
  programEnrolment: null
  readonly misconductLog: readonly never[]
  readonly grades: InmateGrades
  reoffendChance: number
  /** Mutable: needs / combat / programs append status effects. */
  status: StatusEffectId[]
  health: number
  readonly inventory: readonly string[]
  money: number
  /** Program learning multiplier, rolled at spawn (PRD 5.9). */
  readonly aptitude: number
}

/**
 * An inmate shell doubles as a `MobileAgent` so pathing / movement can move
 * the same object the registries and UI already hold (T2.3 + T2.4).
 */
export interface InmateEntity {
  readonly id: number
  readonly kind: 'inmate'
  /** Always `'inmate'` — satisfies `MobileAgent.category`. */
  readonly category: 'inmate'
  x: number
  y: number
  tx: number
  ty: number
  accessMask: number
  speed: number
  dx: number
  dy: number
  goalTile: number
  path: number[] | null
  pathIndex: number
  awaitingPath: boolean
  ticksSinceTileChange: number
  readonly inmate: InmateComponent
}

export interface CreateInmateShellOptions {
  readonly id: number
  readonly data: GameData
  readonly inmate: InmateComponent
  readonly tx: number
  readonly ty: number
  readonly x?: number
  readonly y?: number
}

/** Builds a pathing-ready inmate shell at a tile (or explicit world position). */
export function createInmateShell(options: CreateInmateShellOptions): InmateEntity {
  const units = options.data.balance.map.tileWorldUnits
  const speed = options.data.balance.pathfinding.speedsWorldUnitsPerTick.inmate
  return {
    id: options.id,
    kind: 'inmate',
    category: 'inmate',
    // Generic inmate bit plus this inmate's own security-category bit, so a
    // sector restricted to other categories refuses them (T4.1).
    accessMask: inmateAccessMask(options.data, options.inmate.category),
    x: options.x ?? (options.tx + 0.5) * units,
    y: options.y ?? (options.ty + 0.5) * units,
    tx: options.tx,
    ty: options.ty,
    speed,
    dx: 0,
    dy: 0,
    goalTile: -1,
    path: null,
    pathIndex: 0,
    awaitingPath: false,
    ticksSinceTileChange: 0,
    inmate: options.inmate,
  }
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

export interface GenerateInmateOptions {
  readonly data: GameData
  readonly rng: RngStream
  /**
   * When set, skips the category weight roll. Manual intake and tests pass
   * this; continuous intake leaves it undefined.
   */
  readonly category?: string
}

/**
 * Rolls a fresh inmate identity. Does not allocate an entity id or place them
 * in the world — callers that arrive on a bus do that after generation.
 */
export function generateInmate(options: GenerateInmateOptions): InmateComponent {
  const { data, rng } = options
  const categoryId = options.category ?? pickArrivalCategory(data, rng)
  const category = data.securityCategories.get(categoryId)

  const pool = convictionsForTier(data, category.riskTier)
  if (pool.length === 0) {
    throw new Error(`no convictions defined for risk tier '${category.riskTier}'`)
  }

  const countBounds = data.balance.intake.convictionCount
  const convictionCount = rng.nextInt(countBounds.min, countBounds.max + 1)
  const convictions = rollConvictions(pool, convictionCount, rng)

  const traits = deriveTraits(data, convictions, category.allowsDangerousTraits)
  const reputations = rollReputations(data, category.reputationChanceScale, rng)
  const aptitude = rollAptitude(data, rng)
  const addictions = rollAddictions(data, traits, rng)
  const name = rollName(data, rng)
  const portraitSeed = rng.nextUint32()

  const hoursPerYear = data.balance.time.hoursPerSentenceYear
  const sentenceHours = convictions.reduce((sum, entry) => sum + entry.years * hoursPerYear, 0)

  return {
    name,
    portraitSeed,
    category: categoryId,
    convictions,
    sentenceHours,
    servedHours: 0,
    traits,
    reputations,
    needs: new Float32Array(data.needs.size),
    addictions,
    suppression: 0,
    entitlement: data.balance.entitlement.start,
    cellId: NO_ROOM,
    jobId: null,
    programEnrolment: null,
    misconductLog: [],
    grades: { punishment: 0, reform: 0, security: 0, health: 100 },
    reoffendChance: initialReoffendChance(data, addictions),
    status: [],
    health: 100,
    inventory: [],
    money: 0,
    aptitude,
  }
}

/** Categories that can arrive on a bus (not manual-designation-only). */
export function arrivalCategories(data: GameData): readonly string[] {
  return data.securityCategories.all
    .filter((category) => !category.manualDesignationOnly)
    .map((category) => category.id)
}

/**
 * Weighted category roll for continuous intake. Exported so the bus planner and
 * `generateInmate` share one stream contract.
 */
export function pickArrivalCategory(data: GameData, rng: RngStream): string {
  const ids = arrivalCategories(data)
  if (ids.length === 0) {
    throw new Error('no security categories are eligible for intake')
  }

  const weights = data.balance.intake.categoryWeights
  let total = 0
  const weighted: { id: string; weight: number }[] = []
  for (const id of ids) {
    const weight = weights[id] ?? 0
    if (weight <= 0) continue
    weighted.push({ id, weight })
    total += weight
  }

  if (total <= 0 || weighted.length === 0) {
    const fallback = ids[rng.nextInt(0, ids.length)]
    if (fallback === undefined) {
      throw new Error('no security categories are eligible for intake')
    }
    return fallback
  }

  let cursor = rng.next() * total
  for (const entry of weighted) {
    cursor -= entry.weight
    if (cursor < 0) return entry.id
  }
  const last = weighted[weighted.length - 1]
  if (last === undefined) {
    throw new Error('no security categories are eligible for intake')
  }
  return last.id
}

export function convictionsForTier(data: GameData, tier: RiskTier): readonly ConvictionDef[] {
  return data.convictions.all.filter((conviction) => conviction.riskTier === tier)
}

function rollConvictions(
  pool: readonly ConvictionDef[],
  count: number,
  rng: RngStream,
): InmateConviction[] {
  const take = Math.min(count, pool.length)
  const remaining = [...pool]
  const picked: InmateConviction[] = []

  for (let i = 0; i < take; i += 1) {
    const index = rng.nextInt(0, remaining.length)
    const def = remaining.splice(index, 1)[0]
    if (def === undefined) break
    const years = rng.nextInt(def.minYears, def.maxYears + 1)
    picked.push({ id: def.id, years })
  }

  return picked
}

function deriveTraits(
  data: GameData,
  convictions: readonly InmateConviction[],
  allowsDangerous: boolean,
): string[] {
  const traits = new Set<string>()
  for (const conviction of convictions) {
    const def = data.convictions.get(conviction.id)
    for (const traitId of def.grantsTraits) {
      const trait = data.traits.find(traitId)
      if (trait === undefined) continue
      if (!allowsDangerous && trait.dangerous) continue
      traits.add(traitId)
    }
  }
  return [...traits].sort()
}

function rollReputations(
  data: GameData,
  chanceScale: number,
  rng: RngStream,
): InmateReputation[] {
  const rolled: InmateReputation[] = []
  for (const reputation of data.reputations.all) {
    const chance = Math.min(1, reputation.baseChance * chanceScale)
    // Always consume one draw so balance edits cannot shift the stream.
    if (rng.chance(chance)) {
      rolled.push({ id: reputation.id, revealed: false })
    }
  }
  return rolled
}

function rollAptitude(data: GameData, rng: RngStream): number {
  const { min, max } = data.balance.programs.aptitude
  return min + rng.next() * (max - min)
}

function rollAddictions(
  data: GameData,
  traits: readonly string[],
  rng: RngStream,
): InmateAddiction[] {
  if (!traits.includes('dependent')) return []

  const { chanceWhenDependent, strengthMin, strengthMax } = data.balance.intake.addiction
  const addictions: InmateAddiction[] = []
  for (const substance of ADDICTION_SUBSTANCES) {
    if (!rng.chance(chanceWhenDependent)) continue
    const strength = strengthMin + rng.next() * (strengthMax - strengthMin)
    addictions.push({ substance, strength })
  }
  return addictions
}

function rollName(data: GameData, rng: RngStream): string {
  const { given, family } = data.inmateNames
  const first = given[rng.nextInt(0, given.length)]
  const last = family[rng.nextInt(0, family.length)]
  // Pools are schema-nonempty; indexes are in range.
  return `${first ?? 'Inmate'} ${last ?? 'Unknown'}`
}

function initialReoffendChance(data: GameData, addictions: readonly InmateAddiction[]): number {
  const { base, activeAddiction, min, max } = data.balance.reoffend
  let chance = base
  if (addictions.length > 0) chance += activeAddiction
  return Math.min(max, Math.max(min, chance))
}

/**
 * Expected trait rates for a fixed category under the generation rules, used by
 * the distribution acceptance test. Assumes uniform without-replacement draws
 * of K∈[min,max] convictions from the category's risk-tier pool.
 */
export function expectedTraitRates(data: GameData, categoryId: string): Map<string, number> {
  const category = data.securityCategories.get(categoryId)
  const pool = convictionsForTier(data, category.riskTier)
  const { min, max } = data.balance.intake.convictionCount
  const rates = new Map<string, number>()

  for (const trait of data.traits.all) {
    if (!category.allowsDangerousTraits && trait.dangerous) {
      rates.set(trait.id, 0)
      continue
    }

    let total = 0
    let weightSum = 0
    for (let k = min; k <= max; k += 1) {
      const take = Math.min(k, pool.length)
      weightSum += 1
      // P(trait absent) over uniform without-replacement samples of size `take`.
      const granting = pool.filter((c) => c.grantsTraits.includes(trait.id)).length
      const absent = hypergeometricAbsent(pool.length, granting, take)
      total += 1 - absent
    }
    rates.set(trait.id, weightSum === 0 ? 0 : total / weightSum)
  }

  return rates
}

/** P(drawing zero successes) in a without-replacement sample of size k. */
function hypergeometricAbsent(population: number, successes: number, draw: number): number {
  if (draw <= 0) return 1
  if (successes <= 0) return 1
  if (draw > population) return 0
  const failures = population - successes
  if (draw > failures) return 0

  let p = 1
  for (let i = 0; i < draw; i += 1) {
    p *= (failures - i) / (population - i)
  }
  return p
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every living inmate, with room occupancy for `RoomContents`.
 *
 * Iteration is ascending id order so two runs that accepted the same arrivals
 * in a different wall-clock order still hash the same.
 */
export class InmateRegistry {
  readonly #inmates = new Map<number, InmateEntity>()
  readonly #byRoom = new Map<number, Set<number>>()
  #nextId = 1

  get size(): number {
    return this.#inmates.size
  }

  get nextId(): number {
    return this.#nextId
  }

  get(entityId: number): InmateEntity | undefined {
    return this.#inmates.get(entityId)
  }

  all(): InmateEntity[] {
    const entities = [...this.#inmates.values()]
    entities.sort((a, b) => a.id - b.id)
    return entities
  }

  /** Heads currently assigned to a housing / holding / intake room. */
  occupantsInRoom(roomId: number): number {
    return this.#byRoom.get(roomId)?.size ?? 0
  }

  allocateId(): number {
    if (this.#nextId > MAX_INMATE_ID) return NO_INMATE
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  add(entity: InmateEntity): void {
    this.#inmates.set(entity.id, entity)
    this.#enterRoom(entity)
  }

  remove(entityId: number): InmateEntity | undefined {
    const entity = this.#inmates.get(entityId)
    if (entity === undefined) return undefined
    this.#leaveRoom(entity)
    this.#inmates.delete(entityId)
    return entity
  }

  /**
   * Moves an inmate into a housing room (or `NO_ROOM` for the intake hall).
   * Updates the occupancy index used by room requirement scaling.
   */
  assignHousing(entityId: number, roomId: number): void {
    const entity = this.#inmates.get(entityId)
    if (entity === undefined) return
    this.#leaveRoom(entity)
    entity.inmate.cellId = roomId
    this.#enterRoom(entity)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#inmates.size)
    for (const entity of this.all()) {
      hasher.writeUint32(entity.id)
      hasher.writeString(entity.inmate.name)
      hasher.writeUint32(entity.inmate.portraitSeed)
      hasher.writeString(entity.inmate.category)
      hasher.writeUint32(entity.inmate.convictions.length)
      for (const conviction of entity.inmate.convictions) {
        hasher.writeString(conviction.id)
        hasher.writeUint32(conviction.years)
      }
      hasher.writeUint32(entity.inmate.sentenceHours)
      hasher.writeUint32(entity.inmate.servedHours)
      hasher.writeUint32(entity.inmate.traits.length)
      for (const trait of entity.inmate.traits) hasher.writeString(trait)
      hasher.writeUint32(entity.inmate.reputations.length)
      for (const reputation of entity.inmate.reputations) {
        hasher.writeString(reputation.id)
        hasher.writeUint32(reputation.revealed ? 1 : 0)
      }
      hasher.writeUint32(entity.inmate.needs.length)
      for (let i = 0; i < entity.inmate.needs.length; i += 1) {
        hasher.writeFloat64(entity.inmate.needs[i] ?? 0)
      }
      hasher.writeUint32(entity.inmate.addictions.length)
      for (const addiction of entity.inmate.addictions) {
        hasher.writeString(addiction.substance)
        hasher.writeFloat64(addiction.strength)
      }
      hasher.writeFloat64(entity.inmate.suppression)
      hasher.writeUint32(entity.inmate.entitlement)
      hasher.writeUint32(entity.inmate.cellId)
      hasher.writeFloat64(entity.inmate.aptitude)
      hasher.writeFloat64(entity.inmate.reoffendChance)
      hasher.writeFloat64(entity.inmate.health)
      hasher.writeUint32(entity.inmate.money)
      hasher.writeFloat64(entity.x)
      hasher.writeFloat64(entity.y)
      hasher.writeUint32(entity.tx)
      hasher.writeUint32(entity.ty)
    }
  }

  #enterRoom(entity: InmateEntity): void {
    const roomId = entity.inmate.cellId
    if (roomId === NO_ROOM) return
    let members = this.#byRoom.get(roomId)
    if (members === undefined) {
      members = new Set()
      this.#byRoom.set(roomId, members)
    }
    members.add(entity.id)
  }

  #leaveRoom(entity: InmateEntity): void {
    const roomId = entity.inmate.cellId
    if (roomId === NO_ROOM) return
    const members = this.#byRoom.get(roomId)
    if (members === undefined) return
    members.delete(entity.id)
    if (members.size === 0) this.#byRoom.delete(roomId)
  }
}

/* -------------------------------------------------------------------------- */
/* Room contents + world                                                       */
/* -------------------------------------------------------------------------- */

/** Objects plus inmate heads — the answer `evaluateRoom` needs after T2.4. */
export function inmateRoomContents(
  objects: ObjectRegistry,
  inmates: InmateRegistry,
): RoomContents {
  return {
    objectCount(roomId: number, objectId: string): number {
      return objects.objectCount(roomId, objectId)
    },
    occupants(roomId: number): number {
      return inmates.occupantsInRoom(roomId)
    },
  }
}

export type HousingKind = 'cell' | 'holding_pen' | 'intake_hall' | 'none'

export interface HousingAssignment {
  readonly kind: HousingKind
  /** Room id when housed; `NO_ROOM` when standing in the intake hall with none. */
  readonly roomId: number
}

/**
 * Cell → holding pen → intake hall (PRD / T2.4).
 *
 * A cell is free when it is functional and has no occupant. Holding pens accept
 * any number of overflow inmates. Sector and entitlement filters land with
 * T4.1 / T5.2; until then every functional cell is eligible.
 */
export function findHousing(
  rooms: {
    readonly all: () => Iterable<{
      readonly id: number
      readonly defId: string
    }>
    readonly statusOf: (roomId: number) => { readonly functional: boolean } | undefined
  },
  inmates: InmateRegistry,
  _category: string,
  _entitlement: number,
): HousingAssignment {
  let holdingPen: number | undefined
  let intakeHall: number | undefined

  for (const room of rooms.all()) {
    const status = rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue

    if (room.defId === 'cell' && inmates.occupantsInRoom(room.id) === 0) {
      return { kind: 'cell', roomId: room.id }
    }
    if (room.defId === 'holding_pen' && holdingPen === undefined) {
      holdingPen = room.id
    }
    if (room.defId === 'intake_hall' && intakeHall === undefined) {
      intakeHall = room.id
    }
  }

  if (holdingPen !== undefined) {
    return { kind: 'holding_pen', roomId: holdingPen }
  }
  if (intakeHall !== undefined) {
    return { kind: 'intake_hall', roomId: intakeHall }
  }
  return { kind: 'none', roomId: NO_ROOM }
}

/**
 * Permanent bed capacity: functional cells (1 each) plus bed objects in
 * functional dormitories. Holding pens and the intake hall are overflow, not
 * capacity, so continuous intake stops when beds are full.
 */
export function housingCapacity(
  rooms: {
    readonly all: () => Iterable<{
      readonly id: number
      readonly defId: string
    }>
    readonly statusOf: (roomId: number) => { readonly functional: boolean } | undefined
  },
  objects: ObjectRegistry,
): number {
  let capacity = 0
  for (const room of rooms.all()) {
    const status = rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue
    if (room.defId === 'cell') {
      capacity += 1
    } else if (room.defId === 'dormitory') {
      const beds = objects.objectCount(room.id, 'bed')
      const bunks = objects.objectCount(room.id, 'bunk_bed')
      capacity += beds + bunks * 2
    }
  }
  return capacity
}
