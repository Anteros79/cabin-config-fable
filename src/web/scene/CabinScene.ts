import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AFT_MARGIN, CEILING_HEIGHT, FORWARD_MARGIN, shellProfile } from "../../domain/geometry.ts";
import type { CabinLocation, LayoutRevision } from "../../domain/types.ts";
import { aggregateStatus, type LocationStatus, STATUS_ENCODING } from "../model.ts";
import { boundPose, type CabinBounds, type CameraPose, easeInOutCubic, interpolatePose, poseToFrame, transitionMs } from "./cameraRig.ts";
import { createEnvironment, ENVIRONMENT_INTENSITY, type LightMode } from "./environment.ts";
import {
  BLOCKED_COLOUR,
  createOverlayMaterial,
  createSeatMaterials,
  HEADREST_TINT_OPACITY,
  LIGHT_SCENE_THEME,
  type SceneTheme,
  SELECT_COLOUR,
  type SeatMaps,
  STATUS_COLOUR,
  setGhosted,
  TIER_COLOUR,
  upholsteryVariant,
  withStatusTint,
} from "./materials.ts";
import { createBadges, createFrame, createOutline, frameGeometry, HOVER_OUTLINE, hullGeometry, SELECTION_OUTLINE, type ViewportUniform } from "./outline.ts";
import { PickGesture, type PointerSample, TouchAxisLock } from "./pickGesture.ts";
import {
  BinRun,
  buildBinMarker,
  buildBulkheadPanel,
  buildPieceMeshes,
  buildSeatGeometries,
  type PieceMesh,
  pickPiece,
  pieceTargets,
  SEAT,
  type SeatGeometries,
  type SeatPart,
} from "./seatParts.ts";
import { buildShellGeometries, lightChannelMask } from "./shell.ts";
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
  seatNormalTexture,
  seatRoughnessTexture,
  serviceUnitTexture,
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
/** A view setCamera() frames: the whole cabin, or the selected location ("focus", "focus-rear"). */
export type PresetView = "cutaway" | "overhead" | "aisle" | "focus" | "focus-rear" | "carpet" | "bins";
/** A preset view, or "free" once the user has moved the camera by hand (orbit, pan, zoom or a nudge). */
export type CameraView = PresetView | "free";
export interface Layers {
  seats: boolean;
  floor: boolean;
  bins: boolean;
  /** the life vests under the seats: drawn and pickable only while on */
  underSeat: boolean;
  context: boolean;
}
export interface SceneCallbacks {
  onPick(locationId: string, componentId: string | null): void;
  /** the hovered location and piece (null: the location as a whole) and the pointer's position in the canvas (CSS pixels), or null when nothing is hovered */
  onHover(hover: { locationId: string; componentId: string | null; x: number; y: number } | null): void;
  onContextLost(): void;
  /** a bin opened (its location id) or the open bin closed (null): by a tap, by openBin(), or by a new layout */
  onBinOpenChange?(locationId: string | null): void;
  /** the wheel turned over the canvas without zooming (the view has no focus and no Ctrl or Cmd is held): the page scrolled */
  onWheelPassedThrough?(): void;
}

/** Bin doors are pale: a status tints them halfway from white toward its colour. */
const BIN_STATUS_COLOUR = Object.fromEntries(
  (Object.keys(STATUS_COLOUR) as (keyof typeof STATUS_COLOUR)[]).map((status) => [status, STATUS_COLOUR[status].clone().lerp(new THREE.Color("#ffffff"), 0.5)]),
) as Record<keyof typeof STATUS_COLOUR, THREE.Color>;
/** Floor frames: selection 10 cm in the select colour; hover 6 cm in the theme's outline colour with 2 cm of ink inside it. */
const SELECTION_FRAME = [{ width: 0.1, colour: SELECT_COLOUR }] as const;
/** A CSS colour as lower-case six-digit hex: one spelling per colour, for comparisons and cache keys. */
const hex6 = (colour: string) => `#${new THREE.Color(colour).getHexString()}`;
const hoverFrame = (outline: string) =>
  [
    { width: 0.06, colour: outline },
    { width: 0.02, colour: HOVER_OUTLINE.inner.colour },
  ] as const;
/** A ghosted bin hides nothing behind it, so its outline would show as a solid shape: it is drawn see-through instead. */
const GHOSTED_OUTLINE_OPACITY = 0.45;
/** Where a seat's badge sits: above the top of the headrest, in seat coordinates. */
const BADGE_ABOVE_HEADREST = 0.075;
/** Where an armrest's badge sits: above its pad, in armrest coordinates. */
const BADGE_ABOVE_ARMREST = 0.06;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color("#ffffff");
const FULL_CABIN = "FLOOR:FULL-CABIN";
/** The cabin box the orbit target stays in (plus half a metre) is this tall: the top of the bins. */
const CABIN_HEIGHT = 2.3;
/** Ghosting of bins and walls fades over this long instead of popping (0 with reduced motion). */
const GHOST_FADE_MS = 150;
const BIN_GHOST_OPACITY = 0.16;
const WALL_GHOST_OPACITY = 0.1;
/** A location selected outside the canvas is framed when it projects outside this central part of the view. */
const REVEAL_CENTRAL = 0.8;

interface SeatEntry {
  location: CabinLocation;
  matrix: THREE.Matrix4;
}

/** One status badge: where it sits and the layer that shows it. */
interface BadgeEntry {
  locationId: string;
  /** a seat's badge, which shows "Blocked" while the seat is blocked */
  seat: boolean;
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
  /** the seat part's instance outlined, or null for the whole location */
  piece: PiecePick | null;
}

/** One instance of a seat part: what a pick or a hover found. */
type PiecePick = { piece: PieceMesh; instance: number };

/** The palette colours a material can follow; applyProfile() sets each such material's colour from the palette. */
type PaletteColour = "aisleBorder";

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
  /** Screen position of a piece inside the open bin that a pick from the camera reaches, or null if none (or the bin is not open). */
  screenPointOfPiece(locationId: string, componentId: string): { x: number; y: number } | null;
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
  private layers: Layers = { seats: true, floor: true, bins: true, underSeat: false, context: false };
  private palette: ProfilePalette = PALETTES["photo-navy-band"];
  private light: LightMode = "neutral";
  /** what the page theme gives the scene: set by setTheme() */
  private theme: SceneTheme = { background: hex6(LIGHT_SCENE_THEME.background), outline: hex6(LIGHT_SCENE_THEME.outline), wash: hex6(LIGHT_SCENE_THEME.wash) };
  private colourMode: ColourMode = "status";
  private layout: LayoutRevision | null = null;
  private seats: SeatEntry[] = [];
  /**
   * Every seat part as one instanced mesh (WEB-20), with what each instance belongs to: a tap selects the piece, and the
   * tray and net on a seat's back select the seat behind (seatParts.ts). In the "Work status" colour mode each piece is
   * tinted by its own status, drawn by its material (withStatusTint).
   */
  private pieces: PieceMesh[] = [];
  /** the thin panels ahead of the first row, which carry the first row's trays and nets */
  private bulkheadPanels: THREE.InstancedMesh | null = null;
  private panOverlay: THREE.InstancedMesh | null = null;
  private badges: THREE.InstancedMesh | null = null;
  private badgeEntries: BadgeEntry[] = [];
  /** the welded outline shape of a seat, made once */
  private seatHull: THREE.BufferGeometry;
  /** the outline shape of each piece, by component id, made once: hover outlines only the piece under the pointer */
  private pieceHulls = new Map<string, THREE.BufferGeometry>();
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
  /** the overhead bins: closed per side, at most one open with its inside (seatParts.ts BinRun) */
  private bins: BinRun | null = null;
  /** the material of an open bin's inside: a shade and a status tint per vertex, ghosted with its side */
  private binInterior: THREE.MeshStandardMaterial | null = null;
  /** a coloured band on the face of each shut bin with a status, packed like floorTint: one draw call */
  private binMarkers: THREE.InstancedMesh | null = null;
  private binMarkerEntries: { locationId: string; matrix: THREE.Matrix4 }[] = [];
  /** `ghost` is where the side is going (and decides picking at once); `level` fades toward it, 0 solid to 1 ghosted */
  private binSides: {
    side: "L" | "R";
    door: THREE.InstancedMesh;
    body: THREE.InstancedMesh;
    locations: CabinLocation[];
    extras: THREE.Object3D[];
    ghost: boolean;
    level: number;
  }[] = [];
  /** the shell's sidewalls and ceiling, each ghosted on its own (see updateGhosting) */
  private shellParts: { part: "L" | "R" | "ceiling"; material: THREE.MeshStandardMaterial; ghost: boolean; level: number }[] = [];
  /** when the ghosting fade last stepped; null while nothing fades */
  private ghostClock: number | null = null;
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
  private floorMaterials: { material: THREE.MeshStandardMaterial; lx: number; lz: number; offsetX: number }[] = [];
  /** the seats an open deferral blocks: their badge shows "Blocked" */
  private blocked: ReadonlySet<string> = new Set();
  /** whether the window-side wings (instances n + i of the wing mesh) are shown; null until the first palette */
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
  private readonly touchAxis = new TouchAxisLock();
  private paused = false;
  private hoverPending: PointerEvent | null = null;
  private pickStamp: number | null = null;
  private currentView: CameraView = "cutaway";
  /** a preset change on its way: eased along an arc from one pose to the next, a frame at a time (WEB-21) */
  private transition: { from: CameraPose; to: CameraPose; fromFov: number; toFov: number; start: number; duration: number } | null = null;
  /** true from the controls' start to their end: a change in between is the user's own, and leaves the preset */
  private userGesture = false;
  /** true while the scene itself moves the camera through the controls */
  private placing = false;
  /** the distance of the last preset placed: the user may always zoom out that far (see limitZoomOut) */
  private presetDistance = 0;
  private reducedMotion = false;
  private motionQuery: MediaQueryList | null = null;
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

    // The wheel listener goes on before the controls connect theirs, so it runs first and can keep the wheel from them.
    this.controls = new OrbitControls(this.camera);
    canvas.addEventListener("wheel", this.onWheel);
    this.controls.connect(canvas);
    // the controls set touch-action: none inline; the stylesheet's pan-y lets a vertical drag scroll the page
    canvas.style.touchAction = "";
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 0.8;
    // set per layout from the cabin length
    this.controls.maxDistance = 90;
    // never below the floor: the camera stays above its target
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    // Any user input stops a running transition where it is. A change during the user's own gesture leaves the preset:
    // from then on a resize keeps the camera where the user put it (WEB-09). A click that picks moves nothing, fires no
    // change, and keeps the preset.
    this.controls.addEventListener("start", () => {
      this.userGesture = true;
      this.interruptTransition();
    });
    this.controls.addEventListener("end", () => {
      this.userGesture = false;
    });
    this.controls.addEventListener("change", () => {
      if (this.userGesture && !this.placing) {
        this.interruptTransition();
        this.currentView = "free";
      }
      this.keepTargetInBounds();
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
    const pieceShapes: [string, THREE.BufferGeometry[]][] = [
      ["CUSHION", [g.pan]],
      ["BACKREST", [g.backCore, g.backFront, g.rearShell]],
      ["HEADREST", [g.headrest]],
      ["SEATBELT", [g.belt]],
      ["TRAY", [g.tray]],
      ["SEATBACK_NET", [g.net]],
      ["LIFE_VEST", [g.vest]],
      ["ARMREST", [g.armPad]],
    ];
    for (const [component, parts] of pieceShapes) this.pieceHulls.set(component, keep(hullGeometry(parts)));
    const marks = (hull: THREE.Mesh, rings: Marks["rings"]): Marks => {
      keep(hull.material as THREE.Material);
      if (hull instanceof THREE.InstancedMesh) keep(hull);
      const frame = createFrame();
      keep(frame.material as THREE.Material);
      keep(frame.geometry);
      hull.visible = frame.visible = false;
      this.groups.marks.add(hull, frame);
      return { hull, frame, rings, location: null, piece: null };
    };
    this.selectionMarks = marks(
      createOutline(this.seatHull, SELECT_COLOUR, SELECTION_OUTLINE.widthMetres, { minPixels: SELECTION_OUTLINE.minPixels, viewport: this.viewport }),
      SELECTION_FRAME,
    );
    this.hoverMarks = marks(
      createOutline(this.seatHull, this.theme.outline, HOVER_OUTLINE.widthMetres, {
        minPixels: HOVER_OUTLINE.minPixels,
        inner: HOVER_OUTLINE.inner,
        viewport: this.viewport,
      }),
      hoverFrame(this.theme.outline),
    );

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    // prefers-reduced-motion: preset changes cut and the orbit does not glide; read now and whenever it changes. Set after
    // the marks exist, since it updates the ghosting.
    this.motionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.motionQuery?.addEventListener("change", this.onMotionChange);
    this.setReducedMotion(this.motionQuery?.matches ?? false);
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
          // the top of an armrest's pad
          if (location.kind === "ARMREST") centre.set(location.placement.x - 0.03, location.placement.y + location.placement.ly, location.placement.z);
          const v = centre.project(this.camera);
          const rect = this.canvas.getBoundingClientRect();
          return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
        },
        screenPointOfPiece: (locationId, componentId) => {
          // a point of the piece that a pick from the camera reaches
          const point = this.bins?.open?.location.id === locationId ? this.bins.pointOf(componentId, this.camera.position.clone()) : null;
          if (!point) return null;
          const v = point.project(this.camera);
          const rect = this.canvas.getBoundingClientRect();
          return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
        },
        describeScene: () => ({
          seats: this.seats.length,
          floorAreas: this.floorMeshes.filter((f) => f.locationId).length,
          binModules: this.binSides.reduce((n, b) => n + b.locations.length, 0),
          /** the bin opening or open, how far it is open, and whether it is moving */
          openBin: this.bins?.target ?? null,
          binLevel: this.bins?.level ?? 0,
          binAnimating: this.bins?.animating ?? false,
          /** each side's closed door and body materials as drawn: ghosted (transparent) or solid, and their opacity */
          binGhost: Object.fromEntries(
            this.binSides.map((b) => {
              const door = b.door.material as THREE.Material;
              const body = b.body.material as THREE.Material;
              return [b.side, { transparent: door.transparent && body.transparent, opacity: door.opacity, bodyOpacity: body.opacity }];
            }),
          ),
          profile: this.palette.id,
          light: this.light,
          background: `#${(this.scene.background as THREE.Color).getHexString()}`,
          view: this.currentView,
          transitioning: this.transition !== null,
          ghostFading: this.ghostClock !== null,
          reducedMotion: this.reducedMotion,
          damping: this.controls.enableDamping,
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
            /** the seat part outlined by the hover marks, and the piece a pick there selects */
            hoverPart: this.hoverMarks.piece?.piece.part ?? null,
            badges: this.badges?.visible ? this.badges.count : 0,
            /** the coloured bands on the faces of shut bins with a status */
            binMarkers: this.binMarkers?.visible ? this.binMarkers.count : 0,
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
    if (!sameRevision) this.frameView("cutaway", null, false);
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
    // a bin open on the old layout goes with it (read before its resources are released, which shuts it)
    const binWasOpen = this.bins?.target ?? null;
    this.clearGroup(this.groups.seats);
    this.clearGroup(this.groups.floor);
    this.clearGroup(this.groups.bins);
    this.clearGroup(this.groups.context);
    this.layoutResources.disposeAll();
    this.pieces = [];
    this.bulkheadPanels = null;
    this.floorMeshes = [];
    this.floorTintEntries = [];
    this.bins = null;
    this.binInterior = null;
    this.binMarkers = null;
    this.binMarkerEntries = [];
    this.binSides = [];
    this.shellParts = [];
    this.paletteMaterials = [];
    this.floorMaterials = [];
    this.windowWingsShown = null;
    this.binHulls = {};
    this.frames.clear();
    if (this.badges) this.groups.marks.remove(this.badges);
    this.badges = null;
    this.badgeEntries = [];
    // the marks may show geometry of the layout released above
    this.hovered = null;
    this.hoverMarks.piece = this.selectionMarks.piece = null;
    for (const m of [this.selectionMarks, this.hoverMarks]) m.hull.visible = m.frame.visible = false;
    const own = <T extends Disposable>(resource: T): T => this.layoutResources.track(resource);
    const length = layout.geometry.cabinLength;
    const halfW = layout.geometry.cabinHalfWidth;
    const rows = layout.rows.filter((r) => r.exists).length;
    this.limitZoomOut();

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
    // Seat parts get their materials for the visual family from applyPalette(); until then they share this one. Each part
    // is one instanced mesh; the tray and net on a seat's back belong to the seat behind, the pads to the armrests.
    // (The pale surround of the banded family is the upper-back band itself, drawn in the texture.)
    const unpainted = own(new THREE.MeshBasicMaterial());
    const pieces = buildPieceMeshes(layout, this.geoms, unpainted);
    for (const geometry of pieces.geometries) own(geometry);
    for (const piece of pieces) {
      own(piece.mesh);
      this.groups.seats.add(piece.mesh);
    }
    this.pieces = [...pieces];
    // The first row's trays and nets sit on a thin panel ahead of it, placed where a seat's back would be.
    if (pieces.panels.length > 0) {
      const panels = own(new THREE.InstancedMesh(own(buildBulkheadPanel()), unpainted, pieces.panels.length));
      pieces.panels.forEach((m, i) => {
        panels.setMatrixAt(i, m);
      });
      panels.instanceMatrix.needsUpdate = true;
      panels.computeBoundingSphere();
      this.groups.seats.add(panels);
      this.bulkheadPanels = panels;
    }

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

    // The tier tint covers the pan. The status tint is drawn by each piece's own material (see pieces), at a partial
    // opacity, so the upholstery stays visible (WEB-21).
    this.panOverlay = n ? own(new THREE.InstancedMesh(this.geoms.panOverlay, own(createOverlayMaterial(0.6)), n)) : null;
    if (this.panOverlay) {
      this.panOverlay.renderOrder = 5;
      this.panOverlay.setColorAt(0, WHITE);
      this.groups.seats.add(this.panOverlay);
    }
    // badges above each headrest
    this.geoms.headrest.computeBoundingBox();
    const head = this.geoms.headrest.boundingBox ?? new THREE.Box3();
    const badgeOnSeat = new THREE.Vector3((head.min.x + head.max.x) / 2, head.max.y + BADGE_ABOVE_HEADREST, 0);
    for (const seat of this.seats) {
      this.badgeEntries.push({
        locationId: seat.location.id,
        seat: true,
        layer: "seats",
        matrix: seat.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(badgeOnSeat)),
      });
    }
    // an armrest's badge sits above its pad
    this.geoms.armPad.computeBoundingBox();
    const pad = this.geoms.armPad.boundingBox ?? new THREE.Box3();
    for (const a of layout.locations.filter((l) => l.kind === "ARMREST")) {
      this.badgeEntries.push({
        locationId: a.id,
        seat: false,
        layer: "seats",
        matrix: new THREE.Matrix4().makeTranslation(a.placement.x + (pad.min.x + pad.max.x) / 2, pad.max.y + BADGE_ABOVE_ARMREST, a.placement.z),
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
    for (const a of areas)
      this.badgeEntries.push({ locationId: a.id, seat: false, layer: "floor", matrix: new THREE.Matrix4().makeTranslation(a.placement.x, 0.07, 0) });
    if (layout.locations.some((l) => l.id === FULL_CABIN)) {
      this.badgeEntries.push({
        locationId: FULL_CABIN,
        seat: false,
        layer: "floor",
        matrix: new THREE.Matrix4().makeTranslation(Math.min(0.8, length / 2), 0.07, 0),
      });
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
    // Textures shared by every family come from the cache and are not this layout's to release; the repeated copies are.
    const service = getTexture(textureKey("serviceUnit", "shared", SERVICE_UNIT_TEXTURE_SIZE), serviceUnitTexture);
    const doorTexture = getTexture(textureKey("binDoor", "shared", BIN_DOOR_TEXTURE_SIZE), binDoorTexture);
    // Double-sided surfaces that turn transparent when ghosted draw in one pass, not two (WEB-20); at ghost opacity
    // the back-then-front ordering a second pass buys is not visible.
    const singlePass = { side: THREE.DoubleSide, forceSinglePass: true };
    // An open bin's inside is two meshes with one material: a shade and a status tint per vertex (seatParts.ts BinRun).
    this.binInterior = withStatusTint(std("#ffffff", 0.6, 0, { vertexColors: true, ...singlePass }));
    const bins = own(
      // each side its own door and body material: one side is ghosted while the other is solid (updateGhosting)
      new BinRun(layout, {
        door: () => own(new THREE.MeshStandardMaterial({ map: doorTexture, roughness: 0.42, ...singlePass })),
        body: () => std("#d5d8df", 0.6, 0, singlePass),
        interior: this.binInterior,
      }),
    );
    this.bins = bins;
    this.groups.bins.add(bins.group);
    for (const b of bins.sides) {
      const sign = b.sign;
      this.binHulls[b.side] = own(hullGeometry([b.door.geometry, b.body.geometry]));
      // a bin's badge sits on its door, on the aisle side; its marker along the face below
      for (const l of b.locations) {
        this.badgeEntries.push({ locationId: l.id, seat: false, layer: "bins", matrix: new THREE.Matrix4().makeTranslation(l.placement.x, 1.95, sign * 0.8) });
        this.binMarkerEntries.push({
          locationId: l.id,
          matrix: new THREE.Matrix4().makeScale(Math.max(l.placement.lx - 0.3, 0.1), 1, sign).setPosition(l.placement.x, 0, 0),
        });
      }
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
      this.groups.bins.add(psu);
      this.binSides.push({ side: b.side, door: b.door, body: b.body, locations: b.locations, extras: [psu], ghost: false, level: 0 });
    }
    if (this.binMarkerEntries.length > 0) {
      // unlit, like the status overlays, so the band is the legend's colour; mirrored on the right by its instance
      const markers = own(
        new THREE.InstancedMesh(
          own(buildBinMarker()),
          own(new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide })),
          this.binMarkerEntries.length,
        ),
      );
      markers.setColorAt(0, WHITE);
      markers.frustumCulled = false;
      this.groups.bins.add(markers);
      this.binMarkers = markers;
    }

    // context (secondary, hidden by default) --------------------------------------------------
    // The cabin shell from shellProfile() (WEB-21): two sidewalls with a recessed window per row pitch, the arched ceiling
    // with its light channels, and the two plain end bulkheads: four draw calls. Shell materials draw back faces only, so
    // from outside the near wall shows nothing and the far wall its inside; ghosting fades what is left (updateGhosting).
    const pitch = layout.geometry.rowPitch;
    const windowCount = Math.max(0, Math.round((length - FORWARD_MARGIN - AFT_MARGIN) / pitch));
    const windowXs = Array.from({ length: windowCount }, (_, i) => FORWARD_MARGIN + (i + 0.5) * pitch);
    const shell = buildShellGeometries(shellProfile(), length, windowXs);
    for (const g of Object.values(shell)) own(g);
    // Transparent from the start, so ghosting changes only opacity and depth writes, never the shader program.
    const shellMaterial = (extra: THREE.MeshStandardMaterialParameters) => std("#ffffff", 0.85, 0, { side: THREE.BackSide, transparent: true, ...extra });
    for (const side of ["L", "R"] as const) {
      const material = shellMaterial({ vertexColors: true });
      this.groups.context.add(new THREE.Mesh(side === "L" ? shell.left : shell.right, material));
      this.shellParts.push({ part: side, material, ghost: false, level: 0 });
    }
    // the light channels glow (emissive, masked to the channels); they light nothing, the environment does that
    const ceilingMaterial = shellMaterial({ color: "#f1f2f5", emissive: "#ffffff", emissiveIntensity: 1.6, emissiveMap: own(lightChannelMask()) });
    const ceilingMesh = new THREE.Mesh(shell.ceiling, ceilingMaterial);
    ceilingMesh.userData.wash = true;
    this.groups.context.add(ceilingMesh);
    this.shellParts.push({ part: "ceiling", material: ceilingMaterial, ghost: false, level: 0 });
    // a transparent double-sided plate would draw in two passes; at this opacity one is enough
    const bulkheadMaterial = std("#e2e4ea", 0.7, 0, { transparent: true, opacity: 0.55, side: THREE.DoubleSide, forceSinglePass: true });
    this.groups.context.add(new THREE.Mesh(shell.bulkheads, bulkheadMaterial));

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
    this.updateGhosting(true);
    if (binWasOpen !== null) this.callbacks.onBinOpenChange?.(null);
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
    // A piece draws its own status tint, so each piece part has a material of its own: a mesh drawn with a tinted
    // material must carry the tint attribute (seatParts.ts buildPieceMeshes), and a clone does not keep the tint.
    const tinted = <T extends THREE.Material>(material: T): T => withStatusTint(mine(material.clone()));
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
      pan: withStatusTint(mine(upholsteryVariant(set.upholstery, { maps: this.seatMaps("pan", p) }))),
      backCore: withStatusTint(plain(p.upholsteryDark)),
      backFront: tinted(set.upholstery),
      rearShell: withStatusTint(rearShell),
      rearRelief: tinted(set.shell),
      headrest: withStatusTint(plain(p.headrest)),
      arms,
      armPads: tinted(set.pad),
      wings: withStatusTint(wings),
      belt: tinted(set.pad),
      tray: tinted(set.shell),
      net: tinted(set.pad),
      vest: withStatusTint(plain(p.upholsteryDark)),
    };
    for (const piece of this.pieces) piece.mesh.material = materials[piece.part];
    if (this.bulkheadPanels) this.bulkheadPanels.material = set.shell;
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
    const wings = this.piece("wings");
    if (!wings || this.windowWingsShown === shown) return;
    const n = this.seats.length;
    for (let i = n; i < wings.matrices.length; i++) wings.mesh.setMatrixAt(i, shown ? (wings.matrices[i] ?? ZERO) : ZERO);
    wings.mesh.instanceMatrix.needsUpdate = true;
    wings.mesh.computeBoundingSphere();
    this.windowWingsShown = shown;
  }

  /** The instanced mesh of one seat part, if the layout has seats. */
  private piece(part: SeatPart): PieceMesh | undefined {
    return this.pieces.find((p) => p.part === part);
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
    this.scene.background = new THREE.Color(blue ? "#2a3566" : this.theme.background);
    this.scene.environment = this.environmentFor(this.light);
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY[this.light];
    this.lights.key.color.set(blue ? "#b9c5ff" : "#fff8ee");
    this.lights.key.intensity = blue ? 1.2 : 1.4;
    this.lights.fill.intensity = blue ? 0.8 : 0;
    this.renderer.toneMappingExposure = blue ? 1.05 : 1.0;
    this.groups.context.traverse((o) => {
      if (o.userData.wash) ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.set(blue ? "#6f8dff" : this.theme.wash);
    });
  }

  /**
   * Follow the page theme (WEB-16): the background in neutral light, the hover outline and the ceiling wash. Status and
   * select colours stay. Colours are compared and kept as six-digit hex, so "#fff" and "#ffffff" are the same theme.
   */
  setTheme(theme: SceneTheme): void {
    const next: SceneTheme = { background: hex6(theme.background), outline: hex6(theme.outline), wash: hex6(theme.wash) };
    if (next.background === this.theme.background && next.outline === this.theme.outline && next.wash === this.theme.wash) return;
    this.theme = next;
    (this.hoverMarks.hull.material as THREE.MeshBasicMaterial).color.set(next.outline);
    this.hoverMarks.rings = hoverFrame(next.outline);
    if (this.hoverMarks.location) this.placeMarks(this.hoverMarks, this.hoverMarks.location, "hover", this.hoverMarks.piece);
    this.applyLight();
    this.invalidate();
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
    const vest = this.piece("vest");
    if (vest) vest.mesh.visible = this.layers.underSeat;
    this.groups.floor.visible = this.layers.floor;
    this.groups.bins.visible = this.layers.bins;
    this.groups.context.visible = this.layers.context;
    this.applyBadges();
    this.invalidate();
  }

  /**
   * In an outside view, the bins and the shell's sidewall nearest the camera are ghosted, and the bins excluded from
   * picking so they never block the seats; seen from above, both bin rows and both sidewalls are ghosted, and from
   * anywhere outside the shell its ceiling. Picking follows at once; the look fades over 150 ms (WEB-21), or changes at
   * once with reduced motion or when `instant` (a new layout).
   */
  private updateGhosting(instant = false): void {
    const cam = this.camera.position;
    // inside the cabin: over the aisle and below the ceiling (one test for the bins and the shell)
    const inside = Math.abs(cam.z) < 0.7 && cam.y < CEILING_HEIGHT;
    const offset = cam.clone().sub(this.controls.target);
    const above = offset.y / Math.max(offset.length(), 0.001) > 0.9 && cam.y > 4;
    for (const b of this.binSides) {
      b.ghost = !inside && (above || (b.side === "L" ? cam.z > 0.7 : cam.z < -0.7));
      b.door.userData.ghost = b.ghost;
    }
    for (const m of [this.selectionMarks, this.hoverMarks]) this.ghostOutline(m);
    // The shell: from outside it (above the ceiling, or beside the aisle) the ceiling ghosts, and so does each sidewall
    // between the camera and the centreline; from above, both. From inside, as in the aisle view, all of it is solid.
    for (const c of this.shellParts) {
      const near = c.part === "ceiling" || above || (c.part === "L" ? cam.z > 0.7 : cam.z < -0.7);
      c.ghost = !inside && near;
    }
    if (instant || this.reducedMotion) {
      for (const g of [...this.binSides, ...this.shellParts]) g.level = g.ghost ? 1 : 0;
      this.ghostClock = null;
      this.applyGhostLevels();
    } else if (this.ghostClock === null && [...this.binSides, ...this.shellParts].some((g) => g.level !== (g.ghost ? 1 : 0))) {
      this.ghostClock = performance.now();
      this.invalidate();
    }
  }

  /** Move each ghosting level toward where it is going, by the time since the last step; the clock stops when all arrive. */
  private stepGhostFade(now: number): void {
    if (this.ghostClock === null) return;
    const step = Math.max(now - this.ghostClock, 0) / GHOST_FADE_MS;
    this.ghostClock = now;
    let fading = false;
    for (const g of [...this.binSides, ...this.shellParts]) {
      const goal = g.ghost ? 1 : 0;
      g.level = goal > g.level ? Math.min(goal, g.level + step) : Math.max(goal, g.level - step);
      if (g.level !== goal) fading = true;
    }
    this.applyGhostLevels();
    if (!fading) this.ghostClock = null;
  }

  private applyGhostLevels(): void {
    for (const b of this.binSides) {
      const opacity = THREE.MathUtils.lerp(1, BIN_GHOST_OPACITY, b.level);
      for (const o of [b.door, b.body, ...b.extras] as THREE.Mesh[]) setGhosted(o.material as THREE.Material, b.level > 0, opacity);
      // an open bin's inside ghosts with its side
      if (this.binInterior && this.bins?.open?.side.side === b.side) setGhosted(this.binInterior, b.level > 0, opacity);
    }
    for (const c of this.shellParts) {
      c.material.opacity = THREE.MathUtils.lerp(1, WALL_GHOST_OPACITY, c.level);
      c.material.depthWrite = c.level === 0;
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
   * seat pieces (each by its own status), floor areas and bin doors.
   */
  private applyStates(): void {
    this.updates.applyStates += 1;
    const status = this.colourMode === "status";
    const colourFor = (s: LocationStatus) => (s === "none" ? null : STATUS_COLOUR[s]);
    if (this.panOverlay) {
      // Only the tinted seats are drawn: they are packed first and the count stops after them, so an untinted seat costs
      // no triangles, and an overlay with nothing to show costs no draw call (WEB-20).
      let pans = 0;
      for (const s of this.seats) {
        const pan = this.colourMode === "tier" ? (TIER_COLOUR[s.location.seat?.commercialTier ?? s.location.seat?.maintenanceZone ?? ""] ?? null) : null;
        if (!pan) continue;
        this.panOverlay.setMatrixAt(pans, s.matrix);
        this.panOverlay.setColorAt(pans++, pan);
      }
      this.panOverlay.count = pans;
      this.panOverlay.visible = pans > 0;
      this.panOverlay.instanceMatrix.needsUpdate = true;
      if (this.panOverlay.instanceColor) this.panOverlay.instanceColor.needsUpdate = true;
    }
    // Each piece draws its own status tint: no triangles and no draw call of its own, however many pieces have a status
    // (WEB-20). The tint is the piece's own status; the badge shows the location's.
    for (const piece of this.pieces) {
      const { tint } = piece;
      if (!tint) continue;
      piece.locations.forEach((l, i) => {
        const component = piece.components[i];
        const pieceStatus = component ? this.states.get(l.id)?.components[component] : undefined;
        const colour = status && pieceStatus ? colourFor(pieceStatus) : null;
        if (colour) tint.setXYZW(i, colour.r, colour.g, colour.b, HEADREST_TINT_OPACITY);
        else tint.setXYZW(i, 0, 0, 0, 0);
      });
      tint.needsUpdate = true;
    }
    if (this.floorTint) {
      // packed and counted like the pan tint
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
    // A shut bin's door shows the bin's status, an open bin's face its door's own, and its inside each piece's own. A
    // bin is open here for as long as it is drawn open, closing included.
    const open = this.drawnOpenBin();
    for (const b of this.binSides) {
      b.locations.forEach((l, i) => {
        const s = !status ? "none" : l.id === open ? (this.states.get(l.id)?.components.BIN_DOOR ?? "none") : this.statusOf(l.id);
        b.door.setColorAt(i, s === "none" ? WHITE : BIN_STATUS_COLOUR[s]);
      });
      if (b.door.instanceColor) b.door.instanceColor.needsUpdate = true;
    }
    const inside = this.bins?.open?.location.id;
    this.bins?.tint((piece) => {
      const s = status && inside ? this.states.get(inside)?.components[piece] : undefined;
      return s ? colourFor(s) : null;
    }, HEADREST_TINT_OPACITY);
    if (this.binMarkers) {
      // a shut bin with a status carries a band in its colour on its face, shown with the badges (packed like floorTint)
      let markers = 0;
      for (const m of this.binMarkerEntries) {
        const s = this.colourMode === "none" || m.locationId === open ? "none" : this.statusOf(m.locationId);
        if (s === "none") continue;
        this.binMarkers.setMatrixAt(markers, m.matrix);
        this.binMarkers.setColorAt(markers++, STATUS_COLOUR[s]);
      }
      this.binMarkers.count = markers;
      this.binMarkers.visible = markers > 0;
      this.binMarkers.instanceMatrix.needsUpdate = true;
      if (this.binMarkers.instanceColor) this.binMarkers.instanceColor.needsUpdate = true;
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
      if (this.colourMode === "none" || !this.layers[b.layer]) continue;
      // an open bin, closing included, shows its pieces' own tints instead
      if (b.layer === "bins" && b.locationId === this.drawnOpenBin()) continue;
      // a blocked seat shows "Blocked" in grey, over whatever status it has
      const blocked = b.seat && this.blocked.has(b.locationId);
      const s = blocked ? "none" : this.statusOf(b.locationId);
      if (!blocked && s === "none") continue;
      badges.setMatrixAt(shown, b.matrix);
      badges.setColorAt(shown, blocked ? BLOCKED_COLOUR : STATUS_COLOUR[s as Exclude<LocationStatus, "none">]);
      cells.setX(shown++, BADGE_GLYPHS.indexOf(blocked ? "blocked" : STATUS_ENCODING[s].glyph));
    }
    badges.count = shown;
    badges.visible = shown > 0;
    badges.instanceMatrix.needsUpdate = true;
    if (badges.instanceColor) badges.instanceColor.needsUpdate = true;
    cells.needsUpdate = true;
  }

  /** The seats an open deferral blocks (buildStates' flags.blocked): their badge shows "Blocked". */
  setBlocked(blocked: ReadonlySet<string>): void {
    this.blocked = blocked;
    this.applyBadges();
    this.invalidate();
  }

  setSelection(locationId: string | null): void {
    this.selection = locationId;
    this.applySelection();
  }

  private boxOf(location: CabinLocation): { centre: THREE.Vector3; size: THREE.Vector3 } {
    const p = location.placement;
    if (location.kind === "SEAT") return { centre: new THREE.Vector3(p.x + 0.07, 0.6, p.z), size: new THREE.Vector3(0.74, 1.22, SEAT.width + 0.07) };
    if (location.kind === "FLOOR") return { centre: new THREE.Vector3(p.x, 0.03, 0), size: new THREE.Vector3(p.lx - 0.04, 0.06, p.lz - 0.04) };
    if (location.kind === "ARMREST") return { centre: new THREE.Vector3(p.x, p.y + p.ly / 2, p.z), size: new THREE.Vector3(p.lx, p.ly, p.lz) };
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

  /**
   * Outline a location, or hide the marks: a hull around a seat, armrest pad or bin module, a frame inside a floor area's
   * edge. With `piece` (a seat part's instance) only that piece is outlined.
   */
  private placeMarks(marks: Marks, location: CabinLocation | null, kind: "selection" | "hover", piece: PiecePick | null = null): void {
    marks.hull.visible = marks.frame.visible = false;
    marks.location = location;
    marks.piece = location ? piece : null;
    if (kind === "hover") this.hovered = location?.id ?? null;
    this.ghostOutline(marks);
    if (!location) return;
    const p = location.placement;
    if (location.kind === "FLOOR") {
      // the hover frame's colour follows the theme, so a frame is kept per colour
      const key = `${location.id}|${kind}|${hex6(marks.rings[0]?.colour ?? "#000000")}`;
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
    const component = piece ? piece.piece.components[piece.instance] : null;
    const hull = component ? this.pieceHulls.get(component) : undefined;
    if (piece && hull) {
      // a mirrored wing face outlines the backrest of its seat, unmirrored
      const matrix = piece.piece.part === "wings" ? this.seats.find((s) => s.location.id === location.id)?.matrix : piece.piece.matrices[piece.instance];
      if (!matrix) return;
      marks.hull.geometry = hull;
      marks.hull.matrix.copy(matrix);
    } else if (location.kind === "SEAT") {
      const seat = this.seats.find((s) => s.location.id === location.id);
      if (!seat) return;
      marks.hull.geometry = this.seatHull;
      marks.hull.matrix.copy(seat.matrix);
    } else if (location.kind === "ARMREST") {
      const pad = this.pieceHulls.get("ARMREST");
      if (!pad) return;
      marks.hull.geometry = pad;
      marks.hull.matrix.makeTranslation(p.x, 0, p.z);
    } else {
      // an open bin (closing included) is not outlined: its shut shape is not where its door or bucket is
      if (this.drawnOpenBin() === location.id) return;
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
    return new THREE.Box3(
      new THREE.Vector3(0, 0, -g.cabinHalfWidth),
      new THREE.Vector3(g.cabinLength, this.layers.bins ? CABIN_HEIGHT : 1.25, g.cabinHalfWidth),
    );
  }

  /** The cabin box for the camera rig: the target stays inside it plus half a metre. */
  private bounds(): CabinBounds | null {
    const g = this.layout?.geometry;
    return g ? { length: g.cabinLength, halfWidth: g.cabinHalfWidth, height: CABIN_HEIGHT } : null;
  }

  private pose(): CameraPose {
    return { position: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  /**
   * On every change the target is kept in the cabin box (the camera moves with it, so a pan stops at the edge instead of
   * turning the view) and the camera above the floor.
   */
  private keepTargetInBounds(): void {
    const bounds = this.bounds();
    if (!bounds) return;
    const bounded = boundPose(this.pose(), bounds);
    this.camera.position.copy(bounded.position);
    this.controls.target.copy(bounded.target);
  }

  /**
   * How far out the camera may go: 1.4 cabin lengths, or the distance of the last preset if that is further (a whole
   * cabin from above on a phone needs more), so every preset is reachable and the user cannot zoom out past either.
   * `atLeast` keeps a camera further out than both where it is, during or after a transition from there.
   */
  private limitZoomOut(atLeast = 0): void {
    const length = this.layout?.geometry.cabinLength;
    if (length === undefined) return;
    this.controls.maxDistance = Math.max(length * 1.4, this.presetDistance, atLeast);
  }

  /** User input during a transition stops it where it is: the camera is no longer on the preset, so the view is free. */
  private interruptTransition(): void {
    if (!this.transition) return;
    this.transition = null;
    this.currentView = "free";
    this.limitZoomOut(this.camera.position.distanceTo(this.controls.target));
  }

  /** Move the camera through the controls without that counting as the user's own move. */
  private place(fn: () => void): void {
    const placing = this.placing;
    this.placing = true;
    try {
      fn();
    } finally {
      this.placing = placing;
    }
  }

  /** Spend what is left of a glide from an earlier drag at once, so it does not carry on into a preset. */
  private stopGlide(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.place(() => this.controls.update());
    this.controls.enableDamping = damping;
  }

  /**
   * Frame the cabin or a location. Views are fitted to the viewport so the cabin fills it. The camera eases there from
   * wherever it is, along an arc, in 250–700 ms; with reduced motion it cuts. A new call or any user input stops a
   * running transition where it is. "free" is not a preset: it is what the user's own moves make.
   */
  setCamera(view: PresetView, locationId?: string | null): void {
    if ((view as CameraView) === "free") return;
    this.frameView(view, locationId ?? null, true);
  }

  /**
   * Frame a location selected outside the canvas (map, list, work list, go-to), if it is not already in view: when it
   * projects outside the central 80 % of the view or a bin hides it, the camera moves to it. True if it moved.
   */
  revealLocation(locationId: string): boolean {
    if (!this.layout || this.paused) return false;
    const location = this.layout.locations.find((l) => l.id === locationId);
    if (!location) return false;
    const point = this.boxOf(location).centre;
    this.camera.updateMatrixWorld();
    const v = point.clone().project(this.camera);
    const outside = Math.abs(v.z) > 1 || Math.abs(v.x) > REVEAL_CENTRAL || Math.abs(v.y) > REVEAL_CENTRAL;
    if (!outside && !this.hiddenByBins(location, point)) return false;
    this.frameView("focus", locationId, true);
    return true;
  }

  /** Whether a solid (unghosted) bin module lies between the camera and a point of a seat or floor area. */
  private hiddenByBins(location: CabinLocation, point: THREE.Vector3): boolean {
    if (location.kind === "BIN" || !this.layers.bins) return false;
    const toPoint = point.clone().sub(this.camera.position);
    const distance = toPoint.length();
    this.raycaster.set(this.camera.position, toPoint.normalize());
    this.raycaster.far = distance - 0.05;
    const solid = this.binSides.filter((b) => !b.ghost).flatMap((b) => [b.door, b.body]);
    const hit = this.raycaster.intersectObjects(solid, false).length > 0;
    this.raycaster.far = Number.POSITIVE_INFINITY;
    return hit;
  }

  /** Frame a view: at once (a new layout, a resize) or eased from the current pose. */
  private frameView(view: PresetView, locationId: string | null, animate: boolean): void {
    if (!this.layout) return;
    this.transition = null;
    this.stopGlide();
    const from = this.pose();
    const fromFov = this.camera.fov;
    // the preset is placed without a zoom limit; the limit then follows the preset's distance
    this.controls.maxDistance = Number.POSITIVE_INFINITY;
    this.place(() => this.placePreset(view, locationId ?? this.selection));
    const to = this.pose();
    const toFov = this.camera.fov;
    this.presetDistance = to.position.distanceTo(to.target);
    const duration = animate ? transitionMs(from, to, this.reducedMotion) : 0;
    if (duration > 0) {
      this.transition = { from, to, fromFov, toFov, start: performance.now(), duration };
      // back to where it starts; the frames move it
      this.applyPose(from, fromFov);
      this.limitZoomOut(from.position.distanceTo(from.target));
    } else this.limitZoomOut();
    this.updateGhosting();
    this.invalidate();
  }

  private applyPose(pose: CameraPose, fov: number): void {
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(pose.target);
  }

  /** One frame of a running transition; the controls' update() that follows draws it. */
  private stepTransition(now: number): void {
    const t = this.transition;
    if (!t) return;
    const progress = Math.min((now - t.start) / t.duration, 1);
    const eased = easeInOutCubic(progress);
    this.applyPose(interpolatePose(t.from, t.to, eased), THREE.MathUtils.lerp(t.fromFov, t.toFov, eased));
    if (progress >= 1) {
      this.transition = null;
      this.limitZoomOut();
    }
    this.needsRender = true;
  }

  private onMotionChange = (e: MediaQueryListEvent) => {
    this.setReducedMotion(e.matches);
  };

  private setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.controls.enableDamping = !reduced;
    if (reduced && this.transition) {
      // a transition under way finishes at once
      this.applyPose(this.transition.to, this.transition.toFov);
      this.transition = null;
      this.limitZoomOut();
      this.place(() => this.controls.update());
    }
    if (reduced) {
      this.updateGhosting(true);
      // a bin opening or closing gets there at once
      const drawn = this.drawnOpenBin();
      this.bins?.finish();
      if (this.drawnOpenBin() !== drawn) this.binDrawnChanged();
    }
    this.invalidate();
  }

  /** Put the camera on a preset, at once. */
  private placePreset(view: PresetView, locationId: string | null): void {
    const layout = this.layout;
    if (!layout) return;
    const g = layout.geometry;
    const aspect = this.camera.aspect;
    const centre = new THREE.Vector3(g.cabinLength / 2, 0.75, 0);
    this.camera.fov = 36;
    const location = locationId ? layout.locations.find((l) => l.id === locationId) : undefined;
    if ((view === "focus" || view === "focus-rear") && !location) {
      this.placePreset("cutaway", null);
      return;
    }
    this.currentView = view;
    this.viewLocation = location?.id ?? null;
    const set = (position: THREE.Vector3, target: THREE.Vector3, fov = 36) => {
      this.camera.fov = fov;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.camera.updateProjectionMatrix();
      this.controls.update();
    };
    if (view === "cutaway") {
      // Seen from the forward quarter so the cabin recedes and fills the frame instead of lying as a thin strip.
      const dir = aspect >= 1.15 ? new THREE.Vector3(-0.52, 0.52, 0.68) : new THREE.Vector3(-0.86, 0.72, 0.34);
      this.fit(dir, centre, this.cabinBox());
    } else if (view === "overhead") {
      const dir = aspect >= 1 ? new THREE.Vector3(0, 1, 0.12) : new THREE.Vector3(-0.12, 1, 0);
      this.fit(dir, new THREE.Vector3(g.cabinLength / 2, 0, 0), this.cabinBox(), 0.96);
    } else if (view === "aisle") {
      set(new THREE.Vector3(0.2, 1.78, 0), new THREE.Vector3(Math.min(7, g.cabinLength), 0.85, 0), 62);
    } else if (view === "carpet") {
      const x = Math.min(g.cabinLength / 2, 6);
      set(new THREE.Vector3(x - 0.3, 2.05, 0), new THREE.Vector3(x, 0, 0), 50);
    } else if (view === "bins") {
      // from standing height: the camera stays above its target (maxPolarAngle), so it does not look up at the bins
      const x = Math.min(g.cabinLength / 2, 6.2);
      set(new THREE.Vector3(x - 1.5, 1.62, 0.3), new THREE.Vector3(x + 0.7, 1.5, -1.3), 52);
    } else if (location && view === "focus-rear" && location.kind === "SEAT") {
      const p = location.placement;
      const toAisle = p.z > 0 ? -1 : 1;
      set(new THREE.Vector3(p.x + 1.3, 1.34, p.z + toAisle * 0.42), new THREE.Vector3(p.x + 0.32, 0.8, p.z));
    } else if (location) {
      // "focus", and "focus-rear" of a floor area or bin: the location from the aisle side
      const bounds = this.bounds();
      if (!bounds) return;
      // an armrest is framed as its seat is
      const armrest = location.kind === "ARMREST";
      const pose = poseToFrame(armrest ? { ...location.placement, y: 0 } : location.placement, armrest ? "SEAT" : location.kind, bounds);
      set(pose.position, pose.target);
    }
  }

  /** Keyboard and button camera control: orbit, tilt and zoom around the current target. */
  nudge(action: "left" | "right" | "up" | "down" | "in" | "out"): void {
    // user input: a running transition stops where it is
    this.interruptTransition();
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
    this.place(() => this.controls.update());
    this.updateGhosting();
    this.invalidate();
  }

  // ---- bins -----------------------------------------------------------------------------------

  /**
   * Open a bin, shutting any other at once (at most one is open), or close the open one with null. It opens over 350 ms,
   * easing out; at once with reduced motion or while the view is hidden. The same bin again, or a location that is not a
   * pickable bin, changes nothing. onBinOpenChange reports each change.
   */
  openBin(locationId: string | null): void {
    const bins = this.bins;
    // a layout whose bins are not pickable (no bin map) opens none
    if (!bins || this.disposed || (locationId !== null && !this.pickableFloorBins)) return;
    if (!bins.openBin(locationId, performance.now(), this.reducedMotion || this.paused)) return;
    this.binDrawnChanged();
    this.callbacks.onBinOpenChange?.(bins.target);
  }

  /** The bin drawn open: opening, open or still closing. */
  private drawnOpenBin(): string | null {
    return this.bins?.open?.location.id ?? null;
  }

  /** Show what follows from which bin is drawn open: its ghosting, the tints, badges and markers, and the outlines. */
  private binDrawnChanged(): void {
    this.applyGhostLevels();
    this.applyStates();
    this.applySelection();
    if (this.hoverMarks.location) this.placeMarks(this.hoverMarks, this.hoverMarks.location, "hover", this.hoverMarks.piece);
    this.invalidate();
  }

  // ---- picking --------------------------------------------------------------------------------

  private hit(clientX: number, clientY: number): { location: CabinLocation; component: string | null; piece?: PiecePick; opensBin?: boolean } | null {
    if (!this.layout) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Only visible, unghosted, selectable objects take part: a hidden layer can never block a pick.
    const targets: THREE.Object3D[] = [];
    targets.push(...pieceTargets(this.pieces, this.layers));
    // the bulkhead panels pick nothing themselves, but hide what is behind them, as they are drawn
    if (this.layers.seats && this.bulkheadPanels) targets.push(this.bulkheadPanels);
    if (this.layers.floor && this.pickableFloorBins) {
      for (const f of this.floorMeshes) if (f.locationId) targets.push(f.mesh);
      // raycasting ignores visibility, so the strip is a target even while it shows no status
      if (this.fullCabinOverlay) targets.push(this.fullCabinOverlay);
    }
    // a ghosted side's bins, shut or open, are not picked
    if (this.layers.bins && this.pickableFloorBins && this.bins)
      targets.push(...this.bins.targets((side) => !this.binSides.find((b) => b.side === side)?.ghost));
    const hits = this.raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first || first.object === this.bulkheadPanels) return null;
    // a seat part: the piece and its owner (the seat behind for a tray or a net, the armrest for a pad)
    const piece = pickPiece(hits, this.pieces);
    if (piece) return { location: piece.location, component: piece.component, piece };
    if (first.object === this.fullCabinOverlay) {
      const location = this.layout.locations.find((l) => l.id === FULL_CABIN);
      return location ? { location, component: null } : null;
    }
    const floor = this.floorMeshes.find((f) => f.mesh === first.object);
    if (floor?.locationId) {
      const location = this.layout.locations.find((l) => l.id === floor.locationId);
      return location ? { location, component: null } : null;
    }
    // a shut bin selects its door, and a tap opens it; inside an open bin, the piece under the pointer
    const bin = this.bins?.pick(hits);
    return bin ? { location: bin.location, component: bin.component, opensBin: bin.closed } : null;
  }

  private static sample(e: PointerEvent): PointerSample {
    return { pointerId: e.pointerId, button: e.button, isPrimary: e.isPrimary, x: e.clientX, y: e.clientY, time: e.timeStamp };
  }

  // Only a short, still, primary left press picks; a right click, a drag, a long press or the end of a pinch does not (WEB-12).
  private onPointerDown = (e: PointerEvent) => {
    if (this.paused) return;
    const sample = CabinScene.sample(e);
    this.gesture.down(sample);
    if (e.pointerType === "touch") this.touchAxis.down(sample);
  };

  private onPointerUp = (e: PointerEvent) => {
    const sample = CabinScene.sample(e);
    if (e.pointerType === "touch") this.touchAxis.up(sample);
    const at = this.gesture.up(sample);
    if (!at || this.paused) return;
    const hit = this.hit(at.x, at.y);
    if (!hit) return;
    if (this.onFrameRendered) this.pickStamp = performance.now();
    if (hit.opensBin) this.openBin(hit.location.id);
    this.callbacks.onPick(hit.location.id, hit.component);
  };

  private onPointerMove = (e: PointerEvent) => {
    const sample = CabinScene.sample(e);
    this.gesture.move(sample);
    // The controls follow moves on the document: a one-finger vertical drag is kept from them, so only the page scrolls.
    if (e.pointerType === "touch" && !this.touchAxis.move(sample)) e.stopPropagation();
    if (this.paused || e.pointerType === "touch" || e.buttons !== 0) return;
    this.hoverPending = e;
    // hover is resolved in the next frame, which draws only if the hover mark changed
    this.requestFrame();
  };

  private onPointerCancel = (e: PointerEvent) => {
    this.gesture.cancel();
    this.touchAxis.up(CabinScene.sample(e));
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
    // only the piece under the pointer is outlined, so moving from one piece of a seat to another moves the outline
    const piece = target && hit?.piece ? hit.piece : null;
    const shown = this.hoverMarks.piece;
    const samePiece = piece === null ? shown === null : shown !== null && shown.piece === piece.piece && shown.instance === piece.instance;
    if ((target?.id ?? null) !== this.hovered || !samePiece) {
      this.placeMarks(this.hoverMarks, target, "hover", piece);
      this.needsRender = true;
    }
    this.canvas.style.cursor = hit ? "pointer" : "grab";
    const rect = this.canvas.getBoundingClientRect();
    this.callbacks.onHover(hit ? { locationId: hit.location.id, componentId: hit.component, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
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
    if (changed && this.layout && this.currentView !== "free") this.frameView(this.currentView, this.viewLocation, false);
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
    this.touchAxis.cancel();
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

  /**
   * One frame. It requests the next only while the orbit damping is settling, a camera transition or a ghosting fade is
   * running, or measure() is running: once the camera settles, frames stop.
   */
  private renderFrame = () => {
    this.frame = 0;
    if (this.disposed || this.paused) return;
    this.inFrame = true;
    let settling = false;
    try {
      this.measureStep?.();
      this.processHover();
      const now = performance.now();
      // a transition's own moves are the scene's, even while the user holds a pointer down
      const animating = this.transition !== null;
      this.stepTransition(now);
      // the step that ends a fade changes the look too
      if (this.ghostClock !== null) {
        this.stepGhostFade(now);
        this.needsRender = true;
      }
      // a bin opening or closing moves a step each frame
      if (this.bins?.animating) {
        const drawn = this.drawnOpenBin();
        this.bins.step(now);
        // a bin that has finished closing is shut: its badge, marker, door tint and outline come back
        if (this.drawnOpenBin() !== drawn) this.binDrawnChanged();
        this.needsRender = true;
      }
      if (animating)
        this.place(() => {
          settling = this.controls.update();
        });
      else settling = this.controls.update();
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
    if (settling || this.measureStep || this.needsRender || this.transition || this.ghostClock !== null || this.bins?.animating) this.requestFrame();
  };

  /**
   * The wheel zooms only while the view has focus or Ctrl or Cmd is held. Otherwise the controls never see it and the page
   * scrolls past the canvas as it would past anything else (WEB-21).
   */
  private onWheel = (e: WheelEvent) => {
    if (document.activeElement === this.canvas || e.ctrlKey || e.metaKey) return;
    e.stopImmediatePropagation();
    if (!this.paused) this.callbacks.onWheelPassedThrough?.();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    CabinScene.liveScenes -= 1;
    this.cancelFrame();
    this.measureStep?.();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.motionQuery?.removeEventListener("change", this.onMotionChange);
    this.canvas.removeEventListener("wheel", this.onWheel);
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
