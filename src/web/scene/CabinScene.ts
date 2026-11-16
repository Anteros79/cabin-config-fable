import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FORWARD_MARGIN } from "../../domain/geometry.ts";
import type { CabinLocation, LayoutRevision } from "../../domain/types.ts";
import { PickGesture, type PointerSample } from "./pickGesture.ts";
import { buildBinGeometry, buildSeatGeometries, SEAT, type SeatGeometries } from "./seatParts.ts";
import {
  backFrontTexture,
  binDoorTexture,
  carpetTexture,
  PALETTES,
  type ProfilePalette,
  rearShellTexture,
  serviceUnitTexture,
  sidewallTexture,
} from "./textures.ts";

export type LocationStatus = "recorded" | "unresolved" | "none";
export interface LocationState {
  /** status per component id; a location with no entry shows no status */
  components: Record<string, LocationStatus>;
}
export type ColourMode = "status" | "tier" | "none";
export type LightMode = "neutral" | "blue";
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
  onHover(label: string | null): void;
  onContextLost(): void;
}

const STATUS_COLOUR = { recorded: new THREE.Color("#2fe08a"), unresolved: new THREE.Color("#ff5757") };
const TIER_COLOURS: Record<string, THREE.Color> = {
  "Extra Legroom": new THREE.Color("#19c8b4"),
  Preferred: new THREE.Color("#b08cff"),
  ELR: new THREE.Color("#19c8b4"),
  EXIT: new THREE.Color("#ff9550"),
};
const SELECT_COLOUR = "#ffc531";
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color("#ffffff");
const FULL_CABIN = "FLOOR:FULL-CABIN";

interface SeatEntry {
  location: CabinLocation;
  matrix: THREE.Matrix4;
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
  private backOverlay: THREE.InstancedMesh | null = null;
  private floorMeshes: { mesh: THREE.Mesh; locationId: string | null; overlay: THREE.Mesh | null }[] = [];
  private fullCabinOverlay: THREE.Mesh | null = null;
  private binSides: { side: "L" | "R"; door: THREE.InstancedMesh; body: THREE.InstancedMesh; locations: CabinLocation[]; extras: THREE.Object3D[] }[] = [];
  private contextSides: { side: "L" | "R"; wallMaterial: THREE.MeshStandardMaterial }[] = [];
  private states = new Map<string, LocationState>();
  private selection: string | null = null;
  private selectionMark: THREE.LineSegments;
  private selectionFill: THREE.Mesh;
  private hoverMark: THREE.LineSegments;
  private lights: { hemi: THREE.HemisphereLight; key: THREE.DirectionalLight; fill: THREE.DirectionalLight; wash: THREE.PointLight[] };
  /** everything the current layout built; released at the start of every rebuild */
  private layoutResources = new ResourceTracker();
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

    const hemi = new THREE.HemisphereLight("#ffffff", "#8b8f9c", 1.15);
    const key = new THREE.DirectionalLight("#ffffff", 1.9);
    key.position.set(-6, 14, 9);
    const fill = new THREE.DirectionalLight("#ffffff", 0.75);
    fill.position.set(10, 8, -9);
    this.lights = { hemi, key, fill, wash: [] };
    this.scene.add(hemi, key, fill);
    for (const g of Object.values(this.groups)) this.scene.add(g);

    const keep = <T extends Disposable>(resource: T): T => this.sceneResources.track(resource);
    const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
    const edge = keep(new THREE.EdgesGeometry(unitBox));
    this.selectionMark = new THREE.LineSegments(edge, keep(new THREE.LineBasicMaterial({ color: SELECT_COLOUR, depthTest: false, transparent: true })));
    this.selectionMark.renderOrder = 20;
    this.selectionFill = new THREE.Mesh(
      unitBox,
      keep(new THREE.MeshBasicMaterial({ color: SELECT_COLOUR, transparent: true, opacity: 0.2, depthWrite: false })),
    );
    this.selectionFill.renderOrder = 19;
    this.hoverMark = new THREE.LineSegments(edge, keep(new THREE.LineBasicMaterial({ color: "#ffffff", depthTest: false, transparent: true, opacity: 0.85 })));
    this.hoverMark.renderOrder = 18;
    this.selectionMark.visible = this.selectionFill.visible = this.hoverMark.visible = false;
    this.groups.marks.add(this.selectionFill, this.selectionMark, this.hoverMark);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.applyLight();
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
        /** Orbit continuously for a while and report the measured frame rate. Each scheduled frame draws one step. */
        measure: (durationMs) =>
          new Promise((resolve) => {
            const start = performance.now();
            let frames = 0;
            let last = start;
            let worst = 0;
            this.measureStep = () => {
              const now = performance.now();
              if (now - start >= durationMs || this.disposed) {
                this.measureStep = null;
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
          },
          frames: this.frameCount,
          frameRequests: this.frameRequests,
          framePending: this.frame !== 0,
        }),
      };
      Object.assign(this, hooks);
    }
    this.invalidate();
  }

  // ---- construction ---------------------------------------------------------------------------

  /** Remove a layout group's children from the scene. Their GPU resources belong to layoutResources, which rebuild() releases. */
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
    this.rebuild();
    if (!sameRevision) this.setCamera("cutaway");
  }

  private rebuild(): void {
    const layout = this.layout;
    if (!layout) return;
    this.clearGroup(this.groups.seats);
    this.clearGroup(this.groups.floor);
    this.clearGroup(this.groups.bins);
    this.clearGroup(this.groups.context);
    this.layoutResources.disposeAll();
    this.seatMeshes = [];
    this.floorMeshes = [];
    this.binSides = [];
    this.contextSides = [];
    this.lights.wash.forEach((l) => {
      this.scene.remove(l);
    });
    this.lights.wash = [];
    const own = <T extends Disposable>(resource: T): T => this.layoutResources.track(resource);
    const p = this.palette;
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
    const addSeatMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, component: string | null, matrices?: (THREE.Matrix4 | null)[]) => {
      if (n === 0) return null;
      const mesh = own(new THREE.InstancedMesh(geometry, material, n));
      this.seats.forEach((seat, i) => {
        mesh.setMatrixAt(i, matrices ? (matrices[i] ?? ZERO) : seat.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.groups.seats.add(mesh);
      this.seatMeshes.push({ mesh, component });
      return mesh;
    };
    const leather = { roughness: 0.52 };
    addSeatMesh(this.geoms.legs, std(p.metal, 0.35, 0.75), null);
    addSeatMesh(this.geoms.pan, std(p.upholstery, leather.roughness), "CUSHION");
    addSeatMesh(this.geoms.backCore, std(p.upholsteryDark, leather.roughness), "BACKREST");
    addSeatMesh(this.geoms.backFront, own(new THREE.MeshStandardMaterial({ map: own(backFrontTexture(p)), roughness: leather.roughness })), "BACKREST");
    addSeatMesh(this.geoms.rearShell, own(new THREE.MeshStandardMaterial({ map: own(rearShellTexture(p, true)), roughness: 0.6 })), "BACKREST");
    addSeatMesh(this.geoms.rearRelief, std(p.shell, 0.6), "BACKREST");
    addSeatMesh(this.geoms.headrest, std(p.headrest, 0.46), "BACKREST");
    addSeatMesh(this.geoms.arms, std(p.arm, 0.55), null);
    addSeatMesh(this.geoms.armPads, std(p.armPad, 0.5), null);
    // pale wing faces: the aisle-side wing always, the window-side wing only in the banded family
    const mirror = new THREE.Matrix4().makeScale(1, 1, -1);
    const pale = std(p.paleFace, 0.5, 0, { side: THREE.DoubleSide });
    const aisleSide = this.seats.map((s) => (s.location.placement.z > 0 ? s.matrix.clone().multiply(mirror) : s.matrix));
    addSeatMesh(this.geoms.wingFace, pale, "BACKREST", aisleSide);
    if (p.paleBothWings) {
      const windowSide = this.seats.map((s) => (s.location.placement.z > 0 ? s.matrix : s.matrix.clone().multiply(mirror)));
      addSeatMesh(this.geoms.wingFace, own(pale.clone()), "BACKREST", windowSide);
    }
    // (the pale surround of the banded family is the upper-back band itself, drawn in the texture)

    const overlayMaterial = () => own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, color: "#ffffff" }));
    this.panOverlay = n ? own(new THREE.InstancedMesh(this.geoms.panOverlay, overlayMaterial(), n)) : null;
    this.backOverlay = n ? own(new THREE.InstancedMesh(this.geoms.backOverlay, overlayMaterial(), n)) : null;
    for (const o of [this.panOverlay, this.backOverlay]) {
      if (!o) continue;
      o.renderOrder = 5;
      o.setColorAt(0, WHITE);
      this.groups.seats.add(o);
    }

    // floor ------------------------------------------------------------------------------------
    const carpet = own(carpetTexture(p));
    const floorMaterial = (lx: number, lz: number, offsetX: number) => {
      const map = own(carpet.clone());
      map.needsUpdate = true;
      map.repeat.set(lx / 1.3, lz / 1.3);
      map.offset.set(offsetX / 1.3, 0);
      return own(new THREE.MeshStandardMaterial({ map, roughness: 0.95 }));
    };
    const addFloor = (x: number, lx: number, locationId: string | null) => {
      const mesh = new THREE.Mesh(own(new THREE.PlaneGeometry(lx, halfW * 2)), floorMaterial(lx, halfW * 2, x - lx / 2));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0, 0);
      this.groups.floor.add(mesh);
      let overlay: THREE.Mesh | null = null;
      if (locationId) {
        overlay = new THREE.Mesh(
          own(new THREE.PlaneGeometry(lx - 0.06, halfW * 2 - 0.06)),
          own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.34, depthWrite: false })),
        );
        overlay.rotation.x = -Math.PI / 2;
        overlay.position.set(x, 0.006, 0);
        overlay.visible = false;
        overlay.renderOrder = 4;
        this.groups.floor.add(overlay);
      }
      this.floorMeshes.push({ mesh, locationId, overlay });
    };
    const areas = layout.locations.filter((l) => l.kind === "FLOOR" && l.floor?.areaType === "AREA");
    if (areas.length > 0) for (const a of areas) addFloor(a.placement.x, a.placement.lx, a.id);
    else addFloor(length / 2, length, null);
    // The aisle strip shows the full-cabin floor's status and is its pick target (WEB-18): the area under it is reached
    // anywhere else across the cabin width.
    if (layout.locations.some((l) => l.id === FULL_CABIN)) {
      this.fullCabinOverlay = new THREE.Mesh(
        own(new THREE.PlaneGeometry(length - 0.1, 0.42)),
        own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false })),
      );
      this.fullCabinOverlay.rotation.x = -Math.PI / 2;
      this.fullCabinOverlay.position.set(length / 2, 0.009, 0);
      this.fullCabinOverlay.visible = false;
      this.fullCabinOverlay.renderOrder = 4;
      this.groups.floor.add(this.fullCabinOverlay);
    } else this.fullCabinOverlay = null;
    // narrow aisle borders
    for (const sign of [1, -1]) {
      const strip = new THREE.Mesh(own(new THREE.BoxGeometry(length, 0.008, 0.022)), std(p.aisleBorder, 0.35, 0.6));
      strip.position.set(length / 2, 0.004, sign * 0.262);
      this.groups.floor.add(strip);
    }

    // bins -------------------------------------------------------------------------------------
    const binLocations = layout.locations.filter((l) => l.kind === "BIN");
    const service = own(serviceUnitTexture());
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? 1 : -1;
      const { door, body } = buildBinGeometry(sign);
      own(door);
      own(body);
      // Without a supplied bin map the run is drawn as illustrative, unpickable three-row modules.
      const mine = binLocations.filter((l) => l.bin?.side === side);
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
      const doorMesh = own(
        new THREE.InstancedMesh(door, own(new THREE.MeshStandardMaterial({ map: own(binDoorTexture()), roughness: 0.42, ...singlePass })), count),
      );
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
    const wallTexture = own(sidewallTexture());
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? 1 : -1;
      const map = own(wallTexture.clone());
      map.needsUpdate = true;
      map.repeat.set(Math.max(rows, 1), 1);
      const wallMaterial = own(new THREE.MeshStandardMaterial({ map, roughness: 0.7, side: THREE.DoubleSide, forceSinglePass: true, transparent: true }));
      const wall = new THREE.Mesh(own(new THREE.PlaneGeometry(length, 1.66)), wallMaterial);
      wall.position.set(length / 2, 0.83, sign * (halfW + 0.005));
      wall.rotation.y = sign > 0 ? Math.PI : 0;
      const strip = new THREE.Mesh(own(new THREE.BoxGeometry(length, 0.03, 0.03)), own(new THREE.MeshBasicMaterial({ color: "#ffffff" })));
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
    for (let i = 0; i < 6; i++) {
      const wash = new THREE.PointLight("#ffffff", 0, 11, 1.4);
      wash.position.set((length * (i + 0.5)) / 6, 1.45, 0);
      this.scene.add(wash);
      this.lights.wash.push(wash);
    }

    this.applyLayers();
    this.applyLight();
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
    this.rebuild();
  }

  setLight(mode: LightMode): void {
    this.light = mode;
    this.applyLight();
  }

  private applyLight(): void {
    const blue = this.light === "blue";
    // Blue cabin light is a wash over pale surfaces, not a blue-only scene: whites stay pale, as in the photographs.
    this.scene.background = new THREE.Color(blue ? "#2a3566" : "#eef0f4");
    this.lights.hemi.color.set(blue ? "#dde4ff" : "#ffffff");
    this.lights.hemi.groundColor.set(blue ? "#4a5cb8" : "#b9bcc6");
    this.lights.hemi.intensity = blue ? 1.1 : 1.25;
    this.lights.key.color.set(blue ? "#e3e8ff" : "#ffffff");
    this.lights.key.intensity = blue ? 1.2 : 1.9;
    this.lights.fill.color.set(blue ? "#7f93ff" : "#ffffff");
    this.lights.fill.intensity = blue ? 0.75 : 0.75;
    this.lights.wash.forEach((l) => {
      l.color.set(blue ? "#5876ff" : "#ffffff");
      l.intensity = blue ? 5 : 4.5;
    });
    this.renderer.toneMappingExposure = blue ? 1.05 : 1.0;
    this.groups.context.traverse((o) => {
      if (o.userData.wash) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(blue ? "#6f8dff" : "#ffffff");
    });
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
    this.groups.floor.visible = this.layers.floor;
    this.groups.bins.visible = this.layers.bins;
    this.groups.context.visible = this.layers.context;
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
        const m = o.material as THREE.MeshStandardMaterial;
        m.transparent = ghost;
        m.opacity = ghost ? 0.16 : 1;
        m.depthWrite = !ghost;
      }
    }
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

  private statusOf(locationId: string, componentId?: string): LocationStatus {
    const state = this.states.get(locationId);
    if (!state) return "none";
    if (componentId) return state.components[componentId] ?? "none";
    const values = Object.values(state.components);
    if (values.includes("recorded")) return "recorded";
    if (values.length > 0 && values.every((v) => v === "unresolved")) return "unresolved";
    return "none";
  }

  private applyStates(): void {
    const colourFor = (status: LocationStatus) => (status === "none" ? null : STATUS_COLOUR[status]);
    if (this.panOverlay && this.backOverlay) {
      let anyPan = false;
      let anyBack = false;
      this.seats.forEach((s, i) => {
        let pan: THREE.Color | null = null;
        let back: THREE.Color | null = null;
        if (this.colourMode === "status") {
          pan = colourFor(this.statusOf(s.location.id, "CUSHION"));
          back = colourFor(this.statusOf(s.location.id, "BACKREST"));
        } else if (this.colourMode === "tier") {
          const key = s.location.seat?.commercialTier ?? s.location.seat?.maintenanceZone ?? "";
          pan = TIER_COLOURS[key] ?? null;
        }
        anyPan ||= Boolean(pan);
        anyBack ||= Boolean(back);
        this.panOverlay!.setMatrixAt(i, pan ? s.matrix : ZERO);
        this.backOverlay!.setMatrixAt(i, back ? s.matrix : ZERO);
        this.panOverlay!.setColorAt(i, pan ?? WHITE);
        this.backOverlay!.setColorAt(i, back ?? WHITE);
      });
      // an overlay with nothing to show costs no draw call (WEB-20)
      this.panOverlay.visible = anyPan;
      this.backOverlay.visible = anyBack;
      for (const o of [this.panOverlay, this.backOverlay]) {
        o.instanceMatrix.needsUpdate = true;
        if (o.instanceColor) o.instanceColor.needsUpdate = true;
      }
    }
    for (const f of this.floorMeshes) {
      if (!f.overlay || !f.locationId) continue;
      const c = this.colourMode === "status" ? colourFor(this.statusOf(f.locationId)) : null;
      f.overlay.visible = Boolean(c);
      if (c) (f.overlay.material as THREE.MeshBasicMaterial).color.copy(c);
    }
    if (this.fullCabinOverlay) {
      const c = this.colourMode === "status" ? colourFor(this.statusOf(FULL_CABIN)) : null;
      this.fullCabinOverlay.visible = Boolean(c);
      if (c) (this.fullCabinOverlay.material as THREE.MeshBasicMaterial).color.copy(c);
    }
    for (const b of this.binSides) {
      b.locations.forEach((l, i) => {
        const status = this.colourMode === "status" ? this.statusOf(l.id) : "none";
        b.door.setColorAt(i, status === "recorded" ? new THREE.Color("#7df0b3") : status === "unresolved" ? new THREE.Color("#ff9d9d") : WHITE);
      });
      if (b.door.instanceColor) b.door.instanceColor.needsUpdate = true;
    }
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
    const sign = location.bin?.side === "L" ? 1 : -1;
    return { centre: new THREE.Vector3(p.x, 1.98, sign * 1.25), size: new THREE.Vector3(p.lx - 0.02, 0.68, 1.02) };
  }

  private applySelection(): void {
    const location = this.layout?.locations.find((l) => l.id === this.selection);
    this.selectionMark.visible = this.selectionFill.visible = Boolean(location);
    if (location) {
      const { centre, size } = this.boxOf(location);
      for (const m of [this.selectionMark, this.selectionFill]) {
        m.position.copy(centre);
        m.scale.copy(size);
      }
    }
    this.invalidate();
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
      const entry = this.seats[first.instanceId];
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
    this.hoverMark.visible = false;
    this.callbacks.onHover(null);
    this.invalidate();
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
    const was = this.hoverMark.visible;
    if (hit && hit.location.id !== this.selection) {
      const { centre, size } = this.boxOf(hit.location);
      this.hoverMark.position.copy(centre);
      this.hoverMark.scale.copy(size);
      this.hoverMark.visible = true;
      this.needsRender = true;
    } else {
      this.hoverMark.visible = false;
      if (was) this.needsRender = true;
    }
    this.canvas.style.cursor = hit ? "pointer" : "grab";
    this.callbacks.onHover(hit ? hit.location.label : null);
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
      if (this.hoverMark.visible) this.hoverMark.visible = false;
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
    if (document.visibilityState === "hidden") this.cancelFrame();
    else this.invalidate();
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
    this.disposed = true;
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
      ResourceTracker.disposeEach(this.layoutResources, this.sceneResources);
    } finally {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
  }
}
