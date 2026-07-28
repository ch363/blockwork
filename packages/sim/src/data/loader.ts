/**
 * Loads, validates and indexes the game content (PRD 7.3, CLAUDE.md rule 4).
 *
 * Validation happens in three passes and stops at the first pass that fails,
 * because a later pass cannot say anything useful about data an earlier one
 * rejected:
 *
 *   1. **Shape.** Every file against its Zod schema. Unknown keys are errors.
 *   2. **Identity.** Ids are unique within their registry and none collides
 *      with a reserved id.
 *   3. **Cross-reference.** Every id one definition names in another exists,
 *      and the relationships that must agree in both directions do.
 *
 * Passes 2 and 3 collect every issue before throwing, so a content edit that
 * breaks eleven references reports eleven paths rather than eleven runs. Each
 * issue names the file, the exact path within it, and both ends of the broken
 * reference.
 *
 * There is no file reading here. The simulation runs in a worker with no
 * filesystem, so the caller supplies already-parsed JSON; the default is the
 * real content bundled by `@blockwork/data`.
 */

import { RAW_GAME_DATA } from '@blockwork/data'

import { NO_MATERIAL_ID } from '../world/materials'

import { DOOR_TYPES, FILE_SCHEMAS, GAME_DATA_FILES } from './schemas'
import type {
  Balance,
  ContrabandDef,
  ContractDef,
  ContractPredicate,
  ConvictionDef,
  DirectorateNode,
  DoorDef,
  GameDataFileName,
  InmateNames,
  MaterialDef,
  NeedDef,
  ObjectDef,
  ProgramDef,
  RawGameDataFiles,
  ReputationDef,
  RoomDef,
  SecurityCategoryDef,
  StaffDef,
  SupplyDef,
  TraitDef,
} from './schemas'

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export interface GameDataIssue {
  /** The file the problem is in, with its `.json` suffix. */
  readonly file: string
  /** Path within that file, for example `rooms[3].requiredObjects[0].objectId`. */
  readonly path: string
  readonly message: string
}

/** Thrown by `loadGameData`. Never partially returns; content is all or nothing. */
export class GameDataError extends Error {
  readonly issues: readonly GameDataIssue[]

  constructor(stage: string, issues: readonly GameDataIssue[]) {
    super(formatIssues(stage, issues))
    this.name = 'GameDataError'
    this.issues = issues
  }
}

function formatIssues(stage: string, issues: readonly GameDataIssue[]): string {
  const lines = issues.map((issue) => `  ${issue.file} ${issue.path}: ${issue.message}`)
  const plural = issues.length === 1 ? 'issue' : 'issues'
  return `game data ${stage} failed with ${issues.length} ${plural}:\n${lines.join('\n')}`
}

/** `['rooms', 3, 'requiredObjects', 0]` becomes `rooms[3].requiredObjects[0]`. */
function joinPath(segments: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      out += out === '' ? String(segment) : `.${String(segment)}`
    }
  }
  return out === '' ? '<root>' : out
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

interface Identified {
  readonly id: string
}

/**
 * An ordered, immutable set of definitions keyed by id.
 *
 * Order is file order, and `indexOf` exposes it, because several systems store
 * a definition's index rather than its id in a typed array. `needs.json` is
 * the load-bearing case: reordering it changes every inmate's need layout, so
 * the ordering is part of the save contract (T2.5, PRD 7.4).
 */
export class Registry<T extends Identified> {
  readonly all: readonly T[]
  readonly #byId: ReadonlyMap<string, T>
  readonly #indexById: ReadonlyMap<string, number>

  constructor(defs: readonly T[]) {
    const byId = new Map<string, T>()
    const indexById = new Map<string, number>()
    defs.forEach((entry, index) => {
      byId.set(entry.id, entry)
      indexById.set(entry.id, index)
    })
    this.all = defs
    this.#byId = byId
    this.#indexById = indexById
  }

  get size(): number {
    return this.all.length
  }

  ids(): readonly string[] {
    return this.all.map((entry) => entry.id)
  }

  has(id: string): boolean {
    return this.#byId.has(id)
  }

  /** `undefined` rather than throwing, for validation and optional lookups. */
  find(id: string): T | undefined {
    return this.#byId.get(id)
  }

  /** Throws on an unknown id. Safe after load, since cross-references passed. */
  get(id: string): T {
    const found = this.#byId.get(id)
    if (found === undefined) {
      throw new Error(`unknown definition '${id}'`)
    }
    return found
  }

  /** Position in file order, or -1. */
  indexOf(id: string): number {
    return this.#indexById.get(id) ?? -1
  }
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/** What a Directorate node makes available, derived from `unlockedBy` back-references. */
export interface DirectorateUnlocks {
  readonly rooms: readonly string[]
  readonly objects: readonly string[]
  readonly staff: readonly string[]
  readonly programs: readonly string[]
  readonly materials: readonly string[]
  readonly doors: readonly string[]
  readonly securityCategories: readonly string[]
  readonly features: readonly string[]
}

export interface GameData {
  readonly balance: Balance
  readonly materials: Registry<MaterialDef>
  readonly doors: Registry<DoorDef>
  readonly supplies: Registry<SupplyDef>
  readonly needs: Registry<NeedDef>
  readonly rooms: Registry<RoomDef>
  readonly objects: Registry<ObjectDef>
  readonly staff: Registry<StaffDef>
  readonly directorate: Registry<DirectorateNode>
  readonly programs: Registry<ProgramDef>
  readonly contraband: Registry<ContrabandDef>
  readonly contracts: Registry<ContractDef>
  readonly securityCategories: Registry<SecurityCategoryDef>
  readonly traits: Registry<TraitDef>
  readonly reputations: Registry<ReputationDef>
  readonly convictions: Registry<ConvictionDef>
  /** Given / family name pools for inmate generation (T2.4). */
  readonly inmateNames: InmateNames
  /** Keyed by Directorate node id. Every node has an entry, possibly empty. */
  readonly unlocks: ReadonlyMap<string, DirectorateUnlocks>
}

/* -------------------------------------------------------------------------- */
/* Issue collection                                                            */
/* -------------------------------------------------------------------------- */

const FILE_OF = {
  balance: 'balance.json',
  materials: 'materials.json',
  needs: 'needs.json',
  rooms: 'rooms.json',
  objects: 'objects.json',
  staff: 'staff.json',
  directorate: 'directorate.json',
  programs: 'programs.json',
  contraband: 'contraband.json',
  contracts: 'contracts.json',
  inmates: 'inmates.json',
} as const satisfies Record<GameDataFileName, string>

class Issues {
  readonly list: GameDataIssue[] = []

  add(file: GameDataFileName, path: readonly PropertyKey[], message: string): void {
    this.list.push({ file: FILE_OF[file], path: joinPath(path), message })
  }

  /**
   * The workhorse. Reports a missing target naming the referring definition,
   * the field, the id that is missing and the file it should have been in.
   */
  ref(
    file: GameDataFileName,
    path: readonly PropertyKey[],
    subject: string,
    targetId: string,
    target: { readonly file: GameDataFileName; readonly has: (id: string) => boolean },
    kind: string,
  ): boolean {
    if (target.has(targetId)) return true
    this.add(
      file,
      path,
      `${subject} references ${kind} '${targetId}', which is not defined in ${FILE_OF[target.file]}`,
    )
    return false
  }

  get ok(): boolean {
    return this.list.length === 0
  }
}

/* -------------------------------------------------------------------------- */
/* Load                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Validates every definition file and returns indexed, cross-checked content.
 *
 * @param files raw parsed JSON keyed by file name. Defaults to the real files.
 * @throws {GameDataError} on any shape, identity or cross-reference problem.
 */
export function loadGameData(files: RawGameDataFiles = RAW_GAME_DATA): GameData {
  const parsed = parseFiles(files)

  const registries = buildRegistries(parsed)
  checkIdentity(parsed, registries)
  checkCrossReferences(parsed.balance, registries)

  return { ...registries, balance: parsed.balance, unlocks: deriveUnlocks(registries) }
}

/* -------------------------------------------------------------------------- */
/* Pass 1: shape                                                               */
/* -------------------------------------------------------------------------- */

interface ParsedFiles {
  readonly balance: Balance
  readonly materials: {
    readonly materials: MaterialDef[]
    readonly doors: DoorDef[]
    readonly supplies: SupplyDef[]
  }
  readonly needs: { readonly needs: NeedDef[] }
  readonly rooms: { readonly rooms: RoomDef[] }
  readonly objects: { readonly objects: ObjectDef[] }
  readonly staff: { readonly staff: StaffDef[] }
  readonly directorate: { readonly nodes: DirectorateNode[] }
  readonly programs: { readonly programs: ProgramDef[] }
  readonly contraband: { readonly items: ContrabandDef[] }
  readonly contracts: { readonly contracts: ContractDef[] }
  readonly inmates: {
    readonly securityCategories: SecurityCategoryDef[]
    readonly traits: TraitDef[]
    readonly reputations: ReputationDef[]
    readonly convictions: ConvictionDef[]
    readonly names: InmateNames
  }
}

function parseFiles(files: RawGameDataFiles): ParsedFiles {
  const issues = new Issues()
  const out: Record<string, unknown> = {}

  for (const fileName of GAME_DATA_FILES) {
    const raw = files[fileName]
    if (raw === undefined) {
      issues.add(fileName, [], 'file is missing from the supplied game data')
      continue
    }
    const result = FILE_SCHEMAS[fileName].safeParse(raw)
    if (result.success) {
      out[fileName] = result.data
    } else {
      for (const issue of result.error.issues) {
        issues.add(fileName, issue.path, issue.message)
      }
    }
  }

  if (!issues.ok) {
    throw new GameDataError('validation', issues.list)
  }

  // Safe: every file parsed successfully, so every key is populated with the
  // schema's output type.
  return out as unknown as ParsedFiles
}

/* -------------------------------------------------------------------------- */
/* Registries                                                                  */
/* -------------------------------------------------------------------------- */

type Registries = Omit<GameData, 'balance' | 'unlocks'>

function buildRegistries(parsed: ParsedFiles): Registries {
  return {
    materials: new Registry(parsed.materials.materials),
    doors: new Registry(parsed.materials.doors),
    supplies: new Registry(parsed.materials.supplies),
    needs: new Registry(parsed.needs.needs),
    rooms: new Registry(parsed.rooms.rooms),
    objects: new Registry(parsed.objects.objects),
    staff: new Registry(parsed.staff.staff),
    directorate: new Registry(parsed.directorate.nodes),
    programs: new Registry(parsed.programs.programs),
    contraband: new Registry(parsed.contraband.items),
    contracts: new Registry(parsed.contracts.contracts),
    securityCategories: new Registry(parsed.inmates.securityCategories),
    traits: new Registry(parsed.inmates.traits),
    reputations: new Registry(parsed.inmates.reputations),
    convictions: new Registry(parsed.inmates.convictions),
    inmateNames: parsed.inmates.names,
  }
}

/* -------------------------------------------------------------------------- */
/* Pass 2: identity                                                            */
/* -------------------------------------------------------------------------- */

function checkIdentity(parsed: ParsedFiles, registries: Registries): void {
  const issues = new Issues()

  const collections: Array<{
    readonly file: GameDataFileName
    readonly key: string
    readonly defs: readonly Identified[]
  }> = [
    { file: 'materials', key: 'materials', defs: parsed.materials.materials },
    { file: 'materials', key: 'doors', defs: parsed.materials.doors },
    { file: 'materials', key: 'supplies', defs: parsed.materials.supplies },
    { file: 'needs', key: 'needs', defs: parsed.needs.needs },
    { file: 'rooms', key: 'rooms', defs: parsed.rooms.rooms },
    { file: 'objects', key: 'objects', defs: parsed.objects.objects },
    { file: 'staff', key: 'staff', defs: parsed.staff.staff },
    { file: 'directorate', key: 'nodes', defs: parsed.directorate.nodes },
    { file: 'programs', key: 'programs', defs: parsed.programs.programs },
    { file: 'contraband', key: 'items', defs: parsed.contraband.items },
    { file: 'contracts', key: 'contracts', defs: parsed.contracts.contracts },
    { file: 'inmates', key: 'securityCategories', defs: parsed.inmates.securityCategories },
    { file: 'inmates', key: 'traits', defs: parsed.inmates.traits },
    { file: 'inmates', key: 'reputations', defs: parsed.inmates.reputations },
    { file: 'inmates', key: 'convictions', defs: parsed.inmates.convictions },
  ]

  for (const { file, key, defs } of collections) {
    const seen = new Map<string, number>()
    defs.forEach((entry, index) => {
      const first = seen.get(entry.id)
      if (first === undefined) {
        seen.set(entry.id, index)
      } else {
        issues.add(
          file,
          [key, index, 'id'],
          `duplicate id '${entry.id}', first defined at [${first}]`,
        )
      }
    })
  }

  // Slot 0 of the tile grid's material table is reserved (see world/materials).
  const reserved = registries.materials.indexOf(NO_MATERIAL_ID)
  if (reserved >= 0) {
    issues.add(
      'materials',
      ['materials', reserved, 'id'],
      `material id '${NO_MATERIAL_ID}' is reserved for the empty tile slot`,
    )
  }

  // The door types are structural (see DOOR_TYPES): construction offers every
  // one of them, so a missing definition is a build tool with a dead button.
  for (const type of DOOR_TYPES) {
    if (!registries.doors.has(type)) {
      issues.add('materials', ['doors'], `door type '${type}' has no definition`)
    }
  }

  // Materials and supplies are both carried and purchased, so an id shared
  // between them would make an order ambiguous.
  for (const supply of registries.supplies.all) {
    if (registries.materials.has(supply.id)) {
      issues.add(
        'materials',
        ['supplies', registries.supplies.indexOf(supply.id), 'id'],
        `supply id '${supply.id}' collides with a material of the same id`,
      )
    }
  }

  if (!issues.ok) {
    throw new GameDataError('identity check', issues.list)
  }
}

/* -------------------------------------------------------------------------- */
/* Pass 3: cross-references                                                    */
/* -------------------------------------------------------------------------- */

function checkCrossReferences(balance: Balance, r: Registries): void {
  const issues = new Issues()

  const materials = { file: 'materials' as const, has: (id: string) => r.materials.has(id) }
  const supplies = { file: 'materials' as const, has: (id: string) => r.supplies.has(id) }
  const needs = { file: 'needs' as const, has: (id: string) => r.needs.has(id) }
  const rooms = { file: 'rooms' as const, has: (id: string) => r.rooms.has(id) }
  const objects = { file: 'objects' as const, has: (id: string) => r.objects.has(id) }
  const staff = { file: 'staff' as const, has: (id: string) => r.staff.has(id) }
  const nodes = { file: 'directorate' as const, has: (id: string) => r.directorate.has(id) }
  const programs = { file: 'programs' as const, has: (id: string) => r.programs.has(id) }
  const contraband = { file: 'contraband' as const, has: (id: string) => r.contraband.has(id) }
  const traits = { file: 'inmates' as const, has: (id: string) => r.traits.has(id) }
  const categories = { file: 'inmates' as const, has: (id: string) => r.securityCategories.has(id) }

  const featureSet = new Set<string>(balance.features)
  const features = { file: 'balance' as const, has: (id: string) => featureSet.has(id) }

  checkBalance(issues, balance, featureSet, r, categories, materials)
  checkMaterials(issues, r, nodes)
  checkDoors(issues, r, { materials, supplies, nodes })
  checkNeeds(issues, r, traits)
  checkRooms(issues, r, { materials, supplies, needs, objects, nodes })
  checkObjects(issues, r, { needs, rooms, contraband, nodes })
  checkStaff(issues, r, { needs, rooms, objects, nodes })
  checkDirectorate(issues, r, { staff, nodes, features })
  checkPrograms(issues, r, { needs, rooms, objects, staff, programs, traits, nodes })
  checkContraband(issues, r, rooms)
  checkContracts(issues, r, { needs, rooms, objects, staff, programs, nodes })
  checkInmates(issues, r, { traits, nodes })

  if (!issues.ok) {
    throw new GameDataError('cross-reference check', issues.list)
  }
}

type Target = { readonly file: GameDataFileName; readonly has: (id: string) => boolean }

function checkBalance(
  issues: Issues,
  balance: Balance,
  featureSet: ReadonlySet<string>,
  r: Registries,
  categories: Target,
  materials: Target,
): void {
  if (featureSet.size !== balance.features.length) {
    issues.add('balance', ['features'], 'contains duplicate feature ids')
  }

  const foundationFloor = balance.construction.foundationFloorMaterial
  const foundationPath: PropertyKey[] = ['construction', 'foundationFloorMaterial']
  if (
    issues.ref(
      'balance',
      foundationPath,
      'construction.foundationFloorMaterial',
      foundationFloor,
      materials,
      'material',
    ) &&
    !r.materials.get(foundationFloor).surfaces.includes('floor')
  ) {
    issues.add(
      'balance',
      foundationPath,
      `foundations lay '${foundationFloor}', which is not a floor material`,
    )
  }

  const base = balance.misconduct.baseRatePer10MinutesByCategory
  for (const categoryId of Object.keys(base)) {
    issues.ref(
      'balance',
      ['misconduct', 'baseRatePer10MinutesByCategory', categoryId],
      'misconduct.baseRatePer10MinutesByCategory',
      categoryId,
      categories,
      'security category',
    )
  }
  for (const category of r.securityCategories.all) {
    if (base[category.id] === undefined) {
      issues.add(
        'balance',
        ['misconduct', 'baseRatePer10MinutesByCategory'],
        `security category '${category.id}' has no base misconduct rate`,
      )
    }
  }

  const weights = balance.intake.categoryWeights
  for (const categoryId of Object.keys(weights)) {
    issues.ref(
      'balance',
      ['intake', 'categoryWeights', categoryId],
      'intake.categoryWeights',
      categoryId,
      categories,
      'security category',
    )
  }

  const convictionCount = balance.intake.convictionCount
  if (convictionCount.min > convictionCount.max) {
    issues.add(
      'balance',
      ['intake', 'convictionCount', 'max'],
      `intake.convictionCount min ${convictionCount.min} is above max ${convictionCount.max}`,
    )
  }

  const addiction = balance.intake.addiction
  if (addiction.strengthMin > addiction.strengthMax) {
    issues.add(
      'balance',
      ['intake', 'addiction', 'strengthMax'],
      `intake.addiction strengthMin ${addiction.strengthMin} is above strengthMax ${addiction.strengthMax}`,
    )
  }

  const combat = balance.combat
  const contrabandTarget: Target = { file: 'contraband', has: (id) => r.contraband.has(id) }
  issues.ref(
    'balance',
    ['combat', 'defaultWeaponId'],
    'combat.defaultWeaponId',
    combat.defaultWeaponId,
    contrabandTarget,
    'contraband item',
  )
  issues.ref(
    'balance',
    ['combat', 'stun', 'weaponId'],
    'combat.stun.weaponId',
    combat.stun.weaponId,
    contrabandTarget,
    'contraband item',
  )
  for (const weaponId of Object.keys(combat.ranged.accuracyByWeapon)) {
    issues.ref(
      'balance',
      ['combat', 'ranged', 'accuracyByWeapon', weaponId],
      'combat.ranged.accuracyByWeapon',
      weaponId,
      contrabandTarget,
      'contraband item',
    )
  }

  
  const staffTargetEmergency: Target = { file: 'staff', has: (id) => r.staff.has(id) }
  issues.ref(
    'balance',
    ['emergency', 'riotSquadDefId'],
    'emergency.riotSquadDefId',
    balance.emergency.riotSquadDefId,
    staffTargetEmergency,
    'staff',
  )
  issues.ref(
    'balance',
    ['emergency', 'nationalGuardDefId'],
    'emergency.nationalGuardDefId',
    balance.emergency.nationalGuardDefId,
    staffTargetEmergency,
    'staff',
  )

  const kitchen = balance.kitchen
  if (kitchen.defaultMealVariety > kitchen.maxMealVariety) {
    issues.add(
      'balance',
      ['kitchen', 'defaultMealVariety'],
      `kitchen.defaultMealVariety ${kitchen.defaultMealVariety} is above maxMealVariety ${kitchen.maxMealVariety}`,
    )
  }
  if (kitchen.ingredientTypes.length < kitchen.maxMealVariety) {
    issues.add(
      'balance',
      ['kitchen', 'ingredientTypes'],
      `kitchen.ingredientTypes has ${kitchen.ingredientTypes.length} entries but maxMealVariety is ${kitchen.maxMealVariety}`,
    )
  }
  const suppliesTarget: Target = { file: 'materials', has: (id) => r.supplies.has(id) }
  kitchen.ingredientTypes.forEach((itemId, index) => {
    issues.ref(
      'balance',
      ['kitchen', 'ingredientTypes', index],
      'kitchen.ingredientTypes',
      itemId,
      suppliesTarget,
      'supply',
    )
  })

  const roomsTarget: Target = { file: 'rooms', has: (id) => r.rooms.has(id) }
  const needsTarget: Target = { file: 'needs', has: (id) => r.needs.has(id) }

  const sleepFrom = balance.routine.sleepForbiddenFromHour
  const sleepUntil = balance.routine.sleepForbiddenUntilHour
  if (sleepFrom >= sleepUntil) {
    issues.add(
      'balance',
      ['routine', 'sleepForbiddenUntilHour'],
      `routine sleep window start ${sleepFrom} must be before end ${sleepUntil}`,
    )
  }
  if (balance.routine.minSessionMinutes > balance.routine.maxSessionMinutes) {
    issues.add(
      'balance',
      ['routine', 'maxSessionMinutes'],
      `routine minSessionMinutes ${balance.routine.minSessionMinutes} is above maxSessionMinutes ${balance.routine.maxSessionMinutes}`,
    )
  }

  for (const [blockId, block] of Object.entries(balance.routine.blocks)) {
    block.permittedRooms.forEach((roomId, index) => {
      issues.ref(
        'balance',
        ['routine', 'blocks', blockId, 'permittedRooms', index],
        `routine block '${blockId}'`,
        roomId,
        roomsTarget,
        'room',
      )
    })
    if (block.preferredNeed !== null) {
      issues.ref(
        'balance',
        ['routine', 'blocks', blockId, 'preferredNeed'],
        `routine block '${blockId}'`,
        block.preferredNeed,
        needsTarget,
        'need',
      )
    }
  }

  for (const categoryId of Object.keys(balance.routine.defaults)) {
    issues.ref(
      'balance',
      ['routine', 'defaults', categoryId],
      'routine.defaults',
      categoryId,
      categories,
      'security category',
    )
  }
  for (const category of r.securityCategories.all) {
    if (balance.routine.defaults[category.id] === undefined) {
      issues.add(
        'balance',
        ['routine', 'defaults'],
        `security category '${category.id}' has no default routine`,
      )
    }
  }
}

function checkMaterials(issues: Issues, r: Registries, nodes: Target): void {
  r.materials.all.forEach((material, index) => {
    if (material.unlockedBy !== undefined) {
      issues.ref(
        'materials',
        ['materials', index, 'unlockedBy'],
        `material '${material.id}'`,
        material.unlockedBy,
        nodes,
        'Directorate node',
      )
    }
  })
}

function checkDoors(
  issues: Issues,
  r: Registries,
  t: { materials: Target; supplies: Target; nodes: Target },
): void {
  r.doors.all.forEach((door, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['doors', index, ...rest]
    const subject = `door '${door.id}'`

    door.materials.forEach((requirement, i) => {
      // A construction site's bill of materials draws from both registries, so
      // either one satisfying the reference is enough.
      if (t.materials.has(requirement.itemId) || t.supplies.has(requirement.itemId)) return
      issues.add(
        'materials',
        at('materials', i, 'itemId'),
        `${subject} is built from '${requirement.itemId}', which is neither a material nor a supply`,
      )
    })

    // A door that starts locked and cannot be unlocked is a wall with a price.
    if (door.startsLocked && !door.lockable) {
      issues.add('materials', at('startsLocked'), `${subject} starts locked but is not lockable`)
    }
    if (door.remoteControlled && !door.lockable) {
      issues.add(
        'materials',
        at('remoteControlled'),
        `${subject} is remote controlled but is not lockable, so a control room has nothing to open`,
      )
    }

    if (door.unlockedBy !== undefined) {
      issues.ref(
        'materials',
        at('unlockedBy'),
        subject,
        door.unlockedBy,
        t.nodes,
        'Directorate node',
      )
    }
  })
}

function checkNeeds(issues: Issues, r: Registries, traits: Target): void {
  r.needs.all.forEach((need, index) => {
    if (need.onlyWithTrait !== undefined) {
      issues.ref(
        'needs',
        ['needs', index, 'onlyWithTrait'],
        `need '${need.id}'`,
        need.onlyWithTrait,
        traits,
        'trait',
      )
    }
    const { medium, high, critical } = need.thresholds
    if (!(medium < high && high < critical)) {
      issues.add(
        'needs',
        ['needs', index, 'thresholds'],
        `need '${need.id}' thresholds must increase: medium ${medium}, high ${high}, critical ${critical}`,
      )
    }
  })
}

function checkRooms(
  issues: Issues,
  r: Registries,
  t: { materials: Target; supplies: Target; needs: Target; objects: Target; nodes: Target },
): void {
  r.rooms.all.forEach((room, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['rooms', index, ...rest]
    const subject = `room '${room.id}'`

    room.requiredObjects.forEach((requirement, i) => {
      const path = at('requiredObjects', i, 'objectId')
      if (!issues.ref('rooms', path, subject, requirement.objectId, t.objects, 'object')) return

      // An object that does not count for this room can never satisfy the
      // requirement, so requiring it would deadlock room evaluation (T1.3).
      const object = r.objects.get(requirement.objectId)
      if (!object.countsForRooms.includes(room.id)) {
        issues.add(
          'rooms',
          path,
          `${subject} requires object '${object.id}', but that object's countsForRooms does not list '${room.id}'`,
        )
      }
    })

    room.suggestedObjects.forEach((objectId, i) => {
      issues.ref('rooms', at('suggestedObjects', i), subject, objectId, t.objects, 'object')
    })

    room.servesNeeds.forEach((needId, i) => {
      issues.ref('rooms', at('servesNeeds', i), subject, needId, t.needs, 'need')
    })

    if (room.jobSlots !== undefined) {
      issues.ref(
        'rooms',
        at('jobSlots', 'objectId'),
        subject,
        room.jobSlots.objectId,
        t.objects,
        'object',
      )
    }

    room.autoPurchase?.forEach((entry, i) => {
      issues.ref(
        'rooms',
        at('autoPurchase', i, 'itemId'),
        subject,
        entry.itemId,
        t.supplies,
        'supply',
      )
    })

    if (room.unlockedBy !== undefined) {
      issues.ref('rooms', at('unlockedBy'), subject, room.unlockedBy, t.nodes, 'Directorate node')
    }

    if (room.graded && room.gradingRules === undefined) {
      issues.add('rooms', at('gradingRules'), `${subject} is graded but declares no gradingRules`)
    }
    if (!room.graded && room.gradingRules !== undefined) {
      issues.add('rooms', at('gradingRules'), `${subject} declares gradingRules but is not graded`)
    }

    const rules = room.gradingRules
    if (rules === undefined) return

    rules.objectPoints.forEach((rule, i) => {
      rule.objectIds.forEach((objectId, j) => {
        issues.ref(
          'rooms',
          at('gradingRules', 'objectPoints', i, 'objectIds', j),
          `${subject} grading`,
          objectId,
          t.objects,
          'object',
        )
      })
    })

    rules.materialPenalties?.forEach((rule, i) => {
      rule.materialIds.forEach((materialId, j) => {
        issues.ref(
          'rooms',
          at('gradingRules', 'materialPenalties', i, 'materialIds', j),
          `${subject} grading`,
          materialId,
          t.materials,
          'material',
        )
      })
    })
  })
}

function checkObjects(
  issues: Issues,
  r: Registries,
  t: { needs: Target; rooms: Target; contraband: Target; nodes: Target },
): void {
  r.objects.all.forEach((object, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['objects', index, ...rest]
    const subject = `object '${object.id}'`

    object.servesNeeds.forEach((entry, i) => {
      issues.ref('objects', at('servesNeeds', i, 'need'), subject, entry.need, t.needs, 'need')
    })

    object.countsForRooms.forEach((roomId, i) => {
      issues.ref('objects', at('countsForRooms', i), subject, roomId, t.rooms, 'room')
    })

    object.contrabandSourceFor?.forEach((itemId, i) => {
      issues.ref(
        'objects',
        at('contrabandSourceFor', i),
        subject,
        itemId,
        t.contraband,
        'contraband item',
      )
    })

    if (object.unlockedBy !== undefined) {
      issues.ref(
        'objects',
        at('unlockedBy'),
        subject,
        object.unlockedBy,
        t.nodes,
        'Directorate node',
      )
    }
  })
}

function checkStaff(
  issues: Issues,
  r: Registries,
  t: { needs: Target; rooms: Target; objects: Target; nodes: Target },
): void {
  r.staff.all.forEach((member, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['staff', index, ...rest]
    const subject = `staff '${member.id}'`

    member.needs.forEach((needId, i) => {
      const path = at('needs', i)
      if (!issues.ref('staff', path, subject, needId, t.needs, 'need')) return
      if (!r.needs.get(needId).staffAlso) {
        issues.add('staff', path, `${subject} lists need '${needId}', which is not a staff need`)
      }
    })

    if (member.requiresRoom !== undefined) {
      issues.ref('staff', at('requiresRoom'), subject, member.requiresRoom, t.rooms, 'room')
    }
    if (member.requiresObjectPerHead !== undefined) {
      issues.ref(
        'staff',
        at('requiresObjectPerHead'),
        subject,
        member.requiresObjectPerHead,
        t.objects,
        'object',
      )
    }
    if (member.unlockedBy !== undefined) {
      issues.ref('staff', at('unlockedBy'), subject, member.unlockedBy, t.nodes, 'Directorate node')
    }

    // PRD 5.8: research progresses only while the owning administrator has an
    // office, which is meaningless if the role does not require one.
    if (member.isAdministrator && !member.requiresOffice) {
      issues.add(
        'staff',
        at('requiresOffice'),
        `${subject} is an administrator but requires no office`,
      )
    }
  })
}

function checkDirectorate(
  issues: Issues,
  r: Registries,
  t: { staff: Target; nodes: Target; features: Target },
): void {
  r.directorate.all.forEach((node, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['nodes', index, ...rest]
    const subject = `Directorate node '${node.id}'`

    node.prerequisites.forEach((prerequisiteId, i) => {
      const path = at('prerequisites', i)
      if (!issues.ref('directorate', path, subject, prerequisiteId, t.nodes, 'Directorate node'))
        return
      if (prerequisiteId === node.id) {
        issues.add('directorate', path, `${subject} lists itself as a prerequisite`)
      }
    })

    if (
      issues.ref('directorate', at('administrator'), subject, node.administrator, t.staff, 'staff')
    ) {
      const admin = r.staff.get(node.administrator)
      if (!admin.isAdministrator) {
        issues.add(
          'directorate',
          at('administrator'),
          `${subject} is owned by staff '${admin.id}', which is not an administrator`,
        )
      }
    }

    node.unlocksFeatures.forEach((featureId, i) => {
      issues.ref('directorate', at('unlocksFeatures', i), subject, featureId, t.features, 'feature')
    })
  })

  detectCycle(
    r.directorate.all.map((node) => [node.id, node.prerequisites] as const),
    (cycle) => {
      issues.add(
        'directorate',
        ['nodes'],
        `prerequisite cycle: ${cycle.join(' -> ')}. Research would never become available.`,
      )
    },
  )
}

function checkPrograms(
  issues: Issues,
  r: Registries,
  t: {
    needs: Target
    rooms: Target
    objects: Target
    staff: Target
    programs: Target
    traits: Target
    nodes: Target
  },
): void {
  r.programs.all.forEach((program, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['programs', index, ...rest]
    const subject = `program '${program.id}'`

    issues.ref('programs', at('tutorStaffId'), subject, program.tutorStaffId, t.staff, 'staff')
    const roomOk = issues.ref('programs', at('roomId'), subject, program.roomId, t.rooms, 'room')

    if (program.seatObjectId !== undefined) {
      const path = at('seatObjectId')
      if (
        issues.ref('programs', path, subject, program.seatObjectId, t.objects, 'object') &&
        roomOk
      ) {
        const seat = r.objects.get(program.seatObjectId)
        if (!seat.countsForRooms.includes(program.roomId)) {
          issues.add(
            'programs',
            path,
            `${subject} seats inmates at '${seat.id}', which does not count for its room '${program.roomId}'`,
          )
        }
      }
    }

    if (program.prerequisiteProgramId !== undefined) {
      const path = at('prerequisiteProgramId')
      if (
        issues.ref(
          'programs',
          path,
          subject,
          program.prerequisiteProgramId,
          t.programs,
          'program',
        ) &&
        program.prerequisiteProgramId === program.id
      ) {
        issues.add('programs', path, `${subject} lists itself as a prerequisite`)
      }
    }

    if (program.unlockedBy !== undefined) {
      issues.ref(
        'programs',
        at('unlockedBy'),
        subject,
        program.unlockedBy,
        t.nodes,
        'Directorate node',
      )
    }

    program.effects.forEach((effect, i) => {
      if (effect.type === 'suppressNeedWhileEnrolled') {
        issues.ref('programs', at('effects', i, 'needId'), subject, effect.needId, t.needs, 'need')
      } else if (effect.type === 'traitMisconductMultiplier') {
        issues.ref(
          'programs',
          at('effects', i, 'traitId'),
          subject,
          effect.traitId,
          t.traits,
          'trait',
        )
      }
    })
  })

  detectCycle(
    r.programs.all.map(
      (program) =>
        [
          program.id,
          program.prerequisiteProgramId === undefined ? [] : [program.prerequisiteProgramId],
        ] as const,
    ),
    (cycle) => {
      issues.add('programs', ['programs'], `prerequisite cycle: ${cycle.join(' -> ')}`)
    },
  )
}

function checkContraband(issues: Issues, r: Registries, rooms: Target): void {
  r.contraband.all.forEach((item, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['items', index, ...rest]
    const subject = `contraband item '${item.id}'`

    item.sourceRooms.forEach((roomId, i) => {
      issues.ref('contraband', at('sourceRooms', i), subject, roomId, rooms, 'room')
    })
    item.craftableIn.forEach((roomId, i) => {
      issues.ref('contraband', at('craftableIn', i), subject, roomId, rooms, 'room')
    })
  })
}

function checkContracts(
  issues: Issues,
  r: Registries,
  t: {
    needs: Target
    rooms: Target
    objects: Target
    staff: Target
    programs: Target
    nodes: Target
  },
): void {
  const checkPredicate = (
    path: readonly PropertyKey[],
    subject: string,
    predicate: ContractPredicate,
  ): void => {
    switch (predicate.type) {
      case 'roomCount':
      case 'roomGrade':
        issues.ref('contracts', [...path, 'roomId'], subject, predicate.roomId, t.rooms, 'room')
        return
      case 'objectCount':
        issues.ref(
          'contracts',
          [...path, 'objectId'],
          subject,
          predicate.objectId,
          t.objects,
          'object',
        )
        return
      case 'staffHired':
        issues.ref('contracts', [...path, 'staffId'], subject, predicate.staffId, t.staff, 'staff')
        return
      case 'programCompletions':
        issues.ref(
          'contracts',
          [...path, 'programId'],
          subject,
          predicate.programId,
          t.programs,
          'program',
        )
        return
      case 'directorateComplete':
        issues.ref(
          'contracts',
          [...path, 'nodeId'],
          subject,
          predicate.nodeId,
          t.nodes,
          'Directorate node',
        )
        return
      case 'needBelow':
        issues.ref('contracts', [...path, 'needId'], subject, predicate.needId, t.needs, 'need')
        return
      default:
        // The remaining predicates read scalars off world state and name nothing.
        return
    }
  }

  r.contracts.all.forEach((contract, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['contracts', index, ...rest]
    const subject = `contract '${contract.id}'`

    contract.prerequisites.forEach((nodeId, i) => {
      issues.ref('contracts', at('prerequisites', i), subject, nodeId, t.nodes, 'Directorate node')
    })

    contract.todoItems.forEach((item, i) => {
      checkPredicate(at('todoItems', i, 'predicate'), subject, item.predicate)
    })

    contract.revealWhen?.forEach((predicate, i) => {
      checkPredicate(at('revealWhen', i), subject, predicate)
    })

    if (contract.hidden && contract.revealWhen === undefined) {
      issues.add('contracts', at('revealWhen'), `${subject} is hidden but has no reveal predicate`)
    }
    if (!contract.hidden && contract.revealWhen !== undefined) {
      issues.add('contracts', at('hidden'), `${subject} has a reveal predicate but is not hidden`)
    }
  })
}

function checkInmates(issues: Issues, r: Registries, t: { traits: Target; nodes: Target }): void {
  r.securityCategories.all.forEach((category, index) => {
    if (category.unlockedBy !== undefined) {
      issues.ref(
        'inmates',
        ['securityCategories', index, 'unlockedBy'],
        `security category '${category.id}'`,
        category.unlockedBy,
        t.nodes,
        'Directorate node',
      )
    }
  })

  r.convictions.all.forEach((conviction, index) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['convictions', index, ...rest]
    const subject = `conviction '${conviction.id}'`

    conviction.grantsTraits.forEach((traitId, i) => {
      issues.ref('inmates', at('grantsTraits', i), subject, traitId, t.traits, 'trait')
    })

    if (conviction.minYears > conviction.maxYears) {
      issues.add(
        'inmates',
        at('maxYears'),
        `${subject} has minYears ${conviction.minYears} above maxYears ${conviction.maxYears}`,
      )
    }
  })
}

/**
 * Reports the first cycle reachable in a dependency graph, if any. Depth-first
 * with an explicit stack so a pathological data file cannot blow the call
 * stack before the error is reported.
 */
function detectCycle(
  edges: ReadonlyArray<readonly [string, readonly string[]]>,
  report: (cycle: readonly string[]) => void,
): void {
  const adjacency = new Map(edges)
  const state = new Map<string, 'visiting' | 'done'>()
  const trail: string[] = []

  const visit = (id: string): boolean => {
    const seen = state.get(id)
    if (seen === 'done') return false
    if (seen === 'visiting') {
      report([...trail.slice(trail.indexOf(id)), id])
      return true
    }
    state.set(id, 'visiting')
    trail.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) return true
    }
    trail.pop()
    state.set(id, 'done')
    return false
  }

  for (const [id] of edges) {
    if (visit(id)) return
  }
}

/* -------------------------------------------------------------------------- */
/* Derived indexes                                                             */
/* -------------------------------------------------------------------------- */

function deriveUnlocks(r: Registries): ReadonlyMap<string, DirectorateUnlocks> {
  interface Mutable {
    rooms: string[]
    objects: string[]
    staff: string[]
    programs: string[]
    materials: string[]
    doors: string[]
    securityCategories: string[]
    features: string[]
  }

  const byNode = new Map<string, Mutable>()
  for (const node of r.directorate.all) {
    byNode.set(node.id, {
      rooms: [],
      objects: [],
      staff: [],
      programs: [],
      materials: [],
      doors: [],
      securityCategories: [],
      features: [...node.unlocksFeatures],
    })
  }

  const collect = (
    key: Exclude<keyof Mutable, 'features'>,
    defs: ReadonlyArray<{ readonly id: string; readonly unlockedBy?: string | undefined }>,
  ): void => {
    for (const entry of defs) {
      if (entry.unlockedBy === undefined) continue
      byNode.get(entry.unlockedBy)?.[key].push(entry.id)
    }
  }

  collect('rooms', r.rooms.all)
  collect('objects', r.objects.all)
  collect('staff', r.staff.all)
  collect('programs', r.programs.all)
  collect('materials', r.materials.all)
  collect('doors', r.doors.all)
  collect('securityCategories', r.securityCategories.all)

  return byNode
}
