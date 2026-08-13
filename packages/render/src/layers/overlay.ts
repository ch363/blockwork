/**
 * PRD 6.4 map overlays.
 *
 * Every mode is rendered by the same full-map quad. One RGBA texel per tile
 * carries a value in red and a visibility mask in alpha; the fragment shader
 * turns that value into a palette colour plus a repeating pattern. Switching
 * modes changes texture bytes and uniforms, never scene-graph shape, so the
 * layer remains one draw call on a 100x100 or a 300x300 map.
 */

import { BufferImageSource, Container, Geometry, Mesh, Shader } from 'pixi.js'

import type { Camera } from '../camera/camera'
import { TILE_SIZE } from '../tiles'

export const OVERLAY_MODES = [
  'sectors',
  'roomGrade',
  'needs',
  'contrabandRisk',
  'power',
  'water',
  'temperature',
  'cleanliness',
  'guardCoverage',
  'fogOfWar',
] as const

export type PrdOverlayMode = (typeof OVERLAY_MODES)[number]

/** Fire and tunnels are retained for the Phase 4 emergency/debug callers. */
export type OverlayMode = 'off' | PrdOverlayMode | 'fire' | 'tunnels'

export const OVERLAY_PALETTE_IDS = ['standard', 'deuteranopia', 'protanopia', 'tritanopia'] as const
export type OverlayPaletteId = (typeof OVERLAY_PALETTE_IDS)[number]

export type OverlayPattern = 'solid' | 'diagonal' | 'dots' | 'crosshatch'
export type OverlayScale = 'scalar' | 'categorical' | 'inverse'

export interface OverlayModeDefinition {
  readonly id: PrdOverlayMode
  readonly label: string
  readonly scale: OverlayScale
  readonly lowLabel: string
  readonly highLabel: string
}

export const OVERLAY_MODE_DEFINITIONS: Readonly<Record<PrdOverlayMode, OverlayModeDefinition>> = {
  sectors: {
    id: 'sectors',
    label: 'Sectors',
    scale: 'categorical',
    lowLabel: 'Sector 1',
    highLabel: 'Sector 8+',
  },
  roomGrade: {
    id: 'roomGrade',
    label: 'Room grade',
    scale: 'scalar',
    lowLabel: 'Grade 0',
    highLabel: 'Grade 10',
  },
  needs: {
    id: 'needs',
    label: 'Needs heatmap',
    scale: 'scalar',
    lowLabel: 'Satisfied',
    highLabel: 'Critical',
  },
  contrabandRisk: {
    id: 'contrabandRisk',
    label: 'Contraband risk',
    scale: 'scalar',
    lowLabel: 'Low risk',
    highLabel: 'High risk',
  },
  power: {
    id: 'power',
    label: 'Power',
    scale: 'categorical',
    lowLabel: 'Disconnected',
    highLabel: 'Browned out',
  },
  water: {
    id: 'water',
    label: 'Water',
    scale: 'scalar',
    lowLabel: 'No flow',
    highLabel: 'Full flow',
  },
  temperature: {
    id: 'temperature',
    label: 'Temperature',
    scale: 'scalar',
    lowLabel: 'Cold',
    highLabel: 'Hot',
  },
  cleanliness: {
    id: 'cleanliness',
    label: 'Cleanliness',
    scale: 'inverse',
    lowLabel: 'Clean',
    highLabel: 'Dirty',
  },
  guardCoverage: {
    id: 'guardCoverage',
    label: 'Guard coverage',
    scale: 'scalar',
    lowLabel: 'Uncovered',
    highLabel: 'Covered',
  },
  fogOfWar: {
    id: 'fogOfWar',
    label: 'Fog of war',
    scale: 'categorical',
    lowLabel: 'Visible',
    highLabel: 'Hidden',
  },
}

export interface OverlayPalette {
  readonly id: OverlayPaletteId
  readonly label: string
  /** Five ordered value bands, low to high. */
  readonly sequential: readonly [number, number, number, number, number]
  /** Eight categorical colours; pattern is a second, independent channel. */
  readonly categorical: readonly [number, number, number, number, number, number, number, number]
}

/**
 * Palettes use large luminance steps and are always paired with shader
 * patterns. They therefore remain separable when a hue pair collapses under a
 * colour-vision transform, rather than merely claiming safety by hue choice.
 */
export const OVERLAY_PALETTES: Readonly<Record<OverlayPaletteId, OverlayPalette>> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    sequential: [0x264653, 0x2a9d8f, 0xe9c46a, 0xf4a261, 0xe76f51],
    categorical: [0x4c9be8, 0xf0a93b, 0x4fb477, 0x9b7bd4, 0xe05c5c, 0x64c7c7, 0xd6c24a, 0x8d98a8],
  },
  deuteranopia: {
    id: 'deuteranopia',
    label: 'Deuteranopia',
    sequential: [0x173f5f, 0x20639b, 0x3caea3, 0xf6d55c, 0xed8b35],
    categorical: [0x0072b2, 0xe69f00, 0x56b4e9, 0xf0e442, 0x8c6bb1, 0x009e73, 0xd9a066, 0xa4a4a4],
  },
  protanopia: {
    id: 'protanopia',
    label: 'Protanopia',
    sequential: [0x1b365d, 0x3977a8, 0x70a5d1, 0xe5c65a, 0xf3efe0],
    categorical: [0x225ea8, 0xf0c808, 0x41b6c4, 0x88419d, 0xf2e394, 0x2c7fb8, 0xbdbdbd, 0x5b5b5b],
  },
  tritanopia: {
    id: 'tritanopia',
    label: 'Tritanopia',
    sequential: [0x3b1f5c, 0x8c3b76, 0xd35f5f, 0xf29e4c, 0xf7e6ad],
    categorical: [0x7a5195, 0xef5675, 0xff764a, 0xffa600, 0x4c78a8, 0xb279a2, 0x9d755d, 0xbab0ac],
  },
}

export interface OverlayLegendBand {
  readonly label: string
  readonly colour: number
  readonly pattern: OverlayPattern
}

export function overlayLegendBands(
  mode: PrdOverlayMode,
  paletteId: OverlayPaletteId,
): readonly OverlayLegendBand[] {
  const definition = OVERLAY_MODE_DEFINITIONS[mode]
  const palette = OVERLAY_PALETTES[paletteId]
  if (mode === 'fogOfWar') {
    return [
      {
        label: 'Hidden · clear areas are visible',
        colour: palette.categorical[0],
        pattern: overlayCategoricalPattern(0),
      },
    ]
  }
  if (definition.scale === 'categorical') {
    return palette.categorical.slice(0, 4).map((colour, index) => ({
      label:
        mode === 'power'
          ? (['Disconnected', 'Live', 'Browned out', 'Branch 4+'][index] ??
            `State ${String(index + 1)}`)
          : `Category ${String(index + 1)}`,
      colour,
      pattern: overlayCategoricalPattern(index),
    }))
  }

  const middleLabel =
    mode === 'roomGrade'
      ? 'Grade 5'
      : mode === 'temperature'
        ? 'Mild'
        : mode === 'cleanliness'
          ? 'Used'
          : 'Medium'
  return [
    {
      label: definition.lowLabel,
      colour: palette.sequential[0],
      pattern: 'dots',
    },
    {
      label: middleLabel,
      colour: palette.sequential[2],
      pattern: 'diagonal',
    },
    {
      label: definition.highLabel,
      colour: palette.sequential[4],
      pattern: 'solid',
    },
  ]
}

export interface OverlayFireTile {
  readonly index: number
  readonly intensity: number
  readonly smoke: number
}

export interface OverlayTunnel {
  readonly id: number
  readonly originTile: number
  readonly tiles: readonly number[]
}

export interface OverlayLayerOptions {
  readonly mapSize: number
  readonly palette?: OverlayPaletteId
}

const OVERLAY_PATTERNS: readonly OverlayPattern[] = ['solid', 'diagonal', 'dots', 'crosshatch']
const MAX_PALETTE_COLOURS = 8

/**
 * Combines eight colours with four patterns. Advancing the pattern phase when
 * the colour cycle wraps keeps the first 32 categories visually distinct.
 */
export function overlayCategoricalPattern(categoryIndex: number): OverlayPattern {
  const safeIndex = Math.max(0, Math.floor(categoryIndex))
  const patternIndex = (safeIndex + Math.floor(safeIndex / MAX_PALETTE_COLOURS)) % 4
  return OVERLAY_PATTERNS[patternIndex] ?? 'solid'
}

const OVERLAY_VERTEX_SOURCE = `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uTileSize;

in vec2 aPosition;
out vec2 vTile;

void main(void) {
    mat3 modelViewProjection = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((modelViewProjection * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vTile = aPosition / uTileSize;
}
`

const OVERLAY_FRAGMENT_SOURCE = `precision highp float;

uniform sampler2D uOverlayData;
uniform sampler2D uOverlayPalette;
uniform vec2 uMapSize;
uniform float uCategorical;
uniform float uInverse;
uniform float uOpacity;

in vec2 vTile;
out vec4 finalColor;

float patternCoverage(float pattern, vec2 within) {
    vec2 cell = floor(within * 8.0);
    float diagonal = step(5.5, mod(cell.x + cell.y, 8.0));
    vec2 dotCell = mod(cell, 4.0);
    float dots = step(length(dotCell - vec2(1.5)), 1.15);
    float crosshatch = max(
        step(6.5, mod(cell.x + cell.y, 8.0)),
        step(6.5, mod(cell.x - cell.y + 8.0, 8.0))
    );
    if (pattern < 0.5) return 1.0;
    if (pattern < 1.5) return 0.28 + diagonal * 0.72;
    if (pattern < 2.5) return 0.22 + dots * 0.78;
    return 0.30 + crosshatch * 0.70;
}

void main(void) {
    vec2 tile = floor(vTile);
    vec4 sampledData = texture(uOverlayData, (tile + 0.5) / uMapSize);
    if (sampledData.a < 0.01) {
        finalColor = vec4(0.0);
        return;
    }

    float raw = floor(sampledData.r * 255.0 + 0.5);
    float normalised = clamp((raw - 1.0) / 254.0, 0.0, 1.0);
    if (uInverse > 0.5) normalised = 1.0 - normalised;

    float band;
    float pattern;
    if (uCategorical > 0.5) {
        float category = max(raw - 1.0, 0.0);
        band = mod(category, 8.0);
        pattern = mod(category + floor(category / 8.0), 4.0);
    } else {
        band = min(floor(normalised * 5.0), 4.0);
        pattern = 2.0 - min(floor(normalised * 3.0), 2.0);
    }

    vec4 colour = texture(uOverlayPalette, vec2((band + 0.5) / 8.0, 0.5));
    float coverage = patternCoverage(pattern, fract(vTile));
    float valueAlpha = uCategorical > 0.5 ? 1.0 : (0.46 + normalised * 0.54);
    float alpha = sampledData.a * coverage * valueAlpha * uOpacity;
    finalColor = vec4(colour.rgb * alpha, alpha);
}
`

function validateMapData(mapSize: number, data: Uint8Array): void {
  const expected = mapSize * mapSize
  if (data.length !== expected) {
    throw new RangeError(`overlay data must hold ${expected} values, received ${data.length}`)
  }
}

function writeColour(target: Uint8Array, index: number, colour: number): void {
  const at = index * 4
  target[at] = (colour >> 16) & 0xff
  target[at + 1] = (colour >> 8) & 0xff
  target[at + 2] = colour & 0xff
  target[at + 3] = 255
}

export class OverlayLayer {
  readonly container: Container
  readonly mapSize: number

  readonly #mesh: Mesh<Geometry, Shader>
  readonly #geometry: Geometry
  readonly #shader: Shader
  readonly #data: Uint8Array
  readonly #dataSource: BufferImageSource
  readonly #paletteData = new Uint8Array(MAX_PALETTE_COLOURS * 4)
  readonly #paletteSource: BufferImageSource
  readonly #uniforms: {
    uCategorical: number
    uInverse: number
    uOpacity: number
  }

  #mode: OverlayMode = 'off'
  #paletteId: OverlayPaletteId
  #sectorIds: Uint16Array | null = null
  #dirty = false

  constructor(options: OverlayLayerOptions) {
    const { mapSize } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }
    this.mapSize = mapSize
    this.#paletteId = options.palette ?? 'standard'

    this.#data = new Uint8Array(mapSize * mapSize * 4)
    this.#dataSource = new BufferImageSource({
      resource: this.#data,
      width: mapSize,
      height: mapSize,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
      label: 'blockwork-overlay-data',
    })
    this.#paletteSource = new BufferImageSource({
      resource: this.#paletteData,
      width: MAX_PALETTE_COLOURS,
      height: 1,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
      alphaMode: 'no-premultiply-alpha',
      label: 'blockwork-overlay-palette',
    })

    this.#uniforms = { uCategorical: 0, uInverse: 0, uOpacity: 0.66 }
    this.#shader = Shader.from({
      gl: {
        name: 'blockwork-overlay',
        vertex: OVERLAY_VERTEX_SOURCE,
        fragment: OVERLAY_FRAGMENT_SOURCE,
      },
      resources: {
        uOverlayData: this.#dataSource,
        uOverlayPalette: this.#paletteSource,
        overlayUniforms: {
          uTileSize: { value: TILE_SIZE, type: 'f32' },
          uMapSize: { value: new Float32Array([mapSize, mapSize]), type: 'vec2<f32>' },
          uCategorical: { value: this.#uniforms.uCategorical, type: 'f32' },
          uInverse: { value: this.#uniforms.uInverse, type: 'f32' },
          uOpacity: { value: this.#uniforms.uOpacity, type: 'f32' },
        },
      },
    })

    const worldSize = mapSize * TILE_SIZE
    this.#geometry = new Geometry({
      label: 'blockwork-overlay-quad',
      attributes: {
        aPosition: {
          buffer: new Float32Array([0, 0, worldSize, 0, worldSize, worldSize, 0, worldSize]),
          format: 'float32x2',
          stride: 2 * Float32Array.BYTES_PER_ELEMENT,
          offset: 0,
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
      topology: 'triangle-list',
    })
    this.#mesh = new Mesh<Geometry, Shader>({
      label: 'blockwork-overlay',
      geometry: this.#geometry,
      shader: this.#shader,
    })
    this.container = new Container({ label: 'overlay' })
    this.container.addChild(this.#mesh)
    this.container.visible = false
    this.#writePalette()
  }

  get mode(): OverlayMode {
    return this.#mode
  }

  get paletteId(): OverlayPaletteId {
    return this.#paletteId
  }

  /** A visible layer owns exactly one mesh, hence exactly one draw call. */
  get drawCallCount(): 0 | 1 {
    return this.container.visible ? 1 : 0
  }

  /** Exposed for focused tests and diagnostics, not as mutable storage. */
  get dataTextureBytes(): Uint8Array {
    return this.#data.slice()
  }

  setMode(mode: OverlayMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    this.container.visible = mode !== 'off'
    // Worker replies are asynchronous. Clear the previous mode's texture now
    // so stale values are never shown under the new legend or uniforms.
    this.#data.fill(0)
    this.#dirty = true
    this.#applyModeUniforms()
    if (mode === 'sectors' && this.#sectorIds !== null) this.#packSectorIds()
  }

  setPalette(paletteId: OverlayPaletteId): void {
    if (this.#paletteId === paletteId) return
    this.#paletteId = paletteId
    this.#writePalette()
  }

  /**
   * Replaces the active map values. Zero means "do not paint"; 1..255 span
   * the mode's scale. This one-byte public format keeps worker transfers at
   * one quarter of the GPU texture size.
   */
  setData(values: Uint8Array): void {
    validateMapData(this.mapSize, values)
    this.#data.fill(0)
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i] ?? 0
      if (value === 0) continue
      const at = i * 4
      this.#data[at] = value
      this.#data[at + 3] = 255
    }
    this.#dirty = true
  }

  setSectorIds(sectorIds: Uint16Array): void {
    validateMapData(
      this.mapSize,
      new Uint8Array(sectorIds.buffer, sectorIds.byteOffset, sectorIds.length),
    )
    this.#sectorIds = sectorIds
    if (this.#mode === 'sectors') this.#packSectorIds()
  }

  /** Kept as a source-compatible no-op: T6.1 palettes own sector safety. */
  setSectorColours(
    _colours: ReadonlyMap<number, number> | Readonly<Record<number, number>>,
  ): void {}

  setFire(tiles: readonly OverlayFireTile[]): void {
    if (this.#mode !== 'fire') return
    const values = new Uint8Array(this.mapSize * this.mapSize)
    for (const tile of tiles) {
      if (tile.index < 0 || tile.index >= values.length) continue
      values[tile.index] = Math.max(tile.intensity, Math.round(tile.smoke * 0.6))
    }
    this.setData(values)
  }

  setTunnels(tunnels: readonly OverlayTunnel[]): void {
    if (this.#mode !== 'tunnels') return
    const values = new Uint8Array(this.mapSize * this.mapSize)
    for (const tunnel of tunnels) {
      for (const index of tunnel.tiles) {
        if (index >= 0 && index < values.length) values[index] = 255
      }
      if (tunnel.originTile >= 0 && tunnel.originTile < values.length) {
        values[tunnel.originTile] = 192
      }
    }
    this.setData(values)
  }

  markDirty(): void {
    if (this.#mode === 'sectors' && this.#sectorIds !== null) this.#packSectorIds()
  }

  sync(_camera: Camera): void {
    if (!this.#dirty) return
    this.#dirty = false
    this.#dataSource.update()
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.#geometry.destroy(true)
    this.#shader.destroy(true)
    this.#dataSource.destroy()
    this.#paletteSource.destroy()
  }

  #packSectorIds(): void {
    const ids = this.#sectorIds
    if (ids === null) return
    const orderedIds = [...new Set(ids)].filter((id) => id > 0).sort((a, b) => a - b)
    const ordinalById = new Map(orderedIds.map((id, index) => [id, index + 1]))
    const values = new Uint8Array(ids.length)
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i] ?? 0
      values[i] = id === 0 ? 0 : (ordinalById.get(id) ?? 0)
    }
    this.setData(values)
  }

  #applyModeUniforms(): void {
    const definition =
      this.#mode === 'off' || this.#mode === 'fire' || this.#mode === 'tunnels'
        ? null
        : OVERLAY_MODE_DEFINITIONS[this.#mode]
    const categorical = definition?.scale === 'categorical' || this.#mode === 'tunnels' ? 1 : 0
    const inverse = definition?.scale === 'inverse' ? 1 : 0
    const group = this.#shader.resources['overlayUniforms'] as {
      uniforms: { uCategorical: number; uInverse: number; uOpacity: number }
    }
    group.uniforms.uCategorical = categorical
    group.uniforms.uInverse = inverse
    group.uniforms.uOpacity = this.#mode === 'fogOfWar' ? 0.82 : 0.66
    this.#writePalette()
  }

  #writePalette(): void {
    const palette = OVERLAY_PALETTES[this.#paletteId]
    this.#paletteData.fill(0)
    const colours =
      this.#mode !== 'off' &&
      this.#mode !== 'fire' &&
      this.#mode !== 'tunnels' &&
      OVERLAY_MODE_DEFINITIONS[this.#mode].scale === 'categorical'
        ? palette.categorical
        : palette.sequential
    colours.forEach((colour, index) => {
      writeColour(this.#paletteData, index, colour)
    })
    this.#paletteSource.update()
  }
}

/** Parses `#rgb` / `#rrggbb` into `0xRRGGBB`, or null. */
export function parseCssColour(value: string): number | null {
  const raw = value.trim()
  if (!raw.startsWith('#')) return null
  const hex = raw.slice(1)
  if (hex.length === 3) {
    const parts = [...hex].map((digit) => Number.parseInt(digit + digit, 16))
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
    return ((parts[0] ?? 0) << 16) | ((parts[1] ?? 0) << 8) | (parts[2] ?? 0)
  }
  if (hex.length === 6 && /^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16)
  return null
}
