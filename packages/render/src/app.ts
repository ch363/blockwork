/**
 * The renderer's composition root: one Pixi application, one camera, one
 * gesture controller, and the world container the layers hang off.
 *
 * The scene graph is deliberately shallow:
 *
 *     stage
 *       └── world          camera transform lives here, and only here
 *             ├── terrain   (PRD 7.6 layer 1)
 *             ├── walls     (PRD 7.6 layer 2: walls + doors)
 *             ├── objects   (PRD 7.6 layer 3)
 *             ├── agents    (PRD 7.6 layer 4)
 *             ├── blueprint (staged build overlay)
 *             └── grid      tile lattice and map boundary
 *
 * Layers 5 to 6 of PRD 7.6 — overlays, effects — are later tickets and are
 * deliberately not stubbed in. Selection rings and mood pins live on the
 * agents layer (T2.8) rather than waiting for the effects pass.
 *
 * **Why the camera is a container transform.** Nothing in a layer knows where
 * the camera is. The world container carries a scale and a translation, and
 * every layer positions its geometry in world units and forgets about the
 * viewport. Layers still read the camera, but only to ask what is visible so
 * they can cull; none of them transform anything by hand.
 *
 * **Resolution.** `devicePixelRatio` is 2 on every iPad and 3 on some phones.
 * Rendering at 3x costs 2.25 times the fragments of 2x for a difference no one
 * can see at arm's length, so it is capped (PRD 7.5's frame budget).
 *
 * **Renderer backend.** WebGL, explicitly. It is already Pixi's own default
 * preference, and WebGL 2 is the one backend guaranteed present in the
 * iPadOS webview this ships in; pinning it means the terrain shader has a
 * single dialect to be correct in rather than two, one of which cannot be
 * exercised on the target device today.
 */

import { Application, Container } from 'pixi.js'

import { Camera } from './camera/camera'
import { GestureController } from './camera/gestures'
import { ToolInputController } from './camera/toolInput'
import { AgentLayer, createAgentAtlas } from './layers/agents'
import { BlueprintLayer } from './layers/blueprint'
import { GridLayer } from './layers/grid'
import { ObjectLayer, createObjectAtlas } from './layers/objects'
import { PLACEHOLDER_TERRAIN_PALETTE, TerrainLayer, createTerrainAtlas } from './layers/terrain'
import type { TerrainTileAppearance } from './layers/terrain'
import { WallLayer, createDoorAtlas, createWallShapeAtlas, wallPalette } from './layers/walls'
import type { WallAppearance } from './layers/walls'
import { TILE_SIZE } from './tiles'

/** `--bg-void` from `docs/04-ui-mockups.html`: the letterbox behind the map. */
export const LETTERBOX_COLOUR = 0x0d1015

/** Beyond 2x the extra fragments buy nothing at iPad viewing distance. */
export const MAX_RENDER_RESOLUTION = 2

export interface BlockworkRendererOptions {
  /** The canvas is created and appended here, and sized to it. */
  readonly parent: HTMLElement
  /** Map edge in tiles. The map is square (PRD 4.3). */
  readonly mapSize: number
  /** Overrides the placeholder floor palette. Index 0 is bare ground. */
  readonly palette?: readonly TerrainTileAppearance[]
  /**
   * Material ids in index order, matching `MaterialTable.ids()`. Used to
   * colour walls. When omitted, walls stay uncoloured until `setWallPalette`.
   */
  readonly wallMaterialIds?: readonly string[]
  readonly wallAppearances?: Readonly<Record<string, WallAppearance>>
  readonly backgroundColour?: number
  readonly maxResolution?: number
  /** Starting zoom. Defaults to 1, where one tile is 32 CSS pixels. */
  readonly zoom?: number
  /**
   * Disables camera easing for PRD 7.9's Reduce Motion. Defaults to the
   * `prefers-reduced-motion` media query.
   */
  readonly reducedMotion?: boolean
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export class BlockworkRenderer {
  readonly app: Application
  readonly camera: Camera
  readonly gestures: GestureController
  /** Build-tool strokes in tile coordinates. Inert until `active` is set. */
  readonly tools: ToolInputController
  readonly world: Container
  readonly terrain: TerrainLayer
  readonly walls: WallLayer
  readonly objects: ObjectLayer
  readonly agents: AgentLayer
  readonly blueprint: BlueprintLayer
  readonly grid: GridLayer
  /** Map edge in tiles. */
  readonly mapSize: number

  #viewportWidth: number
  #viewportHeight: number
  #destroyed = false

  private constructor(
    app: Application,
    camera: Camera,
    mapSize: number,
    terrain: TerrainLayer,
    walls: WallLayer,
    objects: ObjectLayer,
    agents: AgentLayer,
    blueprint: BlueprintLayer,
    grid: GridLayer,
  ) {
    this.app = app
    this.camera = camera
    this.mapSize = mapSize
    this.terrain = terrain
    this.walls = walls
    this.objects = objects
    this.agents = agents
    this.blueprint = blueprint
    this.grid = grid

    this.world = new Container({ label: 'world' })
    this.world.addChild(
      terrain.container,
      walls.container,
      objects.container,
      agents.container,
      blueprint.container,
      grid.container,
    )
    app.stage.addChild(this.world)

    this.#viewportWidth = app.screen.width
    this.#viewportHeight = app.screen.height

    this.gestures = new GestureController({ target: app.canvas, camera })
    this.gestures.attach()

    this.tools = new ToolInputController({ target: app.canvas, camera, mapSize })
    this.tools.attach()

    app.ticker.add(this.#frame)
  }

  /**
   * Boots the renderer. Async because `Application.init` negotiates a GPU
   * context; nothing else in the render package is.
   */
  static async create(options: BlockworkRendererOptions): Promise<BlockworkRenderer> {
    const { parent, mapSize } = options
    if (!Number.isInteger(mapSize) || mapSize < 1) {
      throw new RangeError(`mapSize must be a positive integer, received ${mapSize}`)
    }

    const app = new Application()
    await app.init({
      resizeTo: parent,
      preference: 'webgl',
      resolution: Math.min(
        globalThis.devicePixelRatio || 1,
        options.maxResolution ?? MAX_RENDER_RESOLUTION,
      ),
      autoDensity: true,
      // Terrain is a grid of axis-aligned quads. Multisampling it costs
      // fragments and smooths nothing.
      antialias: false,
      powerPreference: 'high-performance',
      backgroundColor: options.backgroundColour ?? LETTERBOX_COLOUR,
    })

    parent.appendChild(app.canvas)

    const worldSize = mapSize * TILE_SIZE
    const camera = new Camera({
      worldWidth: worldSize,
      worldHeight: worldSize,
      viewportWidth: app.screen.width,
      viewportHeight: app.screen.height,
      ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
      easing: !(options.reducedMotion ?? prefersReducedMotion()),
    })

    const atlas = createTerrainAtlas(options.palette ?? PLACEHOLDER_TERRAIN_PALETTE)
    const terrain = new TerrainLayer({ mapSize, atlas })
    const walls = new WallLayer({
      mapSize,
      shapes: createWallShapeAtlas(),
      doors: createDoorAtlas(),
      palette: wallPalette(options.wallMaterialIds ?? ['none'], options.wallAppearances),
    })
    const objects = new ObjectLayer({ mapSize, atlas: createObjectAtlas() })
    const agents = new AgentLayer({ mapSize, atlas: createAgentAtlas() })
    const blueprint = new BlueprintLayer({ mapSize })
    const grid = new GridLayer({ mapSize })

    return new BlockworkRenderer(
      app,
      camera,
      mapSize,
      terrain,
      walls,
      objects,
      agents,
      blueprint,
      grid,
    )
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas
  }

  /**
   * Hands the layer the simulation's floor materials. The array is not copied;
   * report later edits with `markFloorsDirty`.
   */
  setFloors(floorMaterial: Uint8Array): void {
    this.terrain.setFloors(floorMaterial)
  }

  /** Marks a tile rectangle as needing a terrain rebuild. */
  markFloorsDirty(tileX: number, tileY: number, width: number, height: number): void {
    this.terrain.markDirtyRect(tileX, tileY, width, height)
  }

  /**
   * Hands the layer the simulation's wall materials. The array is not copied;
   * report later edits with `markWallsDirty`.
   */
  setWalls(wallMaterial: Uint8Array): void {
    this.walls.setWalls(wallMaterial)
  }

  markWallsDirty(tileX: number, tileY: number, width: number, height: number): void {
    this.walls.markDirtyRect(tileX, tileY, width, height)
  }

  /**
   * Marks a tile rectangle stale in every layer that reads tile data.
   *
   * What a host calls when the simulation reports a changed chunk: the chunk
   * carries floors and walls together and the caller has no reason to know
   * which of the two moved.
   */
  markTilesDirty(tileX: number, tileY: number, width: number, height: number): void {
    this.terrain.markDirtyRect(tileX, tileY, width, height)
    this.walls.markDirtyRect(tileX, tileY, width, height)
  }

  setWallPalette(
    materialIds: readonly string[],
    appearances?: Readonly<Record<string, WallAppearance>>,
  ): void {
    this.walls.setPalette(wallPalette(materialIds, appearances))
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true

    this.app.ticker.remove(this.#frame)
    this.gestures.detach()
    this.tools.detach()
    this.terrain.destroy()
    this.walls.destroy()
    this.objects.destroy()
    this.agents.destroy()
    this.blueprint.destroy()
    this.grid.destroy()
    this.app.destroy({ removeView: true }, { children: true })
  }

  /**
   * One frame: advance the camera, push it onto the world transform, then let
   * each layer decide what it has to rebuild. Registered at the ticker's
   * default priority, which runs before Pixi's own render callback.
   */
  readonly #frame = (ticker: { deltaMS: number }): void => {
    const { width, height } = this.app.screen
    if (width !== this.#viewportWidth || height !== this.#viewportHeight) {
      this.#viewportWidth = width
      this.#viewportHeight = height
      this.camera.resize(width, height)
    }

    this.camera.update(ticker.deltaMS)

    const { zoom } = this.camera
    this.world.scale.set(zoom)
    this.world.position.set(width / 2 - this.camera.x * zoom, height / 2 - this.camera.y * zoom)

    this.terrain.update(this.camera)
    this.walls.update(this.camera)
    this.objects.update(this.camera)
    this.agents.update(this.camera)
    this.blueprint.update(zoom)
    this.grid.update(this.camera)
  }
}
