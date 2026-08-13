/**
 * @blockwork/render - the PixiJS presentation layer.
 *
 * May import from @blockwork/sim for types only (`import type`). Never imports
 * from ui or app.
 */

export const RENDER_PACKAGE_NAME = '@blockwork/render'

export { TILE_SIZE, tilesToWorld, worldToTile } from './tiles'

export {
  Camera,
  DEFAULT_CAMERA_MARGIN,
  GestureController,
  MAX_ZOOM,
  MIN_ZOOM,
  ToolInputController,
  ZOOM_STOPS,
  lineBetween,
  nearestZoomStop,
  rectBetween,
  zoomStopFrom,
} from './camera/index'
export type {
  CameraOptions,
  GestureControllerOptions,
  TileLine,
  TilePoint,
  TileRect,
  ToolInputHandlers,
  ToolInputOptions,
  ToolStroke,
  Vec2,
  WorldRect,
} from './camera/index'

export {
  BARE_GROUND_APPEARANCE,
  DEFAULT_FLOOR_APPEARANCE,
  DEFAULT_GROUND_APPEARANCE,
  MAX_TERRAIN_MATERIALS,
  terrainPalette,
  TERRAIN_ATLAS_CELL_PX,
  TERRAIN_ATLAS_COLUMNS,
  TERRAIN_CHUNK_TILES,
  TERRAIN_CHUNK_WORLD,
  TerrainLayer,
  createTerrainAtlas,
  terrainChunkRange,
} from './layers/terrain'
export type {
  TerrainAtlas,
  TerrainAtlasOptions,
  TerrainLayerOptions,
  TerrainTileAppearance,
} from './layers/terrain'

export {
  GRID_BOUNDARY_COLOUR,
  GRID_FADE_ZOOM,
  GRID_FULL_ZOOM,
  GRID_LINE_COLOUR,
  GridLayer,
  gridAlpha,
} from './layers/grid'
export type { GridLayerOptions } from './layers/grid'

export {
  AUTOTILE_CANONICAL_MASKS,
  AUTOTILE_CARDINALS,
  AUTOTILE_CORNERS,
  AUTOTILE_DIAGONALS,
  AUTOTILE_INDEX_BY_MASK,
  AUTOTILE_MASK_COUNT,
  AUTOTILE_NEIGHBOUR,
  AUTOTILE_OFFSETS,
  AUTOTILE_TILE_COUNT,
  autotileCanonicalMask,
  autotileConnects,
  autotileIndex,
  autotileIsInnerCorner,
  autotileMaskAt,
} from './sprites/autotile'
export type { AutotileCorner, AutotileNeighbourBit } from './sprites/autotile'

export {
  applyGrain,
  createSpriteCanvas,
  cssColour,
  greyColour,
  sliceAtlas,
  spriteAtlasFromCanvas,
  spriteHash,
  spriteNoise,
} from './sprites/atlas'
export type { SpriteAtlas, SpriteAtlasOptions } from './sprites/atlas'

export {
  DEFAULT_DOOR_APPEARANCES,
  DEFAULT_WALL_APPEARANCE,
  DOOR_ATLAS_TYPES,
  DOOR_FRAMES,
  DOOR_ORIENTATIONS,
  DOOR_SWING_FRAMES,
  MAX_WALL_MATERIALS,
  WALL_ATLAS_CELL_PX,
  WALL_ATLAS_COLUMNS,
  WallLayer,
  createDoorAtlas,
  createWallShapeAtlas,
  doorAtlasCell,
  doorFrameFromOpen,
  doorOrientation,
  wallPalette,
} from './layers/walls'
export type {
  DoorAppearance,
  DoorFrame,
  DoorOrientation,
  RenderDoor,
  WallAppearance,
  WallLayerOptions,
} from './layers/walls'

export {
  DEFAULT_OBJECT_APPEARANCE,
  OBJECT_ATLAS_CELL_PX,
  OBJECT_SHAPES,
  ObjectLayer,
  createObjectAtlas,
  defaultObjectAppearance,
  objectColourForId,
  objectShapeForSize,
  objectSortY,
} from './layers/objects'
export type {
  ObjectAppearance,
  ObjectLayerOptions,
  ObjectShape,
  RenderObject,
} from './layers/objects'

export {
  AGENT_ATLAS_CELL_PX,
  AGENT_ATLAS_COLUMNS,
  AGENT_ATLAS_FIGURE_COLUMNS,
  AGENT_ATLAS_ROWS,
  AGENT_DOT_SCREEN_PX,
  AGENT_DOT_ZOOM,
  AGENT_FACING,
  AGENT_FACINGS,
  AGENT_FLAG,
  AGENT_MOOD_NEED_IDS,
  AGENT_SELECTION_COLOUR,
  AGENT_SPRITE_POOL_CEILING,
  AGENT_SPRITE_WORLD,
  AGENT_WALK_FRAMES,
  AgentLayer,
  CATEGORY_UNIFORM_COLOURS,
  STAFF_UNIFORM_COLOUR,
  agentBodyCell,
  agentDotCell,
  agentFlagsIdle,
  agentFlagsMoodIndex,
  agentFlagsSelected,
  agentMoodCell,
  agentSelectionCell,
  agentSortY,
  agentUniformCell,
  createAgentAtlas,
  interpolateAgents,
  moodNeedIdFromIndex,
  moodNeedIndexFromId,
  packAgentFlags,
  uniformColourForCategory,
} from './layers/agents'
export type { AgentFacing, AgentLayerOptions, AgentMoodNeedId, RenderAgent } from './layers/agents'

export {
  BLUEPRINT_DASH,
  BLUEPRINT_FILL_ALPHA,
  BLUEPRINT_INVALID_COLOUR,
  BLUEPRINT_STROKE_ALPHA,
  BLUEPRINT_VALID_COLOUR,
  BlueprintLayer,
} from './layers/blueprint'
export type { BlueprintLayerOptions, BlueprintRect } from './layers/blueprint'

export {
  OVERLAY_MODE_DEFINITIONS,
  OVERLAY_MODES,
  OVERLAY_PALETTE_IDS,
  OVERLAY_PALETTES,
  OverlayLayer,
  overlayCategoricalPattern,
  overlayLegendBands,
  parseCssColour,
} from './layers/overlay'
export type {
  OverlayFireTile,
  OverlayLayerOptions,
  OverlayLegendBand,
  OverlayMode,
  OverlayModeDefinition,
  OverlayPalette,
  OverlayPaletteId,
  OverlayPattern,
  OverlayScale,
  OverlayTunnel,
  PrdOverlayMode,
} from './layers/overlay'

export {
  EFFECT_ATLAS_CELL_PX,
  EFFECT_PIN_COLOURS,
  EFFECT_PULSE_FRAMES,
  EFFECT_SELECTION_COLOUR,
  EffectsLayer,
  PIN_HOVER_OFFSET,
  SELECTION_RING_RADIUS,
  createEffectsAtlas,
  effectsChevronCell,
  effectsPinCell,
  effectsSelectionCell,
} from './layers/effects'
export type {
  EffectPathSegment,
  EffectPin,
  EffectPinSeverity,
  EffectSelection,
  EffectsLayerOptions,
} from './layers/effects'

export { BlockworkRenderer, LETTERBOX_COLOUR, MAX_RENDER_RESOLUTION } from './app'
export type { BlockworkRendererOptions } from './app'

/* -------------------------------------------------------------------------- */
/* T6.6 — the art pass                                                         */
/* -------------------------------------------------------------------------- */

export {
  ACCENT_SWATCHES,
  ART_PALETTE,
  LIGHT_SWATCHES,
  MUTED_SATURATION_CEILING,
  SATURATED_SWATCHES,
  paletteEntries,
  swatchColour,
  swatchLuma,
  swatchSaturation,
} from './sprites/palette'

export { appearanceFromDef, objectAppearances } from './layers/objects'
export { materialAppearances, terrainPaletteFor } from './layers/terrain'
