import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FORWARD_MARGIN } from "../../domain/geometry.ts";
import type { CabinLocation, LayoutRevision } from "../../domain/types.ts";
import { aggregateStatus, type LocationStatus, STATUS_ENCODING } from "../model.ts";
import { createEnvironment, ENVIRONMENT_INTENSITY, type LightMode } from "./environment.ts";
import { createOverlayMaterial, createSeatMaterials, type SeatMaps, STATUS_COLOUR, setGhosted, TIER_COLOUR, upholsteryVariant } from "./materials.ts";
import { createBadges, createFrame, createOutline, frameGeometry, HOVER_OUTLINE, hullGeometry, SELECTION_OUTLINE, type ViewportUniform } from "./outline.ts";
import { PickGesture, type PointerSample } from "./pickGesture.ts";
import { buildBinGeometry, buildSeatGeometries, SEAT, type SeatGeometries } from "./seatParts.ts";
import {
  BADGE_ATLAS_SIZE,
  BADGE_GLYPHS,
  BIN_DOOR_TEXTURE_SIZE,
  backFrontTexture,
  binDoorTexture,
  CARPET_TEXTURE_SIZE,
  CONTACT_TEXTURE_SIZE,
  cachedTextureBytes,
  carpetTexture,
  contactTexture,
  disposeTextureCache,
  getTexture,
  PALETTES,
  type ProfilePalette,
  panTexture,
  REAR_SHELL_POWER_PANEL,
  rearShellTexture,
  SEAT_NORMAL_STRENGTH,
  SEAT_TEXTURE_SIZE,
  SERVICE_UNIT_TEXTURE_SIZE,
  type SeatSurface,
  SIDEWALL_TEXTURE_SIZE,
  seatNormalTexture,
  seatRoughnessTexture,
  serviceUnitTexture,
  sidewallTexture,
  statusBadgeAtlas,
  textureKey,
} from "./textures.ts";

export type { LocationStatus } from "../model.ts";
export type { LightMode } from "./environment.ts";

export interface LocationState {
  /** status per component id; a location with no entry shows no status */
  components: Record<string, LocationStatus>;
}
export type ColourMode = "status" | "tier" | "none";
/** A preset view, or "free" once the user has moved the camera by hand (orbit, pan, zoom or a nudge). */
export type CameraView = "cutaway" | "overhead" | "aisle" | "focus" | "focus-rear" | "carpet" | "bins" | "free";
export interface Layers {
  seats: boolean;
  floor: boolean;
  bins: boolean;
  context: boolean;
}
export interface SceneCallbacks {
  onPick(locationId: string, componentId: string | null): void;
  /** the hovered location's label and the pointer's position in the canvas (CSS pixels), or null when nothing is hovered */
  onHover(hover: { label: string; x: number; y: number } | null): void;
  onContextLost(): void;
}

/** Bin doors are pale: a status tints them halfway from white toward its colour. */
const BIN_STATUS_COLOUR = {
  recorded: STATUS_COLOUR.recorded.clone().lerp(new THREE.Color("#ffffff"), 0.5),
  unresolved: STATUS_COLOUR.unresolved.clone().lerp(new THREE.Color("#ffffff"), 0.5),
  alternate: STATUS_COLOUR.alternate.clone().lerp(new THREE.Color("#ffffff"), 0.5),
};
/** The `--select` token in styles.css. */
const SELECT_COLOUR = "#ffc531";
/** Floor frames: selection 10 cm in the select colour; hover 6 cm of white with 2 cm of ink inside it. */
const SELECTION_FRAME = [{ width: 0.1, colour: SELECT_COLOUR }] as const;
const HOVER_FRAME = [
  { width: 0.06, colour: HOVER_OUTLINE.colour },
  { width: 0.02, colour: HOVER_OUTLINE.inner.colour },
] as const;
/** A ghosted bin hides nothing behind it, so its outline would show as a solid shape: it is drawn see-through instead. */
const GHOSTED_OUTLINE_OPACITY = 0.45;
/** Where a seat's badge sits: above the top of the headrest, in seat coordinates. */
const BADGE_ABOVE_HEADREST = 0.075;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color("#ffffff");
const FULL_CABIN = "FLOOR:FULL-CABIN";

interface SeatEntry {
  location: CabinLocation;
  matrix: THREE.Matrix4;
}

/** One status badge: where it sits and the layer that shows it. */
interface BadgeEntry {
  locationId: string;
  layer: "seats" | "floor" | "bins";
  matrix: THREE.Matrix4;
}

/** The marks for one kind of highlight: a hull for seats and bins, a flat frame for floor areas. */
interface Marks {
  hull: THREE.Mesh;
  frame: THREE.Mesh;
  rings: readonly { width: number; colour: string }[];
  /** the location outlined, null when the marks are hidden */
  location: CabinLocation | null;
}

/** The palette colours a material can follow; applyProfile() sets each such material's colour from the palette. */
type PaletteColour = "aisleBorder";

/** Seat parts drawn as one instanced mesh each; applyPalette() gives each its material for the visual family. */
type SeatPart = "legs" | "pan" | "backCore" | "backFront" | "rearShell" | "rearRelief" | "headrest" | "arms" | "armPads" | "wings";

/** Light that is not the environment: a key from the window side, and a blue-tinted fill in blue cabin light only. */
interface CabinLights {
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
}

/** How often each update ran, for the e2e build's describeScene(): a recorded replacement must not rebuild the layout or the profile. */
interface UpdateCounts {
  buildLayout: number;
  applyProfile: number;
  applyStates: number;
}

/** Set only by the e2e build (`npm run build:e2e`): the hooks below, and the drawing buffer they read, are absent from the shipped bundle. */
const TEST_HOOKS = import.meta.env.VITE_TEST_HOOKS === "1";

/** Test-only access to the scene, attached to the instance and to `window.__cabinKit` only when TEST_HOOKS is set. */
export interface SceneTestHooks {
  measure(durationMs: number): Promise<{ fps: number; frames: number; durationMs: number; worstFrameMs: number }>;
  screenPointOf(locationId: string, part?: "head" | "pan"): { x: number; y: number } | null;
  describeScene(): Record<string, unknown>;
  /** Times the next frame from now, for a selection made outside the canvas. */
  markInteraction(): void;
  /** time from a pick to the frame that shows it, most recent first */
  pickLatencies: number[];
}

type Disposable = { dispose(): void };

/** Owns GPU resources (geometries, materials, textures, render targets, instanced meshes) until disposeAll(), which releases each exactly once. */
export class ResourceTracker {
  private items = new Set<Disposable>();

  track<T extends Disposable>(resource: T): T {
    this.items.add(resource);
    return resource;
  }

  /** disposeAll() on each tracker, even if an earlier one throws; the first error is rethrown after. */
  static disposeEach(...trackers: ResourceTracker[]): void {
    let failure: unknown;
    let failed = false;
    for (const tracker of trackers) {
      try {
        tracker.disposeAll();
      } catch (e) {
        if (!failed) failure = e;
        failed = true;
      }
    }
    if (failed) throw failure;
  }

  /** Disposes every tracked resource once and forgets them. A resource that throws does not stop the rest; the first error is rethrown after. */
  disposeAll(): void {
    const items = [...this.items];
    this.items.clear();
    let failure: unknown;
    let failed = false;
    for (const item of items) {
      try {
        item.dispose();
      } catch (e) {
        if (!failed) failure = e;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
}

/**
 * Interactive 3D cutaway of floors, seats and overhead bins.
 * Identities come straight from the layout revision: one instance per seat location, one mesh per
 * floor area, one instance per bin module. Geometry is an illustrative approximation.
 */
export class CabinScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.05, 400);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private geoms: SeatGeometries;
  private groups = { seats: new THREE.Group(), floor: new THREE.Group(), bins: new THREE.Group(), context: new THREE.Group(), marks: new THREE.Group() };
  private layers: Layers = { seats: true, floor: true, bins: true, context: false };
  private palette: ProfilePalette = PALETTES["photo-navy-band"];
  private light: LightMode = "neutral";
  private colourMode: ColourMode = "status";
  private layout: LayoutRevision | null = null;
  private seats: SeatEntry[] = [];
  private seatMeshes: { mesh: THREE.InstancedMesh; component: string | null }[] = [];
  private panOverlay: THREE.InstancedMesh | null = null;
  /** the headrest tint of the "Work status" colour mode */
  private headrestOverlay: THREE.InstancedMesh | null = null;
  private badges: THREE.InstancedMesh | null = null;
  private badgeEntries: BadgeEntry[] = [];
  /** the welded outline shape of a seat, made once */
  private seatHull: THREE.BufferGeometry;
  /** the outline shape of each side's bin module, made per layout */
  private binHulls: Partial<Record<"L" | "R", THREE.BufferGeometry>> = {};
  /** floor frames per location and mark kind, made on first use and released with the layout */
  private frames = new Map<string, THREE.BufferGeometry>();
  /** the canvas height in CSS pixels, read by the outline and badge shaders for their pixel minimums */
  private viewport: ViewportUniform = { value: 0 };
  private floorMeshes: { mesh: THREE.Mesh; locationId: string | null }[] = [];
  /** the aisle strip: the full-cabin floor's pick target; never drawn (its tint is an instance of floorTint) */
  private fullCabinOverlay: THREE.Mesh | null = null;
  /** every floor-area tint and the aisle strip's, as instances of one flat unit plane: one draw call (WEB-20) */
  private floorTint: THREE.InstancedMesh | null = null;
  private floorTintEntries: { locationId: string; matrix: THREE.Matrix4 }[] = [];
  private binSides: { side: "L" | "R"; door: THREE.InstancedMesh; body: THREE.InstancedMesh; locations: CabinLocation[]; extras: THREE.Object3D[] }[] = [];
  private contextSides: { side: "L" | "R"; wallMaterial: THREE.MeshStandardMaterial }[] = [];
  private states = new Map<string, LocationState>();
  private selection: string | null = null;
  private selectionMarks: Marks;
  private hoverMarks: Marks;
  /** the location the hover marks show, null when none */
  private hovered: string | null = null;
  private lights: CabinLights;
  /** one prefiltered environment per light mode, made on first use and kept (in sceneResources) until dispose() */
  private environments = new Map<LightMode, THREE.Texture>();
  /** everything the current layout built; released at the start of every buildLayout() */
  private layoutResources = new ResourceTracker();
  /** what the palette made for this layout: seat materials and the carpet copies (repeats); replaced by every palette change */
  private profileResources = new ResourceTracker();
  /** the palette the materials show; null makes the next applyProfile() apply it again */
  private appliedPalette: ProfilePalette | null = null;
  private paletteMaterials: { material: THREE.MeshStandardMaterial; colour: PaletteColour }[] = [];
  private seatParts: Partial<Record<SeatPart, THREE.InstancedMesh>> = {};
  private floorMaterials: { material: THREE.MeshStandardMaterial; lx: number; lz: number; offsetX: number }[] = [];
  /**
   * The pale wing faces are one instanced mesh of two instances per seat: the aisle-side wing (instance i) and the
   * window-side wing (instance n + i), which only families with both wings pale show. One draw call, not two (WEB-20).
   */
  private windowWingMatrices: THREE.Matrix4[] = [];
  /** whether the window-side wings are shown; null until the first palette */
  private windowWingsShown: boolean | null = null;
  private updates: UpdateCounts = { buildLayout: 0, applyProfile: 0, applyStates: 0 };
  /** scenes alive on the page; the last one to go releases the shared texture cache */
  private static liveScenes = 0;
  /** everything that lives as long as the scene; released in dispose() */
  private sceneResources = new ResourceTracker();
  /** set by the test hooks to record the frame that follows a pick */
  private onFrameRendered: (() => void) | null = null;
  /** the pending animation frame, 0 when none is requested */
  private frame = 0;
  /** true while a frame is being drawn: requests made during it are settled at its end */
  private inFrame = false;
  /** animation frames this scene has requested, for the idle check in the e2e build */
  private frameRequests = 0;
  /** advances the test hooks' measure() by one frame while it runs */
  private measureStep: (() => void) | null = null;
  /** rejects a running measure() when the scene is paused or the page hidden, so it never waits for frames that will not come */
  private measureAbort: (() => void) | null = null;
  private needsRender = true;
  private disposed = false;
  private readonly gesture = new PickGesture();
  private paused = false;
  private hoverPending: PointerEvent | null = null;
  private pickStamp: number | null = null;
  private currentView: CameraView = "cutaway";
  /** the location a focus view was framed on, so a resize re-frames the same one */
  private viewLocation: string | null = null;
  private pickableFloorBins = true;
  frameCount = 0;
  private canvas: HTMLCanvasElement;
  private callbacks: SceneCallbacks;

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: import.meta.env.VITE_TEST_HOOKS === "1",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.geoms = buildSeatGeometries();
    Object.values(this.geoms).forEach((g) => {
      this.sceneResources.track(g);
    });

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    // Any orbit, pan or zoom by hand leaves the preset: from then on a resize keeps the camera where the user put it (WEB-09).
    this.controls.addEventListener("start", () => {
      this.currentView = "free";
    });
    this.controls.addEventListener("change", () => {
      this.updateGhosting();
      this.invalidate();
    });

    // The environment (applyLight) does most of the lighting. The key comes in from the left (+z) windows, high and from
    // forward; the fill, used in blue cabin light only, from the other side.
    const key = new THREE.DirectionalLight("#ffffff", 1.4);
    key.position.set(-5, 9, 12);
    // Switched by intensity (0 in neutral light), not visibility: a light count change would recompile every material.
    const fill = new THREE.DirectionalLight("#6f86ff", 0);
    fill.position.set(8, 7, -10);
    this.lights = { key, fill };
    this.scene.add(key, fill);
    for (const g of Object.values(this.groups)) this.scene.add(g);

    // Selection and hover outlines (WEB-21). The seat outline is drawn from the parts that make its silhouette.
    const keep = <T extends Disposable>(resource: T): T => this.sceneResources.track(resource);
    const g = this.geoms;
    this.seatHull = keep(hullGeometry([g.pan, g.backCore, g.backFront, g.rearShell, g.headrest, g.arms]));
    const marks = (hull: THREE.Mesh, rings: Marks["rings"]): Marks => {
      keep(hull.material as THREE.Material);
      if (hull instanceof THREE.InstancedMesh) keep(hull);
      const frame = createFrame();
      keep(frame.material as THREE.Material);
      keep(frame.geometry);
      hull.visible = frame.visible = false;
      this.groups.marks.add(hull, frame);
      return { hull, frame, rings, location: null };
    };
    this.selectionMarks = marks(
      createOutline(this.seatHull, SELECT_COLOUR, SELECTION_OUTLINE.widthMetres, { minPixels: SELECTION_OUTLINE.minPixels, viewport: this.viewport }),
      SELECTION_FRAME,
    );
    this.hoverMarks = marks(
      createOutline(this.seatHull, HOVER_OUTLINE.colour, HOVER_OUTLINE.widthMetres, {
        minPixels: HOVER_OUTLINE.minPixels,
        inner: HOVER_OUTLINE.inner,
        viewport: this.viewport,
      }),
      HOVER_FRAME,
    );

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.applyProfile();
    this.resize();
    if (TEST_HOOKS) {
      const pickLatencies: number[] = [];
      this.onFrameRendered = () => {
        if (this.pickStamp === null) return;
        pickLatencies.unshift(performance.now() - this.pickStamp);
        pickLatencies.length = Math.min(pickLatencies.length, 50);
        this.pickStamp = null;
      };
      const hooks: SceneTestHooks = {
        pickLatencies,
        markInteraction: () => {
          this.pickStamp = performance.now();
        },
        /**
         * Orbit continuously for a while and report the measured frame rate. Each scheduled frame draws one step. A paused
         * scene or a hidden page draws no frames, so measure() rejects at once then, or as soon as either happens.
         */
        measure: (durationMs) =>
          new Promise((resolve, reject) => {
            const stopped = () => new Error("measure() needs a running scene: it is paused, hidden or disposed");
            if (this.paused || this.disposed || document.visibilityState === "hidden" || this.measureStep) {
              reject(this.measureStep ? new Error("measure() is already running") : stopped());
              return;
            }
            this.measureAbort = () => {
              this.measureStep = null;
              this.measureAbort = null;
              reject(stopped());
            };
            const start = performance.now();
            let frames = 0;
            let last = start;
            let worst = 0;
            this.measureStep = () => {
              const now = performance.now();
              if (now - start >= durationMs || this.disposed) {
                this.measureStep = null;
                this.measureAbort = null;
                resolve({ fps: (frames * 1000) / (now - start), frames, durationMs: now - start, worstFrameMs: worst });
                return;
              }
              worst = Math.max(worst, now - last);
              last = now;
              frames += 1;
              this.nudge(frames % 240 < 120 ? "left" : "right");
            };
            this.invalidate();
          }),
        /** Screen position of a location, used by tests to pick it with a real pointer event. */
        screenPointOf: (locationId, part = "head") => {
          const location = this.layout?.locations.find((l) => l.id === locationId);
          if (!location) return null;
          const { centre } = this.boxOf(location);
          // the headrest front is visible from the front and from above; the pan only from above
          if (location.kind === "SEAT") centre.set(location.placement.x + (part === "pan" ? -0.1 : 0.255), part === "pan" ? 0.52 : 1.06, location.placement.z);
          // the aisle centreline belongs to the full-cabin strip, so an area is aimed at beside it
          if (location.kind === "FLOOR") centre.set(location.placement.x, 0, location.id === FULL_CABIN ? 0 : location.placement.lz / 4);
          if (location.kind === "BIN") centre.set(location.placement.x, 1.75, (location.bin?.side === "L" ? 1 : -1) * 0.95);
          const v = centre.project(this.camera);
          const rect = this.canvas.getBoundingClientRect();
          return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
        },
        describeScene: () => ({
          seats: this.seats.length,
          floorAreas: this.floorMeshes.filter((f) => f.locationId).length,
          binModules: this.binSides.reduce((n, b) => n + b.locations.length, 0),
          profile: this.palette.id,
          light: this.light,
          view: this.currentView,
          paused: this.paused,
          layers: this.layers,
          colourMode: this.colourMode,
          selection: this.selection,
          camera: {
            position: this.camera.position.toArray().map((v) => Number(v.toFixed(3))),
            target: this.controls.target.toArray().map((v) => Number(v.toFixed(3))),
            fov: this.camera.fov,
          },
          renderer: {
            drawCalls: this.renderer.info.render.calls,
            triangles: this.renderer.info.render.triangles,
            pixelRatio: this.renderer.getPixelRatio(),
            geometries: this.renderer.info.memory.geometries,
            textures: this.renderer.info.memory.textures,
            /** estimate: cached textures (w × h × 4, + a third for mipmaps) and the environments (half-float RGBA) */
            textureBytes: cachedTextureBytes() + this.environmentBytes(),
          },
          marks: {
            selection: this.selectionMarks.hull.visible || this.selectionMarks.frame.visible,
            hover: this.hovered,
            badges: this.badges?.visible ? this.badges.count : 0,
          },
          frames: this.frameCount,
          frameRequests: this.frameRequests,
          framePending: this.frame !== 0,
          updates: { ...this.updates },
        }),
      };
      Object.assign(this, hooks);
    }
    CabinScene.liveScenes += 1;
    this.invalidate();
  }

  // ---- construction ---------------------------------------------------------------------------

  /** Remove a layout group's children from the scene. Their GPU resources belong to layoutResources, which buildLayout() releases. */
  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) group.remove(child);
  }

  /**
   * Show a layout revision. The same revision again (every save answers with a new object for it) changes nothing, so the
   * camera stays where it is (WEB-01); only a different revision is framed afresh.
   */
  setLayout(layout: LayoutRevision, pickableFloorBins: boolean): void {
    const sameRevision = this.layout?.id === layout.id;
    if (sameRevision && this.pickableFloorBins === pickableFloorBins) return;
    this.layout = layout;
    this.pickableFloorBins = pickableFloorBins;
    this.buildLayout();
    if (!sameRevision) this.setCamera("cutaway");
  }

  /**
   * Build everything that depends on the layout (WEB-20): instanced meshes and their matrices, floor, bins and context.
   * Runs only when the layout revision or pickability changes. Colours and maps come from applyProfile(), instance
   * colours from applyStates(), both called at the end.
   */
  private buildLayout(): void {
    const layout = this.layout;
    if (!layout) return;
    this.updates.buildLayout += 1;
    this.clearGroup(this.groups.seats);
    this.clearGroup(this.groups.floor);
    this.clearGroup(this.groups.bins);
    this.clearGroup(this.groups.context);
    this.layoutResources.disposeAll();
    this.seatMeshes = [];
    this.floorMeshes = [];
    this.floorTintEntries = [];
    this.binSides = [];
    this.contextSides = [];
    this.paletteMaterials = [];
    this.floorMaterials = [];
    this.seatParts = {};
    this.windowWingMatrices = [];
    this.windowWingsShown = null;
    this.binHulls = {};
    this.frames.clear();
    if (this.badges) this.groups.marks.remove(this.badges);
    this.badges = null;
    this.badgeEntries = [];
    // the marks may show geometry of the layout released above
    this.hovered = null;
    for (const m of [this.selectionMarks, this.hoverMarks]) m.hull.visible = m.frame.visible = false;
    const own = <T extends Disposable>(resource: T): T => this.layoutResources.track(resource);
    const length = layout.geometry.cabinLength;
    const halfW = layout.geometry.cabinHalfWidth;
    const rows = layout.rows.filter((r) => r.exists).length;

    // seats ------------------------------------------------------------------------------------
    this.seats = layout.locations
      .filter((l) => l.kind === "SEAT")
      .map((location) => ({ location, matrix: new THREE.Matrix4().makeTranslation(location.placement.x, 0, location.placement.z) }));
    const n = this.seats.length;
    const std = (color: string, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
      own(new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
    // a material whose colour follows the visual family; applyProfile() sets it
    const paletteStd = (colour: PaletteColour, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const material = std("#ffffff", roughness, metalness, extra);
      this.paletteMaterials.push({ material, colour });
      return material;
    };
    // Seat parts get their materials for the visual family from applyPalette(); until then they share this one.
    const unpainted = own(new THREE.MeshBasicMaterial());
    const addSeatMesh = (
      part: SeatPart,
      geometry: THREE.BufferGeometry,
      component: string | null,
      matrices: THREE.Matrix4[] = this.seats.map((s) => s.matrix),
    ) => {
      if (n === 0) return null;
      const mesh = own(new THREE.InstancedMesh(geometry, unpainted, matrices.length));
      matrices.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.groups.seats.add(mesh);
      this.seatMeshes.push({ mesh, component });
      this.seatParts[part] = mesh;
      return mesh;
    };
    addSeatMesh("legs", this.geoms.legs, null);
    addSeatMesh("pan", this.geoms.pan, "CUSHION");
    addSeatMesh("backCore", this.geoms.backCore, "BACKREST");
    addSeatMesh("backFront", this.geoms.backFront, "BACKREST");
    addSeatMesh("rearShell", this.geoms.rearShell, "BACKREST");
    addSeatMesh("rearRelief", this.geoms.rearRelief, "BACKREST");
    addSeatMesh("headrest", this.geoms.headrest, "BACKREST");
    addSeatMesh("arms", this.geoms.arms, null);
    addSeatMesh("armPads", this.geoms.armPads, null);
    // Pale wing faces: the aisle-side wing always, the window-side wing only in the banded family. Both are built for
    // every family; applyPalette() shows or hides the window-side ones, so a family change does no geometry work.
    const mirror = new THREE.Matrix4().makeScale(1, 1, -1);
    const aisleSide = this.seats.map((s) => (s.location.placement.z > 0 ? s.matrix.clone().multiply(mirror) : s.matrix));
    this.windowWingMatrices = this.seats.map((s) => (s.location.placement.z > 0 ? s.matrix : s.matrix.clone().multiply(mirror)));
    addSeatMesh("wings", this.geoms.wingFace, "BACKREST", [...aisleSide, ...this.windowWingMatrices]);
    // (the pale surround of the banded family is the upper-back band itself, drawn in the texture)

    // Contact shading: a soft dark patch on the carpet under every seat grounds it, without shadow maps (WEB-21). It is
    // drawn before the floor status overlays and never picked.
    if (n > 0) {
      const contact = own(
        new THREE.InstancedMesh(
          this.geoms.contact,
          own(
            new THREE.MeshBasicMaterial({
              map: getTexture(textureKey("contact", "shared", CONTACT_TEXTURE_SIZE), contactTexture),
              transparent: true,
              depthWrite: false,
            }),
          ),
          n,
        ),
      );
      this.seats.forEach((seat, i) => {
        contact.setMatrixAt(i, seat.matrix);
      });
      contact.instanceMatrix.needsUpdate = true;
      contact.computeBoundingSphere();
      contact.renderOrder = 3;
      this.groups.seats.add(contact);
    }

    // The tier tint covers the pan. The status tint covers the headrest only, so the upholstery stays visible (WEB-21);
    // it is drawn over the headrest itself, pulled toward the camera so it never fights it in the depth buffer.
    this.panOverlay = n ? own(new THREE.InstancedMesh(this.geoms.panOverlay, own(createOverlayMaterial(0.6)), n)) : null;
    const headrestTint = own(createOverlayMaterial(0.6));
    headrestTint.polygonOffset = true;
    headrestTint.polygonOffsetFactor = -1;
    headrestTint.polygonOffsetUnits = -4;
    this.headrestOverlay = n ? own(new THREE.InstancedMesh(this.geoms.headrest, headrestTint, n)) : null;
    for (const o of [this.panOverlay, this.headrestOverlay]) {
      if (!o) continue;
      o.renderOrder = 5;
      o.setColorAt(0, WHITE);
      this.groups.seats.add(o);
    }
    // badges above each headrest
    this.geoms.headrest.computeBoundingBox();
    const head = this.geoms.headrest.boundingBox ?? new THREE.Box3();
    const badgeOnSeat = new THREE.Vector3((head.min.x + head.max.x) / 2, head.max.y + BADGE_ABOVE_HEADREST, 0);
    for (const seat of this.seats) {
      this.badgeEntries.push({
        locationId: seat.location.id,
        layer: "seats",
        matrix: seat.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(badgeOnSeat)),
      });
    }

    // floor ------------------------------------------------------------------------------------
    const addFloor = (x: number, lx: number, locationId: string | null) => {
      // the carpet map, repeated to this area's size, comes from applyProfile()
      const material = own(new THREE.MeshStandardMaterial({ roughness: 0.95 }));
      this.floorMaterials.push({ material, lx, lz: halfW * 2, offsetX: x - lx / 2 });
      const mesh = new THREE.Mesh(own(new THREE.PlaneGeometry(lx, halfW * 2)), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0, 0);
      this.groups.floor.add(mesh);
      if (locationId)
        this.floorTintEntries.push({ locationId, matrix: new THREE.Matrix4().makeScale(lx - 0.06, 1, halfW * 2 - 0.06).setPosition(x, 0.006, 0) });
      this.floorMeshes.push({ mesh, locationId });
    };
    const areas = layout.locations.filter((l) => l.kind === "FLOOR" && l.floor?.areaType === "AREA");
    if (areas.length > 0) for (const a of areas) addFloor(a.placement.x, a.placement.lx, a.id);
    else addFloor(length / 2, length, null);
    // A floor badge sits on the aisle, the floor every view shows: an area's at its middle, the full cabin's near the front.
    for (const a of areas) this.badgeEntries.push({ locationId: a.id, layer: "floor", matrix: new THREE.Matrix4().makeTranslation(a.placement.x, 0.07, 0) });
    if (layout.locations.some((l) => l.id === FULL_CABIN)) {
      this.badgeEntries.push({ locationId: FULL_CABIN, layer: "floor", matrix: new THREE.Matrix4().makeTranslation(Math.min(0.8, length / 2), 0.07, 0) });
    }
    // The aisle strip shows the full-cabin floor's status and is its pick target (WEB-18): the area under it is reached
    // anywhere else across the cabin width.
    if (layout.locations.some((l) => l.id === FULL_CABIN)) {
      this.fullCabinOverlay = new THREE.Mesh(own(new THREE.PlaneGeometry(length - 0.1, 0.42)), own(new THREE.MeshBasicMaterial()));
      this.fullCabinOverlay.rotation.x = -Math.PI / 2;
      this.fullCabinOverlay.position.set(length / 2, 0.009, 0);
      this.fullCabinOverlay.visible = false;
      this.groups.floor.add(this.fullCabinOverlay);
      // listed after the areas, so its tint is drawn over theirs
      this.floorTintEntries.push({ locationId: FULL_CABIN, matrix: new THREE.Matrix4().makeScale(length - 0.1, 1, 0.42).setPosition(length / 2, 0.009, 0) });
    } else this.fullCabinOverlay = null;
    if (this.floorTintEntries.length > 0) {
      const plane = own(new THREE.PlaneGeometry(1, 1));
      plane.rotateX(-Math.PI / 2);
      const tint = own(new THREE.InstancedMesh(plane, own(createOverlayMaterial(0.36)), this.floorTintEntries.length));
      tint.setColorAt(0, WHITE);
      tint.renderOrder = 4;
      tint.frustumCulled = false;
      this.groups.floor.add(tint);
      this.floorTint = tint;
    } else this.floorTint = null;
    // narrow aisle borders
    const border = paletteStd("aisleBorder", 0.35, 0.6);
    for (const sign of [1, -1]) {
      const strip = new THREE.Mesh(own(new THREE.BoxGeometry(length, 0.008, 0.022)), border);
      strip.position.set(length / 2, 0.004, sign * 0.262);
      this.groups.floor.add(strip);
    }

    // bins -------------------------------------------------------------------------------------
    const binLocations = layout.locations.filter((l) => l.kind === "BIN");
    // Textures shared by every family come from the cache and are not this layout's to release; the repeated copies are.
    const service = getTexture(textureKey("serviceUnit", "shared", SERVICE_UNIT_TEXTURE_SIZE), serviceUnitTexture);
    const doorTexture = getTexture(textureKey("binDoor", "shared", BIN_DOOR_TEXTURE_SIZE), binDoorTexture);
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? 1 : -1;
      const { door, body } = buildBinGeometry(sign);
      own(door);
      own(body);
      this.binHulls[side] = own(hullGeometry([door, body]));
      // Without a supplied bin map the run is drawn as illustrative, unpickable three-row modules.
      const mine = binLocations.filter((l) => l.bin?.side === side);
      // a bin's badge sits on its door, on the aisle side
      for (const l of mine)
        this.badgeEntries.push({ locationId: l.id, layer: "bins", matrix: new THREE.Matrix4().makeTranslation(l.placement.x, 1.95, sign * 0.8) });
      const spans: { x: number; lx: number }[] =
        mine.length > 0
          ? mine.map((l) => ({ x: l.placement.x, lx: l.placement.lx }))
          : Array.from({ length: Math.ceil(rows / 3) }, (_, i) => {
              const from = i * 3;
              const to = Math.min(from + 3, rows);
              const x0 = layout.geometry.rowPitch * from + FORWARD_MARGIN;
              const x1 = layout.geometry.rowPitch * to + FORWARD_MARGIN;
              return { x: (x0 + x1) / 2, lx: x1 - x0 };
            });
      const count = Math.max(spans.length, 1);
      // Double-sided surfaces that turn transparent when ghosted draw in one pass, not two (WEB-20); at ghost opacity
      // the back-then-front ordering a second pass buys is not visible.
      const singlePass = { side: THREE.DoubleSide, forceSinglePass: true };
      const doorMesh = own(new THREE.InstancedMesh(door, own(new THREE.MeshStandardMaterial({ map: doorTexture, roughness: 0.42, ...singlePass })), count));
      const bodyMesh = own(new THREE.InstancedMesh(body, std("#d5d8df", 0.6, 0, singlePass), count));
      spans.forEach((s, i) => {
        const m = new THREE.Matrix4().makeScale(s.lx, 1, 1).setPosition(s.x, 0, 0);
        doorMesh.setMatrixAt(i, m);
        doorMesh.setColorAt(i, WHITE);
        bodyMesh.setMatrixAt(i, m);
      });
      if (spans.length === 0) {
        doorMesh.count = 0;
        bodyMesh.count = 0;
      }
      doorMesh.instanceMatrix.needsUpdate = true;
      bodyMesh.instanceMatrix.needsUpdate = true;
      doorMesh.computeBoundingSphere();
      const map = own(service.clone());
      map.needsUpdate = true;
      map.repeat.set(rows, 1);
      const psu = new THREE.Mesh(
        own(new THREE.PlaneGeometry(rows * layout.geometry.rowPitch, 0.4)),
        own(new THREE.MeshStandardMaterial({ map, roughness: 0.6, ...singlePass })),
      );
      psu.rotation.x = Math.PI / 2;
      psu.rotation.z = sign > 0 ? 0 : Math.PI;
      psu.position.set(FORWARD_MARGIN + (rows * layout.geometry.rowPitch) / 2, 1.648, sign * 1.55);
      this.groups.bins.add(doorMesh, bodyMesh, psu);
      this.binSides.push({ side, door: doorMesh, body: bodyMesh, locations: mine, extras: [psu] });
    }

    // context (secondary, hidden by default) --------------------------------------------------
    const wallTexture = getTexture(textureKey("sidewall", "shared", SIDEWALL_TEXTURE_SIZE), sidewallTexture);
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? 1 : -1;
      const map = own(wallTexture.clone());
      map.needsUpdate = true;
      map.repeat.set(Math.max(rows, 1), 1);
      const wallMaterial = own(new THREE.MeshStandardMaterial({ map, roughness: 0.7, side: THREE.DoubleSide, forceSinglePass: true, transparent: true }));
      const wall = new THREE.Mesh(own(new THREE.PlaneGeometry(length, 1.66)), wallMaterial);
      wall.position.set(length / 2, 0.83, sign * (halfW + 0.005));
      wall.rotation.y = sign > 0 ? Math.PI : 0;
      // the wash-light strip glows; it lights nothing (the environment does that)
      const strip = new THREE.Mesh(
        own(new THREE.BoxGeometry(length, 0.03, 0.03)),
        own(new THREE.MeshStandardMaterial({ color: "#000000", emissive: "#ffffff", emissiveIntensity: 1.6 })),
      );
      strip.position.set(length / 2, 1.63, sign * (halfW - 0.03));
      strip.userData.wash = true;
      this.groups.context.add(wall, strip);
      this.contextSides.push({ side, wallMaterial });
    }
    for (const x of [0.02, length - 0.02]) {
      const bulkhead = new THREE.Mesh(own(new THREE.BoxGeometry(0.04, 2.25, halfW * 2)), std("#e2e4ea", 0.7, 0, { transparent: true, opacity: 0.55 }));
      bulkhead.position.set(x, 1.125, 0);
      this.groups.context.add(bulkhead);
    }

    // status badges: one instanced mesh for every seat, floor area and bin module (one draw call)
    if (this.badgeEntries.length > 0) {
      const atlas = getTexture(textureKey("statusBadges", "shared", BADGE_ATLAS_SIZE), statusBadgeAtlas);
      const badges = own(createBadges(this.badgeEntries.length, atlas, BADGE_GLYPHS.length, this.viewport));
      own(badges.geometry);
      own(badges.material as THREE.Material);
      badges.setColorAt(0, WHITE);
      this.badges = badges;
      this.groups.marks.add(badges);
    } else this.badges = null;

    this.applyLayers();
    // the new materials have no palette yet
    this.appliedPalette = null;
    this.applyProfile();
    this.applyStates();
    this.applySelection();
    this.updateGhosting();
    this.invalidate();
  }

  // ---- appearance -----------------------------------------------------------------------------

  setProfile(profileId: string): void {
    const next = PALETTES[profileId];
    if (!next || next === this.palette) return;
    this.palette = next;
    this.applyProfile();
  }

  setLight(mode: LightMode): void {
    if (mode === this.light) return;
    this.light = mode;
    this.applyProfile();
  }

  /**
   * Show the visual family and the cabin light on what buildLayout() built (WEB-20): material colours and maps, the
   * window-side wing, lights and background. No geometry work; the family's textures are made once and then cached.
   */
  private applyProfile(): void {
    this.updates.applyProfile += 1;
    if (this.appliedPalette !== this.palette) this.applyPalette(this.palette);
    this.applyLight();
    this.invalidate();
  }

  /** A seat surface's colour, normal and roughness maps from the cache. The normal and roughness maps depend only on where the seams run. */
  private seatMaps(surface: SeatSurface, p: ProfilePalette): SeatMaps {
    const band = surface === "back" && p.band !== null;
    const relief = { band };
    return {
      colour: getTexture(textureKey(`${surface}Colour`, p.id, SEAT_TEXTURE_SIZE), () => (surface === "back" ? backFrontTexture(p) : panTexture(p))),
      normal: getTexture(textureKey(`${surface}Normal`, "shared", SEAT_TEXTURE_SIZE, { ...relief, strength: SEAT_NORMAL_STRENGTH }), () =>
        seatNormalTexture(surface, band, SEAT_NORMAL_STRENGTH),
      ),
      roughness: getTexture(textureKey(`${surface}Roughness`, "shared", SEAT_TEXTURE_SIZE, relief), () => seatRoughnessTexture(surface, band)),
    };
  }

  private applyPalette(p: ProfilePalette): void {
    for (const { material, colour } of this.paletteMaterials) material.color.set(p[colour]);
    // Seat materials and the per-area carpet copies belong to the palette: made afresh here, and the previous family's
    // released once the new ones are in place. The textures themselves come from the cache.
    const previous = this.profileResources;
    this.profileResources = new ResourceTracker();
    const mine = <T extends Disposable>(resource: T): T => this.profileResources.track(resource);
    const set = createSeatMaterials(p, this.seatMaps("back", p));
    for (const material of Object.values(set)) mine(material);
    const plain = (colour: string) => mine(upholsteryVariant(set.upholstery, { colour }));
    const rearShell = mine(set.shell.clone());
    rearShell.color.set("#ffffff");
    rearShell.map = getTexture(textureKey("rearShell", p.id, SEAT_TEXTURE_SIZE, { powerPanel: REAR_SHELL_POWER_PANEL }), () =>
      rearShellTexture(p, REAR_SHELL_POWER_PANEL),
    );
    const arms = mine(set.shell.clone());
    arms.color.set(p.arm);
    const wings = plain(p.paleFace);
    wings.side = THREE.DoubleSide;
    const materials: Record<SeatPart, THREE.Material> = {
      legs: set.metal,
      pan: mine(upholsteryVariant(set.upholstery, { maps: this.seatMaps("pan", p) })),
      backCore: plain(p.upholsteryDark),
      backFront: set.upholstery,
      rearShell,
      rearRelief: set.shell,
      headrest: plain(p.headrest),
      arms,
      armPads: set.pad,
      wings,
    };
    for (const [part, mesh] of Object.entries(this.seatParts)) mesh.material = materials[part as SeatPart];
    this.showWindowWings(p.paleBothWings);
    // Each floor area repeats the carpet to its own size, so it draws a copy of the cached texture.
    const carpet = getTexture(textureKey("carpet", p.id, CARPET_TEXTURE_SIZE), () => carpetTexture(p));
    for (const f of this.floorMaterials) {
      const map = mine(carpet.clone());
      map.needsUpdate = true;
      map.repeat.set(f.lx / 1.3, f.lz / 1.3);
      map.offset.set(f.offsetX / 1.3, 0);
      f.material.map = map;
    }
    previous.disposeAll();
    this.appliedPalette = p;
  }

  /** Show or hide the window-side wing faces: their instances take the window-side matrices, or none. */
  private showWindowWings(shown: boolean): void {
    const wings = this.seatParts.wings;
    if (!wings || this.windowWingsShown === shown) return;
    const n = this.seats.length;
    this.windowWingMatrices.forEach((m, i) => {
      wings.setMatrixAt(n + i, shown ? m : ZERO);
    });
    wings.instanceMatrix.needsUpdate = true;
    wings.computeBoundingSphere();
    this.windowWingsShown = shown;
  }

  /** The environment for a light mode, prefiltered once and kept for the life of the scene. */
  private environmentFor(mode: LightMode): THREE.Texture {
    let texture = this.environments.get(mode);
    if (!texture) {
      texture = this.sceneResources.track(createEnvironment(this.renderer, mode));
      this.environments.set(mode, texture);
    }
    return texture;
  }

  /** Estimated GPU bytes of the environments made so far: half-float RGBA, no mipmaps (PMREM keeps its levels in one atlas). */
  private environmentBytes(): number {
    let bytes = 0;
    for (const texture of this.environments.values()) {
      const image = texture.image as { width?: number; height?: number } | null;
      bytes += (image?.width ?? 0) * (image?.height ?? 0) * 8;
    }
    return bytes;
  }

  private applyLight(): void {
    const blue = this.light === "blue";
    // Blue cabin light is a wash over pale surfaces, not a blue-only scene: whites stay pale, as in the photographs.
    this.scene.background = new THREE.Color(blue ? "#2a3566" : "#eef0f4");
    this.scene.environment = this.environmentFor(this.light);
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY[this.light];
    this.lights.key.color.set(blue ? "#b9c5ff" : "#fff8ee");
    this.lights.key.intensity = blue ? 1.2 : 1.4;
    this.lights.fill.intensity = blue ? 0.8 : 0;
    this.renderer.toneMappingExposure = blue ? 1.05 : 1.0;
    this.groups.context.traverse((o) => {
      if (o.userData.wash) ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.set(blue ? "#6f8dff" : "#ffffff");
    });
  }

  setColourMode(mode: ColourMode): void {
    this.colourMode = mode;
    this.applyStates();
  }

  setLayers(layers: Layers): void {
    this.layers = { ...layers };
    this.applyLayers();
  }

  private applyLayers(): void {
    this.groups.seats.visible = this.layers.seats;
    this.groups.floor.visible = this.layers.floor;
    this.groups.bins.visible = this.layers.bins;
    this.groups.context.visible = this.layers.context;
    this.applyBadges();
    this.invalidate();
  }

  /**
   * In an outside view, the bins and wall nearest the camera are ghosted and excluded from
   * picking so they never block the seats; seen from above, both bin rows are ghosted.
   */
  private updateGhosting(): void {
    const cam = this.camera.position;
    const inside = Math.abs(cam.z) < 0.7 && cam.y < 2.2;
    const offset = cam.clone().sub(this.controls.target);
    const above = offset.y / Math.max(offset.length(), 0.001) > 0.9 && cam.y > 4;
    for (const b of this.binSides) {
      const near = !inside && (above || (b.side === "L" ? cam.z > 0.7 : cam.z < -0.7));
      const ghost = near;
      b.door.userData.ghost = ghost;
      for (const o of [b.door, b.body, ...b.extras] as THREE.Mesh[]) {
        setGhosted(o.material as THREE.Material, ghost, 0.16);
      }
    }
    for (const m of [this.selectionMarks, this.hoverMarks]) this.ghostOutline(m);
    for (const c of this.contextSides) {
      const near = !inside && (c.side === "L" ? cam.z > 0.7 : cam.z < -0.7);
      const wall = c.wallMaterial;
      wall.opacity = near ? 0.1 : 1;
      wall.depthWrite = !near;
    }
  }

  // ---- state ----------------------------------------------------------------------------------

  setStates(states: Map<string, LocationState>): void {
    this.states = states;
    this.applyStates();
  }

  /** What a location shows: the same aggregate the map shows (aggregateStatus). */
  private statusOf(locationId: string): LocationStatus {
    const state = this.states.get(locationId);
    return state ? aggregateStatus(Object.values(state.components)) : "none";
  }

  /**
   * Show record states and the colour mode (WEB-20): instance colours, badge cells and overlay visibility only, no
   * geometry or material work. Status is a badge on every location (WEB-21); the "Work status" mode also tints the
   * headrest, floor areas and bin doors.
   */
  private applyStates(): void {
    this.updates.applyStates += 1;
    const status = this.colourMode === "status";
    const colourFor = (s: LocationStatus) => (s === "none" ? null : STATUS_COLOUR[s]);
    if (this.panOverlay && this.headrestOverlay) {
      // Only the tinted seats are drawn: they are packed first and the count stops after them, so an untinted seat costs
      // no triangles, and an overlay with nothing to show costs no draw call (WEB-20).
      let pans = 0;
      let heads = 0;
      for (const s of this.seats) {
        const pan = this.colourMode === "tier" ? (TIER_COLOUR[s.location.seat?.commercialTier ?? s.location.seat?.maintenanceZone ?? ""] ?? null) : null;
        const head = status ? colourFor(this.statusOf(s.location.id)) : null;
        if (pan) {
          this.panOverlay.setMatrixAt(pans, s.matrix);
          this.panOverlay.setColorAt(pans++, pan);
        }
        if (head) {
          this.headrestOverlay.setMatrixAt(heads, s.matrix);
          this.headrestOverlay.setColorAt(heads++, head);
        }
      }
      for (const [o, count] of [
        [this.panOverlay, pans],
        [this.headrestOverlay, heads],
      ] as const) {
        o.count = count;
        o.visible = count > 0;
        o.instanceMatrix.needsUpdate = true;
        if (o.instanceColor) o.instanceColor.needsUpdate = true;
      }
    }
    if (this.floorTint) {
      // packed and counted like the headrest tint
      let tints = 0;
      for (const f of this.floorTintEntries) {
        const c = status ? colourFor(this.statusOf(f.locationId)) : null;
        if (!c) continue;
        this.floorTint.setMatrixAt(tints, f.matrix);
        this.floorTint.setColorAt(tints++, c);
      }
      this.floorTint.count = tints;
      this.floorTint.visible = tints > 0;
      this.floorTint.instanceMatrix.needsUpdate = true;
      if (this.floorTint.instanceColor) this.floorTint.instanceColor.needsUpdate = true;
    }
    for (const b of this.binSides) {
      b.locations.forEach((l, i) => {
        const s = status ? this.statusOf(l.id) : "none";
        b.door.setColorAt(i, s === "none" ? WHITE : BIN_STATUS_COLOUR[s]);
      });
      if (b.door.instanceColor) b.door.instanceColor.needsUpdate = true;
    }
    this.applyBadges();
    this.invalidate();
  }

  /**
   * One badge per location with a status, its glyph and colour from STATUS_ENCODING, so it matches the map and the
   * legend. Shown in the status and tier colour modes, not in "Appearance only"; a hidden layer hides its badges.
   */
  private applyBadges(): void {
    const badges = this.badges;
    if (!badges) return;
    const cells = badges.geometry.getAttribute("badgeCell") as THREE.InstancedBufferAttribute;
    // shown badges are packed first and drawn; the rest are not (see applyStates)
    let shown = 0;
    for (const b of this.badgeEntries) {
      const s = this.colourMode === "none" || !this.layers[b.layer] ? "none" : this.statusOf(b.locationId);
      if (s === "none") continue;
      badges.setMatrixAt(shown, b.matrix);
      badges.setColorAt(shown, STATUS_COLOUR[s]);
      cells.setX(shown++, BADGE_GLYPHS.indexOf(STATUS_ENCODING[s].glyph));
    }
    badges.count = shown;
    badges.visible = shown > 0;
    badges.instanceMatrix.needsUpdate = true;
    if (badges.instanceColor) badges.instanceColor.needsUpdate = true;
    cells.needsUpdate = true;
  }

  setSelection(locationId: string | null): void {
    this.selection = locationId;
    this.applySelection();
  }

  private boxOf(location: CabinLocation): { centre: THREE.Vector3; size: THREE.Vector3 } {
    const p = location.placement;
    if (location.kind === "SEAT") return { centre: new THREE.Vector3(p.x + 0.07, 0.6, p.z), size: new THREE.Vector3(0.74, 1.22, SEAT.width + 0.07) };
    if (location.kind === "FLOOR") return { centre: new THREE.Vector3(p.x, 0.03, 0), size: new THREE.Vector3(p.lx - 0.04, 0.06, p.lz - 0.04) };
    const sign = location.bin?.side === "L" ? 1 : -1;
    return { centre: new THREE.Vector3(p.x, 1.98, sign * 1.25), size: new THREE.Vector3(p.lx - 0.02, 0.68, 1.02) };
  }

  private applySelection(): void {
    const location = this.layout?.locations.find((l) => l.id === this.selection) ?? null;
    this.placeMarks(this.selectionMarks, location, "selection");
    // a hovered location that becomes selected shows the selection only
    if (location && this.hovered === location.id) this.placeMarks(this.hoverMarks, null, "hover");
    this.invalidate();
  }

  /** Outline a location, or hide the marks: a hull around a seat or bin module, a frame inside a floor area's edge. */
  private placeMarks(marks: Marks, location: CabinLocation | null, kind: "selection" | "hover"): void {
    marks.hull.visible = marks.frame.visible = false;
    marks.location = location;
    if (kind === "hover") this.hovered = location?.id ?? null;
    this.ghostOutline(marks);
    if (!location) return;
    const p = location.placement;
    if (location.kind === "FLOOR") {
      const key = `${location.id}|${kind}`;
      let geometry = this.frames.get(key);
      if (!geometry) {
        geometry = this.layoutResources.track(frameGeometry(p.lx, p.lz, marks.rings));
        this.frames.set(key, geometry);
      }
      marks.frame.geometry = geometry;
      marks.frame.position.set(p.x, 0.012, 0);
      marks.frame.visible = true;
      return;
    }
    if (location.kind === "SEAT") {
      const seat = this.seats.find((s) => s.location.id === location.id);
      if (!seat) return;
      marks.hull.geometry = this.seatHull;
      marks.hull.matrix.copy(seat.matrix);
    } else {
      const side = location.bin?.side === "L" ? "L" : "R";
      const hull = this.binHulls[side];
      if (!hull) return;
      marks.hull.geometry = hull;
      marks.hull.matrix.makeScale(p.lx, 1, 1).setPosition(p.x, 0, 0);
    }
    marks.hull.matrixWorldNeedsUpdate = true;
    marks.hull.visible = true;
  }

  /** An outline around a ghosted bin is see-through, like the bin; any other outline is opaque. */
  private ghostOutline(marks: Marks): void {
    const bin = marks.location?.kind === "BIN" ? this.binSides.find((b) => b.locations.includes(marks.location as CabinLocation)) : undefined;
    const material = marks.hull.material as THREE.Material;
    const ghost = Boolean(bin?.door.userData.ghost);
    if (material.transparent !== ghost) setGhosted(material, ghost, GHOSTED_OUTLINE_OPACITY);
  }

  // ---- camera ---------------------------------------------------------------------------------

  private fit(direction: THREE.Vector3, initialTarget: THREE.Vector3, box: THREE.Box3, margin = 0.93): void {
    const dir = direction.clone().normalize();
    const target = initialTarget.clone();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const place = (d: number) => {
      this.camera.position.copy(target).addScaledVector(dir, d);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      this.camera.updateProjectionMatrix();
      return corners.map((c) => c.clone().project(this.camera));
    };
    const fits = (d: number) => place(d).every((v) => Math.abs(v.x) <= margin && Math.abs(v.y) <= margin && v.z < 1);
    let distance = 200;
    // Fit, then slide the target so the projected cabin is centred, and fit again: this removes
    // the empty band that a perspective view of a long cabin otherwise leaves on one side.
    for (let pass = 0; pass < 6; pass++) {
      let lo = 0.5;
      let hi = 200;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      distance = hi;
      const projected = place(distance);
      const cx = (Math.min(...projected.map((v) => v.x)) + Math.max(...projected.map((v) => v.x))) / 2;
      const cy = (Math.min(...projected.map((v) => v.y)) + Math.max(...projected.map((v) => v.y))) / 2;
      if (Math.abs(cx) < 0.01 && Math.abs(cy) < 0.01) break;
      const halfH = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      target.addScaledVector(right, cx * halfH * this.camera.aspect * 0.9).addScaledVector(up, cy * halfH * 0.9);
    }
    place(distance);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private cabinBox(): THREE.Box3 {
    const g = this.layout!.geometry;
    return new THREE.Box3(new THREE.Vector3(0, 0, -g.cabinHalfWidth), new THREE.Vector3(g.cabinLength, this.layers.bins ? 2.3 : 1.25, g.cabinHalfWidth));
  }

  /** Frame the cabin or a location. Views are fitted to the viewport so the cabin fills it. */
  setCamera(view: CameraView, locationId?: string | null): void {
    if (!this.layout) return;
    const g = this.layout.geometry;
    const aspect = this.camera.aspect;
    const centre = new THREE.Vector3(g.cabinLength / 2, 0.75, 0);
    this.camera.fov = 36;
    this.currentView = view;
    const location = this.layout.locations.find((l) => l.id === (locationId ?? this.selection));
    this.viewLocation = location?.id ?? null;
    if (view === "cutaway") {
      // Seen from the forward quarter so the cabin recedes and fills the frame instead of lying as a thin strip.
      const dir = aspect >= 1.15 ? new THREE.Vector3(-0.52, 0.52, 0.68) : new THREE.Vector3(-0.86, 0.72, 0.34);
      this.fit(dir, centre, this.cabinBox());
    } else if (view === "overhead") {
      const dir = aspect >= 1 ? new THREE.Vector3(0, 1, 0.12) : new THREE.Vector3(-0.12, 1, 0);
      this.fit(dir, new THREE.Vector3(g.cabinLength / 2, 0, 0), this.cabinBox(), 0.96);
    } else if (view === "aisle") {
      this.camera.fov = 62;
      this.camera.position.set(0.2, 1.78, 0);
      this.controls.target.set(Math.min(7, g.cabinLength), 0.85, 0);
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } else if (view === "carpet") {
      const x = Math.min(g.cabinLength / 2, 6);
      this.camera.fov = 50;
      this.camera.position.set(x - 0.3, 2.05, 0);
      this.controls.target.set(x, 0, 0);
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } else if (view === "bins") {
      const x = Math.min(g.cabinLength / 2, 6.2);
      this.camera.fov = 52;
      this.camera.position.set(x - 1.5, 1.2, 0.3);
      this.controls.target.set(x + 0.7, 1.5, -1.3);
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } else if (location) {
      const p = location.placement;
      if (location.kind === "SEAT") {
        const toAisle = p.z > 0 ? -1 : 1;
        if (view === "focus-rear") {
          this.camera.position.set(p.x + 1.3, 1.34, p.z + toAisle * 0.42);
          this.controls.target.set(p.x + 0.32, 0.8, p.z);
        } else {
          this.camera.position.set(p.x - 1.35, 1.46, p.z + toAisle * 0.5);
          this.controls.target.set(p.x + 0.12, 0.86, p.z);
        }
      } else if (location.kind === "FLOOR") {
        this.fit(
          new THREE.Vector3(-0.35, 1, 0.5),
          new THREE.Vector3(p.x, 0, 0),
          new THREE.Box3(new THREE.Vector3(p.x - p.lx / 2, 0, -g.cabinHalfWidth), new THREE.Vector3(p.x + p.lx / 2, 1.2, g.cabinHalfWidth)),
        );
        return;
      } else {
        const sign = location.bin?.side === "L" ? 1 : -1;
        this.camera.position.set(p.x - 1.7, 1.3, -sign * 0.35);
        this.controls.target.set(p.x, 1.9, sign * 1.15);
      }
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } else {
      this.setCamera("cutaway");
      return;
    }
    this.updateGhosting();
    this.invalidate();
  }

  /** Keyboard and button camera control: orbit, tilt and zoom around the current target. */
  nudge(action: "left" | "right" | "up" | "down" | "in" | "out"): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    if (action === "left") s.theta -= 0.2;
    if (action === "right") s.theta += 0.2;
    if (action === "up") s.phi = Math.max(0.08, s.phi - 0.12);
    if (action === "down") s.phi = Math.min(this.controls.maxPolarAngle, s.phi + 0.12);
    if (action === "in") s.radius = Math.max(this.controls.minDistance, s.radius * 0.8);
    if (action === "out") s.radius = Math.min(this.controls.maxDistance, s.radius * 1.25);
    this.currentView = "free";
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
    this.controls.update();
    this.updateGhosting();
    this.invalidate();
  }

  // ---- picking --------------------------------------------------------------------------------

  private hit(clientX: number, clientY: number): { location: CabinLocation; component: string | null } | null {
    if (!this.layout) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Only visible, unghosted, selectable objects take part: a hidden layer can never block a pick.
    const targets: THREE.Object3D[] = [];
    if (this.layers.seats) for (const s of this.seatMeshes) targets.push(s.mesh);
    if (this.layers.floor && this.pickableFloorBins) {
      for (const f of this.floorMeshes) if (f.locationId) targets.push(f.mesh);
      // raycasting ignores visibility, so the strip is a target even while it shows no status
      if (this.fullCabinOverlay) targets.push(this.fullCabinOverlay);
    }
    if (this.layers.bins && this.pickableFloorBins)
      for (const b of this.binSides) if (!b.door.userData.ghost && b.locations.length) targets.push(b.door, b.body);
    const hits = this.raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first) return null;
    const seat = this.seatMeshes.find((s) => s.mesh === first.object);
    if (seat && first.instanceId !== undefined) {
      // the wing mesh has two instances per seat (aisle side, then window side)
      const entry = this.seats[first.instanceId % this.seats.length];
      return entry ? { location: entry.location, component: seat.component } : null;
    }
    if (first.object === this.fullCabinOverlay) {
      const location = this.layout.locations.find((l) => l.id === FULL_CABIN);
      return location ? { location, component: null } : null;
    }
    const floor = this.floorMeshes.find((f) => f.mesh === first.object);
    if (floor?.locationId) {
      const location = this.layout.locations.find((l) => l.id === floor.locationId);
      return location ? { location, component: null } : null;
    }
    const bin = this.binSides.find((b) => b.door === first.object || b.body === first.object);
    const binLocation = bin && first.instanceId !== undefined ? bin.locations[first.instanceId] : undefined;
    if (binLocation) return { location: binLocation, component: null };
    return null;
  }

  private static sample(e: PointerEvent): PointerSample {
    return { pointerId: e.pointerId, button: e.button, isPrimary: e.isPrimary, x: e.clientX, y: e.clientY, time: e.timeStamp };
  }

  // Only a short, still, primary left press picks; a right click, a drag, a long press or the end of a pinch does not (WEB-12).
  private onPointerDown = (e: PointerEvent) => {
    if (this.paused) return;
    this.gesture.down(CabinScene.sample(e));
  };

  private onPointerUp = (e: PointerEvent) => {
    const at = this.gesture.up(CabinScene.sample(e));
    if (!at || this.paused) return;
    const hit = this.hit(at.x, at.y);
    if (!hit) return;
    if (this.onFrameRendered) this.pickStamp = performance.now();
    this.callbacks.onPick(hit.location.id, hit.component);
  };

  private onPointerMove = (e: PointerEvent) => {
    this.gesture.move(CabinScene.sample(e));
    if (this.paused || e.pointerType === "touch" || e.buttons !== 0) return;
    this.hoverPending = e;
    // hover is resolved in the next frame, which draws only if the hover mark changed
    this.requestFrame();
  };

  private onPointerCancel = () => {
    this.gesture.cancel();
  };

  private onPointerLeave = () => {
    this.hoverPending = null;
    this.clearHover();
    this.callbacks.onHover(null);
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.onContextLost();
  };

  private processHover(): void {
    const e = this.hoverPending;
    if (!e) return;
    this.hoverPending = null;
    const hit = this.hit(e.clientX, e.clientY);
    const target = hit && hit.location.id !== this.selection ? hit.location : null;
    if ((target?.id ?? null) !== this.hovered) {
      this.placeMarks(this.hoverMarks, target, "hover");
      this.needsRender = true;
    }
    this.canvas.style.cursor = hit ? "pointer" : "grab";
    const rect = this.canvas.getBoundingClientRect();
    this.callbacks.onHover(hit ? { label: hit.location.label, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
  }

  private clearHover(): void {
    if (this.hovered === null) return;
    this.placeMarks(this.hoverMarks, null, "hover");
    this.invalidate();
  }

  // ---- loop -----------------------------------------------------------------------------------

  /**
   * Match the canvas size and the screen's pixel ratio (which changes when the window moves between screens or the page is
   * zoomed). A preset view is re-framed for the new shape; a camera the user moved stays put, so a phone's URL bar
   * collapsing never snaps it back (WEB-09).
   */
  resize(): void {
    const w = Math.max(this.canvas.clientWidth, 1);
    const h = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.viewport.value = h;
    const changed = Math.abs(this.camera.aspect - w / h) > 0.001;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (changed && this.layout && this.currentView !== "free") this.setCamera(this.currentView, this.viewLocation);
    this.invalidate();
  }

  /**
   * Stop drawing and listening while the view is hidden; the scene, camera and settings are kept as they are, and drawing
   * resumes with the next frame when shown again.
   */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    this.controls.enabled = !paused;
    this.gesture.cancel();
    this.hoverPending = null;
    if (paused) {
      this.cancelFrame();
      this.measureAbort?.();
      // nothing is hovered while hidden; the first frame drawn when shown again has no hover marks
      if (this.hovered !== null) {
        this.placeMarks(this.hoverMarks, null, "hover");
        this.needsRender = true;
      }
      this.callbacks.onHover(null);
    } else {
      this.invalidate();
    }
  }

  /**
   * Draw the scene once more (WEB-20). Frames are drawn on demand: something that changes what is seen calls this, and
   * nothing is drawn while the scene is unchanged, paused or the page is hidden.
   */
  invalidate(): void {
    this.needsRender = true;
    this.requestFrame();
  }

  /** Request one animation frame if none is pending. A paused scene or a hidden page requests none. */
  private requestFrame(): void {
    if (this.frame !== 0 || this.inFrame || this.disposed || this.paused || document.visibilityState === "hidden") return;
    this.frameRequests += 1;
    this.frame = requestAnimationFrame(this.renderFrame);
  }

  private cancelFrame(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** A hidden page draws nothing; whatever changed meanwhile is drawn when it shows again. */
  private onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.cancelFrame();
      this.measureAbort?.();
    } else this.invalidate();
  };

  /** One frame. It requests the next only while the orbit damping is settling or measure() is running. */
  private renderFrame = () => {
    this.frame = 0;
    if (this.disposed || this.paused) return;
    this.inFrame = true;
    let settling = false;
    try {
      this.measureStep?.();
      this.processHover();
      settling = this.controls.update();
      if (settling) this.needsRender = true;
      if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
        this.frameCount += 1;
        this.onFrameRendered?.();
      }
    } finally {
      this.inFrame = false;
    }
    if (settling || this.measureStep || this.needsRender) this.requestFrame();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    CabinScene.liveScenes -= 1;
    this.cancelFrame();
    this.measureStep?.();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.controls.dispose();
    for (const g of [this.groups.seats, this.groups.floor, this.groups.bins, this.groups.context]) this.clearGroup(g);
    try {
      ResourceTracker.disposeEach(this.layoutResources, this.profileResources, this.sceneResources);
    } finally {
      try {
        // the cached textures are shared by every scene on the page: the last scene to go releases them
        if (CabinScene.liveScenes === 0) disposeTextureCache();
      } finally {
        this.renderer.dispose();
        this.renderer.forceContextLoss();
      }
    }
  }
}
