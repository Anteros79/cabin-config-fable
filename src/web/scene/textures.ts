import * as THREE from "three";

/**
 * Visual profiles. Each is an unassigned, illustrative reading of a coherent image family
 * (see docs/visual-families.md). They are not mapped to any layout, tail, hardware or part.
 */
export interface ProfilePalette {
  id: string;
  upholstery: string;
  upholsteryDark: string;
  stitch: string;
  /** pale upper-back band; null = this family shows no band */
  band: string | null;
  headrest: string;
  paleFace: string;
  /** both wings pale (banded family) or only the aisle-side wing */
  paleBothWings: boolean;
  shell: string;
  shellShade: string;
  arm: string;
  armPad: string;
  metal: string;
  carpetBase: string;
  carpetDash: string | null;
  aisleBorder: string;
}

// The default palette is a named key, so reading it never yields undefined.
export const PALETTES: { "photo-navy-band": ProfilePalette; [id: string]: ProfilePalette } = {
  "photo-navy-band": {
    id: "photo-navy-band",
    // Under daylight the photographed leather is a very dark navy; it only reads as royal blue under blue cabin light.
    upholstery: "#151f47",
    upholsteryDark: "#0e1633",
    stitch: "#3b4c8c",
    band: "#93a9e0",
    headrest: "#111a3b",
    paleFace: "#a9bbea",
    paleBothWings: true,
    shell: "#dcdfe7",
    shellShade: "#b9bfcc",
    arm: "#e2e4ea",
    armPad: "#141e45",
    metal: "#b9bdc6",
    carpetBase: "#12183a",
    carpetDash: "#8ea4ea",
    aisleBorder: "#8fa0d8",
  },
  "photo-navy-plain": {
    id: "photo-navy-plain",
    upholstery: "#17224e",
    upholsteryDark: "#101837",
    stitch: "#44579b",
    band: null,
    headrest: "#151f48",
    paleFace: "#bcc6ec",
    paleBothWings: false,
    shell: "#dcdfe7",
    shellShade: "#b9bfcc",
    arm: "#dfe2ea",
    armPad: "#141e45",
    metal: "#b9bdc6",
    carpetBase: "#12183a",
    carpetDash: "#8ea4ea",
    aisleBorder: "#8fa0d8",
  },
  "concept-gray": {
    id: "concept-gray",
    upholstery: "#7b788f",
    upholsteryDark: "#5f5c73",
    stitch: "#5a576d",
    band: null,
    headrest: "#75728a",
    paleFace: "#e4e7ef",
    paleBothWings: false,
    shell: "#e6e3de",
    shellShade: "#c9c5be",
    arm: "#e9e6e1",
    armPad: "#5d5a72",
    metal: "#c4c4c6",
    // The concept images do not show the floor, so no carpet pattern is asserted for this family.
    carpetBase: "#3b3e55",
    carpetDash: null,
    aisleBorder: "#6f7390",
  },
};

/** A texture's size in pixels. Every factory draws at one of the sizes below, and its cache key is built from the same constant. */
export interface TextureSize {
  width: number;
  height: number;
}

/** Seat back (front face and rear shell) and seat pan: colour, normal and roughness maps. */
export const SEAT_TEXTURE_SIZE: TextureSize = { width: 512, height: 1024 };
export const CARPET_TEXTURE_SIZE: TextureSize = { width: 1024, height: 1024 };
export const BIN_DOOR_TEXTURE_SIZE: TextureSize = { width: 512, height: 256 };
export const SERVICE_UNIT_TEXTURE_SIZE: TextureSize = { width: 256, height: 128 };
export const SIDEWALL_TEXTURE_SIZE: TextureSize = { width: 256, height: 256 };
/** the soft dark patch drawn on the carpet under each seat */
export const CONTACT_TEXTURE_SIZE: TextureSize = { width: 128, height: 128 };
/** The rear shell shows the two-opening panel (appearance only; no availability claim). A factory parameter, so part of the key. */
export const REAR_SHELL_POWER_PANEL = true;
/** Strength of the Sobel pass that turns a seat height map into its normal map. A factory parameter, so part of the key. */
export const SEAT_NORMAL_STRENGTH = 2.5;

/** The seat textures are drawn in a 256 × 512 design space and scaled up to SEAT_TEXTURE_SIZE. */
const SEAT_DESIGN = { width: 256, height: 512 };

export type TextureParams = Record<string, string | number | boolean>;

/**
 * The cache key of a generated texture: what it shows, for which palette ("shared" when it has none), at what size, with
 * which factory parameters. Build every key from the exported size constants and parameters, so a changed factory can
 * never reuse a stale cached texture.
 */
export function textureKey(kind: string, paletteId: string, size: number | TextureSize, params: TextureParams = {}): string {
  const dims = typeof size === "number" ? `${size}` : `${size.width}x${size.height}`;
  const extra = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(",");
  return `${kind}|${paletteId}|${dims}|${extra}`;
}

const textureCache = new Map<string, THREE.Texture>();

/**
 * The texture for a key, made by `make` only the first time (WEB-20): switching visual family A → B → A draws each canvas
 * once. Cached textures belong to the cache, not to a scene; they are released by disposeTextureCache() only.
 */
export function getTexture(key: string, make: () => THREE.Texture): THREE.Texture {
  let texture = textureCache.get(key);
  if (!texture) {
    texture = make();
    textureCache.set(key, texture);
  }
  return texture;
}

/** Dispose every cached texture once and empty the cache. Called when the last scene goes away. */
export function disposeTextureCache(): void {
  const textures = [...textureCache.values()];
  textureCache.clear();
  for (const texture of textures) texture.dispose();
}

/** Estimated GPU bytes of the cached textures: width × height × 4, and a third more for a mipmap chain. */
export function cachedTextureBytes(): number {
  let bytes = 0;
  for (const texture of textureCache.values()) {
    const image = texture.image as { width?: number; height?: number } | null;
    const base = (image?.width ?? 0) * (image?.height ?? 0) * 4;
    bytes += texture.generateMipmaps ? base * 1.33 : base;
  }
  return Math.round(bytes);
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2D canvas is unavailable");
  return { c, g };
}

/** A seat-sized canvas whose drawing coordinates are the 256 × 512 design space. */
function seatCanvas(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const { c, g } = canvas(SEAT_TEXTURE_SIZE.width, SEAT_TEXTURE_SIZE.height);
  g.scale(SEAT_TEXTURE_SIZE.width / SEAT_DESIGN.width, SEAT_TEXTURE_SIZE.height / SEAT_DESIGN.height);
  return { c, g };
}

/** A colour map (sRGB), or with `data` a normal or roughness map (linear values, not colours). */
function toTexture(c: HTMLCanvasElement, repeat = false, data = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Deterministic pseudo-random so every render of a profile is identical. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function grain(g: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < (w * h) / 22; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(255,255,255,${amount * r()})` : `rgba(0,0,0,${amount * r()})`;
    g.fillRect(r() * w, r() * h, 1.4, 1.4);
  }
}

/** Pixels laid out as ImageData is (RGBA, rows top to bottom). A real ImageData satisfies it; so does a plain object in a test (PF-20). */
export interface PixelGrid {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * A tangent-space normal map from a height map (the red channel; dark is low), by a Sobel pass. Pure: the input is not
 * changed. Rows run down the image while texture v runs up (the canvas textures are flipped on upload), so a rise toward
 * the top of the image tilts the normal toward +v (green above 128). Edges repeat their outermost pixels. `strength`
 * scales the slopes; a flat map gives (128, 128, 255) everywhere.
 */
export function normalFromHeight(height: PixelGrid, strength: number): PixelGrid {
  const { width, height: rows, data } = height;
  const out = new Uint8ClampedArray(width * rows * 4);
  const h = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= rows ? rows - 1 : y;
    return (data[(cy * width + cx) * 4] ?? 0) / 255;
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      // Sobel slopes along image x (right) and image y (down)
      const gx = h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1) - h(x - 1, y - 1) - 2 * h(x - 1, y) - h(x - 1, y + 1);
      const gy = h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1) - h(x - 1, y - 1) - 2 * h(x, y - 1) - h(x + 1, y - 1);
      // n = normalize(-dh/du, -dh/dv, 1) with u = x and v = -y
      const nx = -gx * strength;
      const ny = gy * strength;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * width + x) * 4;
      out[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return { width, height: rows, data: out };
}

type Point = [number, number];

/**
 * Where the seams of an upholstered surface run, in the 256 × 512 design space: one source for the colour, height and
 * roughness maps so the three always line up. Grooves are sewn seams and stitched channels (dark in the height map);
 * piping is the raised rolled edge (light, and slightly glossier).
 */
interface SeatRelief {
  /** the stitched channels are drawn inside this rectangle only */
  clip: [number, number, number, number] | null;
  channels: Point[][];
  seams: Point[][];
  piping: Point[][];
}

/** Seat back, front face: a stitched lower field of channels meeting in an off-centre chevron, seams under the headrest. */
function backRelief(band: boolean): SeatRelief {
  const { width: w, height: h } = SEAT_DESIGN;
  const fieldTop = band ? 222 : 204;
  const apex = w * 0.66;
  const channels: Point[][] = [];
  for (let i = -6; i < 14; i++) {
    const y0 = fieldTop + i * 46;
    channels.push([
      [0, y0 - 150],
      [apex, y0 + 70],
      [w, y0 - 40],
    ]);
  }
  const seams: Point[][] = band
    ? [
        [
          [0, 226],
          [w, 186],
        ],
      ]
    : [148, 204].map((y) => [
        [6, y],
        [w - 6, y],
      ]);
  const piping: Point[][] = [
    // rolled side edges
    [
      [5, 0],
      [5, h],
    ],
    [
      [w - 5, 0],
      [w - 5, h],
    ],
    // a piped edge along the top of the stitched field
    band
      ? [
          [0, 220],
          [w, 180],
        ]
      : [
          [6, 199],
          [w - 6, 199],
        ],
  ];
  return { clip: [10, fieldTop, w - 20, h - fieldTop - 6], channels, seams, piping };
}

/**
 * Seat pan, top face. The pan's UVs run u from the back edge (0) to the front edge (1) and v across the seat: a piped
 * perimeter, a seam behind the front roll and two seams dividing the sitting area into three channels.
 */
function panRelief(): SeatRelief {
  const { width: w, height: h } = SEAT_DESIGN;
  const roll = w - 62;
  return {
    clip: null,
    channels: [],
    seams: [
      [
        [roll, 14],
        [roll, h - 14],
      ],
      [
        [16, h / 3],
        [roll, h / 3],
      ],
      [
        [16, (2 * h) / 3],
        [roll, (2 * h) / 3],
      ],
    ],
    piping: [
      [
        [9, 9],
        [w - 9, 9],
        [w - 9, h - 9],
        [9, h - 9],
        [9, 9],
      ],
    ],
  };
}

function strokePath(g: CanvasRenderingContext2D, points: Point[]): void {
  const [first, ...rest] = points;
  if (!first) return;
  g.beginPath();
  g.moveTo(first[0], first[1]);
  for (const [x, y] of rest) g.lineTo(x, y);
  g.stroke();
}

/** Stroke soft-edged lines: several passes from wide and faint to narrow and strong, so the Sobel pass sees a slope, not a step. */
function softStroke(g: CanvasRenderingContext2D, paths: Point[][], colour: (alpha: number) => string, width: number): void {
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const [scale, alpha] of [
    [2.2, 0.18],
    [1.5, 0.3],
    [1, 0.5],
    [0.5, 0.6],
  ] as const) {
    g.strokeStyle = colour(alpha);
    g.lineWidth = width * scale;
    for (const path of paths) strokePath(g, path);
  }
}

function withClip(g: CanvasRenderingContext2D, clip: SeatRelief["clip"], draw: () => void): void {
  g.save();
  if (clip) {
    g.beginPath();
    g.rect(...clip);
    g.clip();
  }
  draw();
  g.restore();
}

export type SeatSurface = "back" | "pan";

function reliefOf(surface: SeatSurface, band: boolean): SeatRelief {
  return surface === "back" ? backRelief(band) : panRelief();
}

/** Height map of a seat surface: mid grey, seams and channels as dark grooves, piping as a light ridge. */
function seatHeightCanvas(surface: SeatSurface, band: boolean): HTMLCanvasElement {
  const { c, g } = seatCanvas();
  const relief = reliefOf(surface, band);
  g.fillStyle = "rgb(128,128,128)";
  g.fillRect(0, 0, SEAT_DESIGN.width, SEAT_DESIGN.height);
  const dark = (a: number) => `rgba(0,0,0,${a})`;
  withClip(g, relief.clip, () => softStroke(g, relief.channels, dark, 4));
  softStroke(g, relief.seams, dark, 4.5);
  softStroke(g, relief.piping, (a) => `rgba(255,255,255,${a})`, 5);
  return c;
}

/**
 * Normal map of a seat surface (linear data), from its height map by normalFromHeight(). It depends only on where the
 * seams run, so the families share it: the back has two layouts (with or without the pale band), the pan one.
 */
export function seatNormalTexture(surface: SeatSurface, band: boolean, strength: number): THREE.CanvasTexture {
  const heightCanvas = seatHeightCanvas(surface, band);
  const hg = heightCanvas.getContext("2d");
  if (!hg) throw new Error("2D canvas is unavailable");
  const { width, height } = SEAT_TEXTURE_SIZE;
  const normals = normalFromHeight(hg.getImageData(0, 0, width, height), strength);
  const { c, g } = canvas(width, height);
  g.putImageData(new ImageData(new Uint8ClampedArray(normals.data), width, height), 0, 0);
  return toTexture(c, false, true);
}

/** Roughness map of a seat surface (linear data, green channel): white everywhere, slightly lower along the piping. */
export function seatRoughnessTexture(surface: SeatSurface, band: boolean): THREE.CanvasTexture {
  const { c, g } = seatCanvas();
  const relief = reliefOf(surface, band);
  g.fillStyle = "rgb(255,255,255)";
  g.fillRect(0, 0, SEAT_DESIGN.width, SEAT_DESIGN.height);
  g.lineCap = "round";
  g.strokeStyle = "rgb(200,200,200)";
  g.lineWidth = 5;
  for (const path of relief.piping) strokePath(g, path);
  return toTexture(c, false, true);
}

/**
 * Seat back, front face. Evidence: tall back with a horizontal seam under the headrest, an
 * angled pale upper band in the banded family, and a lower field of parallel stitched channels
 * meeting in an off-centre chevron ("recarro 2.jpg", "seats 4.jpg", "seats 5.jpg", "seats 8.jpg").
 */
export function backFrontTexture(p: ProfilePalette): THREE.CanvasTexture {
  const { width: w, height: h } = SEAT_DESIGN;
  const { c, g } = seatCanvas();
  const relief = backRelief(Boolean(p.band));
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, p.upholsteryDark);
  grad.addColorStop(0.18, p.upholstery);
  grad.addColorStop(0.82, p.upholstery);
  grad.addColorStop(1, p.upholsteryDark);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 0.05, 7);

  // lower stitched field: a shaded channel line, then the stitching along it
  withClip(g, relief.clip, () => {
    for (const pass of [0, 1]) {
      g.strokeStyle = pass === 0 ? (p.id === "concept-gray" ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.42)") : p.stitch;
      g.lineWidth = pass === 0 ? 4.5 : 1.3;
      g.setLineDash(pass === 1 ? [5, 3] : []);
      for (const path of relief.channels) strokePath(g, path);
    }
  });
  g.setLineDash([]);

  if (p.band) {
    // Pale upper back: it surrounds the headrest and ends in a sloping lower edge, as in the photographs.
    g.fillStyle = p.band;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(w, 0);
    g.lineTo(w, 186);
    g.lineTo(0, 226);
    g.closePath();
    g.fill();
    const shade = g.createLinearGradient(0, 0, 0, 226);
    shade.addColorStop(0, "rgba(255,255,255,0.16)");
    shade.addColorStop(1, "rgba(0,0,40,0.18)");
    g.fillStyle = shade;
    g.fill();
  }
  // seams: a dark sewn line
  g.strokeStyle = p.band ? "rgba(10,16,50,0.55)" : "rgba(0,0,0,0.5)";
  g.lineWidth = 2.5;
  for (const path of relief.seams) strokePath(g, path);
  // piping catches a little light along its crest
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 2;
  for (const path of relief.piping) strokePath(g, path);
  // soft vignette toward the base
  const fade = g.createLinearGradient(0, 0, 0, h);
  fade.addColorStop(0, "rgba(255,255,255,0.04)");
  fade.addColorStop(0.5, "rgba(255,255,255,0)");
  fade.addColorStop(1, "rgba(0,0,0,0.18)");
  g.fillStyle = fade;
  g.fillRect(0, 0, w, h);
  return toTexture(c);
}

/** Seat pan, top face: the family's upholstery, darker toward the edges, with seams and a piped perimeter. */
export function panTexture(p: ProfilePalette): THREE.CanvasTexture {
  const { width: w, height: h } = SEAT_DESIGN;
  const { c, g } = seatCanvas();
  const relief = panRelief();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, p.upholsteryDark);
  grad.addColorStop(0.12, p.upholstery);
  grad.addColorStop(0.88, p.upholstery);
  grad.addColorStop(1, p.upholsteryDark);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 0.05, 11);
  g.strokeStyle = "rgba(0,0,0,0.4)";
  g.lineWidth = 2.5;
  for (const path of relief.seams) strokePath(g, path);
  g.strokeStyle = p.stitch;
  g.lineWidth = 1.2;
  g.setLineDash([5, 3]);
  for (const path of relief.seams)
    strokePath(
      g,
      path.map(([x, y]) => [x + 3, y + 3] as Point),
    );
  g.setLineDash([]);
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 2;
  for (const path of relief.piping) strokePath(g, path);
  return toTexture(c);
}

/**
 * Seat back, rear shell. Evidence ("seats 3.jpg", "southwest seats-7.webp", "seats 4.jpg"):
 * pale moulded shell under a navy rolled top edge; a literature slot at the top; a separate
 * device-holder flap; a stowed tray with a centre latch; a low dark mesh pocket; and, in some
 * views, a small vertical two-opening panel near the outer edge. No connector standard, rating,
 * cabin-wide availability or built-in screen is implied.
 */
export function rearShellTexture(p: ProfilePalette, showPowerPanel: boolean): THREE.CanvasTexture {
  const { width: w, height: h } = SEAT_DESIGN;
  const { c, g } = seatCanvas();
  g.fillStyle = p.shell;
  g.fillRect(0, 0, w, h);
  const side = g.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0, "rgba(0,0,0,0.16)");
  side.addColorStop(0.12, "rgba(0,0,0,0)");
  side.addColorStop(0.88, "rgba(0,0,0,0)");
  side.addColorStop(1, "rgba(0,0,0,0.16)");
  g.fillStyle = side;
  g.fillRect(0, 0, w, h);
  const round = (x: number, y: number, rw: number, rh: number, r: number) => {
    g.beginPath();
    g.roundRect(x, y, rw, rh, r);
  };
  // navy rolled upholstery edge
  g.fillStyle = p.upholstery;
  round(0, 0, w, 40, 14);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.10)";
  g.fillRect(0, 6, w, 6);
  // literature slot
  g.fillStyle = "#1a1d27";
  round(34, 52, w - 68, 9, 4);
  g.fill();
  g.fillStyle = p.shellShade;
  round(26, 62, w - 52, 26, 6);
  g.fill();
  // device-holder flap
  g.fillStyle = p.shell;
  g.strokeStyle = p.shellShade;
  g.lineWidth = 3;
  round(44, 100, w - 88, 74, 8);
  g.fill();
  g.stroke();
  g.fillStyle = "rgba(0,0,0,0.20)";
  round(52, 160, w - 104, 8, 4);
  g.fill();
  // tray table with centre latch
  g.fillStyle = "#e9ebf0";
  g.strokeStyle = "rgba(90,96,112,0.75)";
  g.lineWidth = 3;
  round(22, 190, w - 44, 150, 12);
  g.fill();
  g.stroke();
  g.fillStyle = "rgba(0,0,0,0.10)";
  round(30, 322, w - 60, 12, 5);
  g.fill();
  g.fillStyle = "#2a2e3b";
  round(w / 2 - 15, 184, 30, 18, 4);
  g.fill();
  g.fillStyle = "#8d93a3";
  round(w / 2 - 6, 198, 12, 16, 3);
  g.fill();
  // low mesh pocket
  g.fillStyle = "#141826";
  round(30, 372, w - 60, 112, 8);
  g.fill();
  g.strokeStyle = "rgba(150,160,190,0.30)";
  g.lineWidth = 1;
  for (let x = 30; x < w - 30; x += 7) {
    g.beginPath();
    g.moveTo(x, 384);
    g.lineTo(x, 482);
    g.stroke();
  }
  for (let y = 386; y < 484; y += 7) {
    g.beginPath();
    g.moveTo(32, y);
    g.lineTo(w - 32, y);
    g.stroke();
  }
  g.fillStyle = "#2b3350";
  round(30, 372, w - 60, 10, 4);
  g.fill();
  if (showPowerPanel) {
    g.fillStyle = "#cfd3dc";
    g.strokeStyle = "#8d93a3";
    g.lineWidth = 2;
    round(w - 38, 104, 20, 50, 6);
    g.fill();
    g.stroke();
    g.fillStyle = "#20232e";
    round(w - 33, 112, 10, 13, 2);
    g.fill();
    round(w - 33, 132, 10, 13, 2);
    g.fill();
  }
  return toTexture(c);
}

/**
 * Carpet. Evidence ("carpet.jpg", "seats 4.jpg", "southwest seats-7.webp"): dense short pale
 * dashes laid in curved, overlapping fan fields on dark navy. Tileable.
 */
export function carpetTexture(p: ProfilePalette): THREE.CanvasTexture {
  // the fan pattern is laid out for a square tile
  const size = CARPET_TEXTURE_SIZE.width;
  const { c, g } = canvas(size, CARPET_TEXTURE_SIZE.height);
  g.fillStyle = p.carpetBase;
  g.fillRect(0, 0, size, size);
  grain(g, size, size, 0.06, 21);
  if (p.carpetDash) {
    const r = rng(1234);
    const fans: { x: number; y: number; rot: number; reach: number; span: number }[] = [];
    // two passes of broad sweeping fans so the whole field is covered, as in the photograph
    for (const cells of [3, 3]) {
      for (let i = 0; i < cells; i++) {
        for (let j = 0; j < cells; j++) {
          fans.push({
            x: ((i + 0.5 + (r() - 0.5) * 0.9) * size) / cells,
            y: ((j + 0.5 + (r() - 0.5) * 0.9) * size) / cells,
            rot: r() * Math.PI * 2,
            reach: 430 + r() * 230,
            span: 1.15 + r() * 0.75,
          });
        }
      }
    }
    // painter's order: each fan covers the ones beneath it, giving the overlapping-scale look
    for (const f of fans) {
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          const cx = f.x + ox;
          const cy = f.y + oy;
          if (cx < -f.reach || cx > size + f.reach || cy < -f.reach || cy > size + f.reach) continue;
          g.save();
          g.translate(cx, cy);
          g.rotate(f.rot);
          g.beginPath();
          g.moveTo(0, 0);
          g.arc(0, 0, f.reach, -f.span / 2, f.span / 2);
          g.closePath();
          g.fillStyle = p.carpetBase;
          g.fill();
          g.clip();
          g.strokeStyle = p.carpetDash;
          g.lineWidth = 2.6;
          g.lineCap = "round";
          g.setLineDash([8, 6.5]);
          for (let rad = 8; rad < f.reach; rad += 13) {
            g.lineDashOffset = rad * 0.7;
            g.globalAlpha = 0.6 + 0.3 * Math.sin(rad * 0.11);
            g.beginPath();
            g.arc(0, 0, rad, -f.span / 2, f.span / 2);
            g.stroke();
          }
          g.restore();
        }
      }
    }
    g.globalAlpha = 1;
    g.setLineDash([]);
  }
  return toTexture(c, true);
}

/**
 * Overhead bin door. Evidence ("seats 4.jpg", "southwest seats-7.webp", "seats 2 .jpeg"):
 * broad pale convex closed doors, module seams, an elongated recessed oval handle set low on the
 * door, soft perimeter shading.
 */
export function binDoorTexture(): THREE.CanvasTexture {
  const { width: w, height: h } = BIN_DOOR_TEXTURE_SIZE;
  const { c, g } = canvas(w, h);
  const base = g.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, "#d7dae0");
  base.addColorStop(0.35, "#eceef2");
  base.addColorStop(0.8, "#e4e6eb");
  base.addColorStop(1, "#c9cdd6");
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  // perimeter seam of the module
  g.strokeStyle = "rgba(70,76,92,0.75)";
  g.lineWidth = 5;
  g.strokeRect(1.5, 1.5, w - 3, h - 3);
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 2;
  g.strokeRect(7, 7, w - 14, h - 14);
  // recessed elongated oval handle, low on the door and slightly canted
  g.save();
  g.translate(w * 0.5, h * 0.74);
  g.rotate(-0.06);
  const recess = g.createLinearGradient(0, -20, 0, 20);
  recess.addColorStop(0, "#6f7584");
  recess.addColorStop(1, "#b7bcc8");
  g.fillStyle = recess;
  g.beginPath();
  g.ellipse(0, 0, 62, 17, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(60,66,82,0.8)";
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = "#dfe2e8";
  g.beginPath();
  g.ellipse(-26, 0, 13, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#c2c7d1";
  g.beginPath();
  g.ellipse(20, 1, 24, 8, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  return toTexture(c);
}

/**
 * Underside of the bins. Evidence ("seats 4.jpg", "seats 6.avif"): segmented panels with round
 * vents, small lights and a grille per segment. Purely visual; no service fitting is modelled.
 */
export function serviceUnitTexture(): THREE.CanvasTexture {
  const { width: w, height: h } = SERVICE_UNIT_TEXTURE_SIZE;
  const { c, g } = canvas(w, h);
  g.fillStyle = "#dfe2e8";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(90,96,112,0.7)";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, w - 3, h - 3);
  g.fillStyle = "#c9cdd6";
  g.beginPath();
  g.roundRect(14, 22, w - 28, h - 44, 16);
  g.fill();
  for (const x of [52, 92, 132]) {
    g.fillStyle = "#8f95a4";
    g.beginPath();
    g.arc(x, h / 2, 13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#5c6170";
    g.beginPath();
    g.arc(x, h / 2, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#f4f1d8";
  for (const x of [170, 196]) {
    g.beginPath();
    g.arc(x, h / 2 - 12, 7, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#9aa0ae";
  for (let i = 0; i < 4; i++) g.fillRect(166, h / 2 + 4 + i * 6, 44, 2.5);
  return toTexture(c, true);
}

/** Sidewall context panel with a window reveal. Context only. */
export function sidewallTexture(): THREE.CanvasTexture {
  const { width: w, height: h } = SIDEWALL_TEXTURE_SIZE;
  const { c, g } = canvas(w, h);
  g.fillStyle = "#e3e5ea";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(120,126,142,0.5)";
  g.lineWidth = 2;
  g.strokeRect(1, 1, w - 2, h - 2);
  // The panel is mapped onto one row pitch by the full wall height, so the window is drawn squat here.
  g.fillStyle = "#cfd3db";
  g.beginPath();
  g.ellipse(w / 2, h * 0.36, 66, 46, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#f3f6fb";
  g.beginPath();
  g.ellipse(w / 2, h * 0.36, 40, 29, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(110,118,136,0.7)";
  g.lineWidth = 3;
  g.stroke();
  return toTexture(c, true);
}

/** A soft round dark patch, transparent at its rim: laid on the carpet under each seat, it grounds the seat without shadow maps. */
export function contactTexture(): THREE.CanvasTexture {
  const { width: w, height: h } = CONTACT_TEXTURE_SIZE;
  const { c, g } = canvas(w, h);
  const r = Math.min(w, h) / 2;
  const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
  grad.addColorStop(0, "rgba(0,0,0,0.6)");
  grad.addColorStop(0.45, "rgba(0,0,0,0.4)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return toTexture(c);
}
