/**
 * What each dock tool puts in the tray, and what a stroke with it means.
 *
 * A palette entry is two things at once: a chip the player taps, and the rule
 * that turns their next drag into a `BuildAction`. Keeping both on one record
 * is what stops the two drifting apart — there is no table mapping chip ids to
 * behaviour that someone can forget to extend, because the behaviour *is* the
 * chip.
 *
 * Everything is derived from `GameData`. Adding a floor material to
 * `materials.json` puts a chip in the Build tray; adding a room to
 * `rooms.json` puts one in Rooms. That is CLAUDE.md rule 4 applied to the
 * interface as well as to the balance: the palette is content, not code.
 */

import type { BuildAction, GameData, MaterialId, Rect, Tile } from '@blockwork/sim'
import type { TileLine, TileRect } from '@blockwork/render'
import type { DockToolId, IconName, TrayGroup, TrayItem } from '@blockwork/ui'

/** How a palette entry reads a gesture. */
export type PaletteGesture =
  /** Drag a rectangle. */
  | 'rect'
  /** Drag a line; a diagonal snaps to an axis. */
  | 'line'
  /** Tap one tile. A drag places a run of them. */
  | 'tile'

/**
 * Content ids the Directorate has unlocked (T5.1). Built on the worker via
 * `isUnlocked` and applied when rebuilding trays so research completion
 * clears chip locks without a page reload.
 */
export interface UnlockSnapshot {
  readonly rooms: readonly string[]
  readonly objects: readonly string[]
  readonly staff: readonly string[]
}

export interface PaletteEntry {
  readonly id: string
  readonly name: string
  readonly note?: string
  readonly icon: IconName
  readonly gesture: PaletteGesture
  readonly locked?: boolean
  /** One tile of a `tile` gesture, or the whole shape for the other two. */
  readonly action: (shape: { rect: TileRect; line: TileLine; tile: Tile }) => BuildAction
}

export interface Palette {
  readonly groups: readonly TrayGroup[]
  readonly entries: ReadonlyMap<string, PaletteEntry>
  /** The chip selected when the tool opens. */
  readonly initial: string | null
}

const EMPTY_PALETTE: Palette = { groups: [], entries: new Map(), initial: null }

function toRect(rect: TileRect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** Chips, in the order they were built, grouped for the tray. */
function group(id: string, label: string, entries: readonly PaletteEntry[]): TrayGroup {
  const items: TrayItem[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    icon: entry.icon,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    ...(entry.locked === undefined ? {} : { locked: entry.locked }),
  }))
  return { id, label, items }
}

function palette(groups: readonly TrayGroup[], entries: readonly PaletteEntry[]): Palette {
  return {
    groups,
    entries: new Map(entries.map((entry) => [entry.id, entry])),
    initial: entries.find((entry) => entry.locked !== true)?.id ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

function buildPalette(data: GameData): Palette {
  const floors = data.materials.all.filter((material) => material.surfaces.includes('floor'))
  const walls = data.materials.all.filter((material) => material.surfaces.includes('wall'))

  /**
   * `placeFoundation` takes the material of the **perimeter wall**, not of the
   * floor: the floor is `balance.construction.foundationFloorMaterial` and is
   * deliberately not the player's choice at this stage — they repaint it with
   * `PaintFloor` afterwards. Passing the floor id here is the obvious mistake
   * and it fails as "wrong surface", so the wall material is named explicitly.
   */
  const defaultWall = walls[0]

  const structure: PaletteEntry[] = []

  if (defaultWall !== undefined) {
    structure.push({
      id: 'foundation',
      name: 'Foundation',
      note: `${defaultWall.name} shell`,
      icon: 'foundation',
      gesture: 'rect',
      action: ({ rect }) => ({
        kind: 'placeFoundation',
        rect: toRect(rect),
        material: defaultWall.id as MaterialId,
      }),
    })
  }

  for (const material of walls) {
    structure.push({
      id: `wall:${material.id}`,
      name: material.name,
      note: `$${String(material.costPerTile)}/tile`,
      icon: 'wall',
      gesture: 'line',
      action: ({ line }) => ({
        kind: 'placeWall',
        line,
        material: material.id as MaterialId,
      }),
    })
  }

  const doors: PaletteEntry[] = data.doors.all.map((door) => ({
    id: `door:${door.id}`,
    name: door.name.replace(/ door$/i, ''),
    note: `$${String(door.cost)}`,
    icon: 'door',
    gesture: 'tile',
    action: ({ tile }) => ({ kind: 'placeDoor', tile, doorType: door.id }),
  }))

  const floorEntries: PaletteEntry[] = floors.map((material) => ({
    id: `floor:${material.id}`,
    name: material.name,
    note: `$${String(material.costPerTile)}/tile`,
    icon: 'floor',
    gesture: 'rect',
    action: ({ rect }) => ({
      kind: 'paintFloor',
      rect: toRect(rect),
      material: material.id as MaterialId,
    }),
  }))

  const demolish: PaletteEntry = {
    id: 'demolish',
    name: 'Demolish',
    note: `${String(Math.round(data.balance.construction.materialRefundOnDemolish * 100))}% back`,
    icon: 'demolish',
    gesture: 'rect',
    action: ({ rect }) => ({ kind: 'demolish', rect: toRect(rect) }),
  }

  const all = [...structure, ...doors, ...floorEntries, demolish]

  return palette(
    [
      group('structure', 'Structure', structure),
      group('doors', 'Doors', doors),
      group('floors', 'Floors', floorEntries),
      group('remove', 'Remove', [demolish]),
    ],
    all,
  )
}

/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

/** The category labels of `rooms.json`, as the tray writes them. */
const ROOM_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  housing: 'Housing',
  inmateActivity: 'Activity',
  production: 'Production',
  admin: 'Admin',
  staff: 'Staff',
  medical: 'Medical',
  logistics: 'Logistics',
}

/** "2x3 min", "needs power", or the requirement that most constrains it. */
function roomNote(room: GameData['rooms']['all'][number]): string {
  if (room.minWidth > 1 || room.minHeight > 1) {
    return `${String(room.minWidth)}x${String(room.minHeight)} min`
  }
  if (room.minTiles > 1) return `${String(room.minTiles)} tiles min`
  return 'any size'
}

function roomsPalette(data: GameData, unlocks: UnlockSnapshot | null): Palette {
  const unlocked = new Set(unlocks?.rooms ?? [])
  const entries: PaletteEntry[] = data.rooms.all.map((room) => ({
    id: `room:${room.id}`,
    name: room.name,
    note: roomNote(room),
    icon: 'rooms',
    gesture: 'rect',
    // Unlocks are the Directorate's (PRD 5.8). Gated chips stay visible but
    // disabled until the worker reports them unlocked.
    ...(room.unlockedBy === undefined || unlocked.has(room.id) ? {} : { locked: true }),
    action: ({ rect }) => ({ kind: 'designateRoom', rect: toRect(rect), roomDefId: room.id }),
  }))

  const byCategory = new Map<string, PaletteEntry[]>()
  data.rooms.all.forEach((room, index) => {
    const entry = entries[index]
    if (entry === undefined) return
    const bucket = byCategory.get(room.category)
    if (bucket === undefined) byCategory.set(room.category, [entry])
    else bucket.push(entry)
  })

  const groups = [...byCategory].map(([category, items]) =>
    group(category, ROOM_CATEGORY_LABELS[category] ?? category, items),
  )

  return palette(groups, entries)
}

/* -------------------------------------------------------------------------- */
/* Objects                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Objects grouped by the first room that requires them, then by the first that
 * merely counts, then "General".
 *
 * Ninety-three objects in a flat row is a row nobody can find anything in.
 * Grouping by the room they serve is the grouping the player is already
 * thinking in, because they opened the palette while standing in that room.
 */
function objectsPalette(data: GameData, unlocks: UnlockSnapshot | null): Palette {
  const unlocked = new Set(unlocks?.objects ?? [])
  const entries: PaletteEntry[] = data.objects.all.map((object) => ({
    id: `object:${object.id}`,
    name: object.name,
    note: `$${String(object.cost)}`,
    icon: 'objects',
    gesture: 'tile',
    ...(object.unlockedBy === undefined || unlocked.has(object.id) ? {} : { locked: true }),
    action: ({ tile }) => ({
      kind: 'placeObject',
      tile,
      objectDefId: object.id,
      rotation: 0,
    }),
  }))

  const buckets = new Map<string, PaletteEntry[]>()
  data.objects.all.forEach((object, index) => {
    const entry = entries[index]
    if (entry === undefined) return
    const key = object.countsForRooms[0] ?? 'general'
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [entry])
    else bucket.push(entry)
  })

  const groups = [...buckets].map(([key, items]) =>
    group(key, key === 'general' ? 'General' : (data.rooms.find(key)?.name ?? key), items),
  )

  return palette(groups, entries)
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

const UTILITY_OBJECT_IDS = ['generator', 'water_pump', 'capacitor', 'pipe_valve'] as const

function utilitiesPalette(data: GameData, unlocks: UnlockSnapshot | null): Palette {
  const unlocked = new Set(unlocks?.objects ?? [])
  const cables = data.materials.all.filter((material) => material.surfaces.includes('cable'))
  const pipes = data.materials.all.filter((material) => material.surfaces.includes('pipe'))

  const runs: PaletteEntry[] = [
    ...cables.map((material) => ({
      id: `cable:${material.id}`,
      name: material.name,
      note: `$${String(material.costPerTile)}/tile`,
      icon: 'utilities' as const,
      gesture: 'line' as const,
      action: ({ line }: { rect: TileRect; line: TileLine; tile: Tile }): BuildAction => ({
        kind: 'paintCable',
        line,
      }),
    })),
    ...pipes.map((material) => ({
      id: `pipe:${material.id}`,
      name: material.name,
      note: `$${String(material.costPerTile)}/tile`,
      icon: 'utilities' as const,
      gesture: 'line' as const,
      action: ({ line }: { rect: TileRect; line: TileLine; tile: Tile }): BuildAction => ({
        kind: 'paintPipe',
        line,
      }),
    })),
  ]

  const equipment: PaletteEntry[] = []
  for (const id of UTILITY_OBJECT_IDS) {
    const object = data.objects.find(id)
    if (object === undefined) continue
    equipment.push({
      id: `object:${object.id}`,
      name: object.name,
      note: `$${String(object.cost)}`,
      icon: 'utilities',
      gesture: 'tile',
      ...(object.unlockedBy === undefined || unlocked.has(object.id) ? {} : { locked: true }),
      action: ({ tile }) => ({
        kind: 'placeObject',
        tile,
        objectDefId: object.id,
        rotation: 0,
      }),
    })
  }

  const all = [...runs, ...equipment]
  if (all.length === 0) return EMPTY_PALETTE

  const groups = [
    ...(runs.length > 0 ? [group('runs', 'Runs', runs)] : []),
    ...(equipment.length > 0 ? [group('equipment', 'Equipment', equipment)] : []),
  ]

  return palette(groups, all)
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Hire chips for every staff role. Strokes are no-ops — selecting a chip and
 * tapping a tile issues `staff.hire` via the session (not the build queue).
 */
function staffPalette(data: GameData, unlocks: UnlockSnapshot | null): Palette {
  const unlocked = new Set(unlocks?.staff ?? [])
  const noop = (): BuildAction => ({ kind: 'restore', tiles: [] })

  const administrators: PaletteEntry[] = []
  const operations: PaletteEntry[] = []

  for (const member of data.staff.all) {
    // Callable / per-session roles (riot squad, tutors) are not hire chips.
    if (member.callable || member.perSession) continue
    const entry: PaletteEntry = {
      id: member.id,
      name: member.name,
      note: `$${String(member.hireCost)}`,
      icon: 'staff',
      gesture: 'tile',
      ...(member.unlockedBy === undefined || unlocked.has(member.id) ? {} : { locked: true }),
      action: noop,
    }
    if (member.isAdministrator) administrators.push(entry)
    else operations.push(entry)
  }

  const all = [...administrators, ...operations]
  if (all.length === 0) return EMPTY_PALETTE

  return palette(
    [
      ...(administrators.length > 0
        ? [group('administrators', 'Administrators', administrators)]
        : []),
      ...(operations.length > 0 ? [group('operations', 'Operations', operations)] : []),
    ],
    all,
  )
}

/* -------------------------------------------------------------------------- */
/* Overlay                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Map visualisation chips (Phase 4 interim). Strokes are no-ops — selecting a
 * chip only switches the renderer's overlay mode via the session.
 */
function overlayPalette(): Palette {
  const noop = (): BuildAction => ({ kind: 'restore', tiles: [] })

  const entries: PaletteEntry[] = [
    {
      id: 'sectors',
      name: 'Sectors',
      note: 'Painted sector colours',
      icon: 'posts',
      gesture: 'tile',
      action: noop,
    },
    {
      id: 'fire',
      name: 'Fire',
      note: 'Active fire and smoke',
      icon: 'emergency',
      gesture: 'tile',
      action: noop,
    },
    {
      id: 'tunnels',
      name: 'Tunnels',
      note: 'Discovered dig routes',
      icon: 'search',
      gesture: 'tile',
      action: noop,
    },
  ]

  return palette([group('overlays', 'Overlays', entries)], entries)
}

/* -------------------------------------------------------------------------- */

/**
 * Every tool's palette, built once from the data (and refreshed when the
 * Directorate unlocks content).
 *
 * Tools with no system behind them yet return an empty palette, which is what
 * keeps their tray shut rather than opening an empty one.
 */
export function createPalettes(
  data: GameData,
  unlocks: UnlockSnapshot | null = null,
): Readonly<Record<DockToolId, Palette>> {
  return {
    build: buildPalette(data),
    rooms: roomsPalette(data, unlocks),
    objects: objectsPalette(data, unlocks),
    utilities: utilitiesPalette(data, unlocks),
    staff: staffPalette(data, unlocks),
    posts: EMPTY_PALETTE,
    flow: EMPTY_PALETTE,
    plan: EMPTY_PALETTE,
    reports: reportsPalette(),
    overlay: overlayPalette(),
    emergency: EMPTY_PALETTE,
  }
}

/** Stable key so the session can skip rebuilds when unlocks have not changed. */
export function unlockSnapshotKey(unlocks: UnlockSnapshot): string {
  return [
    unlocks.rooms.join(','),
    unlocks.objects.join(','),
    unlocks.staff.join(','),
  ].join('|')
}

/** Tools whose systems do not exist yet, so the dock can grey them out. */
export const UNBUILT_TOOLS: readonly DockToolId[] = ['flow']

/**
 * Reports palette chips open Phase 5 panels (Directorate / Programs /
 * Intelligence). Strokes are no-ops — selecting a chip opens the panel via
 * the session.
 */
function reportsPalette(): Palette {
  const noop = (): BuildAction => ({ kind: 'restore', tiles: [] })
  const entries: PaletteEntry[] = [
    {
      id: 'directorate',
      name: 'Directorate',
      note: 'Research tree',
      icon: 'reports',
      gesture: 'tile',
      action: noop,
    },
    {
      id: 'programmes',
      name: 'Programmes',
      note: 'Reform sessions',
      icon: 'flow',
      gesture: 'tile',
      action: noop,
    },
    {
      id: 'intelligence',
      name: 'Intelligence',
      note: 'Informants and contraband',
      icon: 'search',
      gesture: 'tile',
      action: noop,
    },
  ]
  return palette([group('reports', 'Reports', entries)], entries)
}

/** The one-line instruction shown over the world for the selected chip. */
export function gestureHint(entry: PaletteEntry | undefined): string | null {
  if (entry === undefined) return null
  switch (entry.gesture) {
    case 'rect':
      return `Drag a rectangle to place ${entry.name.toLowerCase()}`
    case 'line':
      return `Drag a line to run ${entry.name.toLowerCase()}`
    case 'tile':
      return `Tap a tile to place ${entry.name.toLowerCase()}, or drag a run`
  }
}
