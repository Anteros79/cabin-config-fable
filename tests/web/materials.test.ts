import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { STATUS_ENCODING } from "../../src/web/model.ts";
import {
  createOverlayMaterial,
  createSeatMaterials,
  METAL,
  PAD,
  SHELL,
  STATUS_COLOUR,
  setGhosted,
  TIER_COLOUR,
  TIER_SWATCH,
  UPHOLSTERY,
} from "../../src/web/scene/materials.ts";
import { normalFromHeight, PALETTES, REAR_SHELL_POWER_PANEL, SEAT_TEXTURE_SIZE, textureKey } from "../../src/web/scene/textures.ts";

/** A height map shaped like ImageData (PF-20: jsdom has no ImageData), every pixel the grey `level` unless `at` says otherwise. */
function heightMap(width: number, height: number, at: (x: number, y: number) => number = () => 128) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = at(x, y);
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const pixel = (map: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * map.width + x) * 4;
  return [map.data[i], map.data[i + 1], map.data[i + 2], map.data[i + 3]] as number[];
};

describe("normalFromHeight", () => {
  test("a flat height map gives the neutral normal", () => {
    const out = normalFromHeight(
      heightMap(9, 7, () => 173),
      3,
    );
    expect([out.width, out.height, out.data.length]).toEqual([9, 7, 9 * 7 * 4]);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 9; x++) {
        const [r = 0, g = 0, b = 0, a = 0] = pixel(out, x, y);
        expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
        expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(254);
        expect(a).toBe(255);
      }
    }
  });

  // Tangent-space normals follow the surface: the walls of a groove face into it, so left of the groove the normal leans
  // right (+x, red above 128) and right of it the normal leans left (red below 128). Along the groove nothing changes in y.
  test("a vertical groove tilts the normals on both sides toward its centre line, and not along it", () => {
    const groove = 10;
    const out = normalFromHeight(
      heightMap(21, 9, (x) => (Math.abs(x - groove) <= 1 ? 40 : 200)),
      3,
    );
    for (let y = 0; y < 9; y++) {
      const [leftR = 0, leftG = 0] = pixel(out, groove - 2, y);
      const [rightR = 0, rightG = 0] = pixel(out, groove + 2, y);
      expect(leftR).toBeGreaterThan(160);
      expect(rightR).toBeLessThan(96);
      expect(Math.abs(leftG - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(rightG - 128)).toBeLessThanOrEqual(1);
      // far from the groove the surface is flat again
      expect(Math.abs((pixel(out, 2, y)[0] ?? 0) - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs((pixel(out, 18, y)[0] ?? 0) - 128)).toBeLessThanOrEqual(1);
    }
  });

  test("a horizontal ridge tilts the normals away from it: up (green above 128) above it in the image, down below it", () => {
    // Canvas rows run downward while texture v runs upward, so the row above the ridge is the +v side.
    const out = normalFromHeight(
      heightMap(9, 21, (_x, y) => (Math.abs(y - 10) <= 1 ? 230 : 100)),
      3,
    );
    expect(pixel(out, 4, 8)[1]).toBeGreaterThan(160);
    expect(pixel(out, 4, 12)[1]).toBeLessThan(96);
  });

  test("does not change its input", () => {
    const input = heightMap(5, 5, (x) => x * 50);
    const copy = input.data.slice();
    normalFromHeight(input, 2);
    expect(input.data).toEqual(copy);
  });
});

describe("createSeatMaterials", () => {
  const maps = () => ({ colour: new THREE.Texture(), normal: new THREE.Texture(), roughness: new THREE.Texture() });

  test("uses a physical material with sheen for upholstery and wires all three maps", () => {
    const m = maps();
    const set = createSeatMaterials(PALETTES["photo-navy-band"], m);
    const u = set.upholstery;
    expect(u).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(u.map).toBe(m.colour);
    expect(u.normalMap).toBe(m.normal);
    expect(u.roughnessMap).toBe(m.roughness);
    expect(u.roughness).toBe(UPHOLSTERY.roughness);
    expect(u.specularIntensity).toBe(UPHOLSTERY.specularIntensity);
    expect(u.sheen).toBe(UPHOLSTERY.sheen);
    expect(u.sheenRoughness).toBe(UPHOLSTERY.sheenRoughness);
    expect(u.clearcoat).toBe(UPHOLSTERY.clearcoat);
    expect(u.clearcoatRoughness).toBe(UPHOLSTERY.clearcoatRoughness);
    expect([u.normalScale.x, u.normalScale.y]).toEqual([UPHOLSTERY.normalScale, UPHOLSTERY.normalScale]);
    // the sheen colour is the upholstery lifted toward white by sheenLift; a black one would switch the sheen off
    const sheen = new THREE.Color(PALETTES["photo-navy-band"].upholstery).lerp(new THREE.Color("#ffffff"), UPHOLSTERY.sheenLift);
    expect(u.sheenColor.getHexString()).toBe(sheen.getHexString());
    expect(u.sheenColor.getHex()).not.toBe(0);
  });

  test("metal is fully metallic and the other parts are not; colours follow the visual family", () => {
    const p = PALETTES["photo-navy-band"];
    const set = createSeatMaterials(p, maps());
    expect(METAL.metalness).toBe(1);
    expect([set.metal.metalness, set.metal.roughness]).toEqual([METAL.metalness, METAL.roughness]);
    expect(set.metal.color.getHexString()).toBe(new THREE.Color(p.metal).getHexString());
    expect([set.shell.metalness, set.shell.roughness]).toEqual([0, SHELL.roughness]);
    expect([set.pad.metalness, set.pad.roughness]).toEqual([0, PAD.roughness]);
    expect(set.shell.color.getHexString()).toBe(new THREE.Color(p.shell).getHexString());
    expect(set.pad.color.getHexString()).toBe(new THREE.Color(p.armPad).getHexString());
    for (const material of [set.shell, set.metal, set.pad]) expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });
});

// ---- status overlay colour against the legend ------------------------------------------------

/** three's ACESFilmicToneMapping (tonemapping_pars_fragment), on linear RGB. */
function acesFilmic([r, g, b]: number[], exposure: number): number[] {
  const v = [r ?? 0, g ?? 0, b ?? 0].map((c) => (c * exposure) / 0.6);
  // the GLSL matrices are column-major, so these rows are their columns
  const input = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
  ];
  const output = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const mul = (m: number[][], x: number[]) => m.map((row) => row.reduce((s, k, i) => s + k * (x[i] ?? 0), 0));
  const fit = (x: number) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
  return mul(output, mul(input, v).map(fit)).map((c) => Math.min(1, Math.max(0, c)));
}

/** The sRGB colour a material's colour is drawn as on the canvas, before blending: tone mapped only if the material is. */
function renderedSrgb(material: THREE.MeshBasicMaterial, exposure: number): THREE.Color {
  const linear = [material.color.r, material.color.g, material.color.b];
  const mapped = material.toneMapped ? acesFilmic(linear, exposure) : linear;
  return new THREE.Color().setRGB(mapped[0] ?? 0, mapped[1] ?? 0, mapped[2] ?? 0, THREE.LinearSRGBColorSpace);
}

/** CIE76 colour difference in CIELAB (D65). */
function deltaE(a: THREE.Color, b: THREE.Color): number {
  const lab = (c: THREE.Color) => {
    const [r, g, bl] = [c.r, c.g, c.b]; // linear
    const xyz = [
      (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047,
      0.2126 * r + 0.7152 * g + 0.0722 * bl,
      (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883,
    ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
    const [x = 0, y = 0, z = 0] = xyz;
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [l1 = 0, a1 = 0, b1 = 0] = lab(a);
  const [l2 = 0, a2 = 0, b2 = 0] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The legend colour for a status (its `--status-*` token) or a tier (its `.swatch.tier-*` background) in styles.css. */
function legendSwatch(kind: "status" | "tier", name: string): THREE.Color {
  const css = readFileSync(join(import.meta.dirname, "../../src/web/styles.css"), "utf8");
  const pattern =
    kind === "status"
      ? new RegExp(`${STATUS_ENCODING[name as keyof typeof STATUS_ENCODING].token}:\\s*(#[0-9a-fA-F]{6})`)
      : new RegExp(`\\.swatch\\.${name}\\s*\\{[^}]*background:\\s*(#[0-9a-fA-F]{6})`);
  const match = pattern.exec(css);
  if (!match?.[1]) throw new Error(`no legend colour for ${kind} ${name}`);
  return new THREE.Color(match[1]);
}

/** Every overlay colour drawn in 3D with the legend entry it must match: the status tints and the tier tints. */
const OVERLAYS: { kind: "status" | "tier"; name: string; legend: string; colour: THREE.Color }[] = [
  ...(["recorded", "unresolved", "alternate"] as const).map((s) => ({ kind: "status" as const, name: s, legend: s, colour: STATUS_COLOUR[s] })),
  ...Object.entries(TIER_COLOUR).map(([tier, colour]) => ({ kind: "tier" as const, name: tier, legend: TIER_SWATCH[tier] ?? "", colour })),
];

describe("overlay colour", () => {
  for (const o of OVERLAYS) {
    for (const exposure of [1.0, 1.05]) {
      test(`the ${o.kind} overlay colour for ${o.name}, before blending, matches its legend swatch within ΔE 10 at exposure ${exposure}`, () => {
        const material = createOverlayMaterial(0.6);
        material.color.copy(o.colour);
        expect(deltaE(renderedSrgb(material, exposure), legendSwatch(o.kind, o.legend))).toBeLessThanOrEqual(10);
      });
    }
  }

  test("the check would catch tone mapping: ACES moves the recorded colour more than ΔE 10 from the swatch", () => {
    const material = createOverlayMaterial(0.6);
    material.color.copy(STATUS_COLOUR.recorded);
    material.toneMapped = true;
    expect(deltaE(renderedSrgb(material, 1.0), legendSwatch("status", "recorded"))).toBeGreaterThan(10);
  });
});

describe("texture keys", () => {
  test("a key carries the size and every factory parameter, so a changed factory never reuses a stale texture", () => {
    const base = textureKey("rearShell", "photo-navy-band", SEAT_TEXTURE_SIZE, { powerPanel: REAR_SHELL_POWER_PANEL });
    expect(base).not.toBe(textureKey("rearShell", "photo-navy-band", SEAT_TEXTURE_SIZE, { powerPanel: !REAR_SHELL_POWER_PANEL }));
    expect(base).not.toBe(textureKey("rearShell", "photo-navy-band", { width: 256, height: 512 }, { powerPanel: REAR_SHELL_POWER_PANEL }));
    expect(base).toContain(`${SEAT_TEXTURE_SIZE.width}x${SEAT_TEXTURE_SIZE.height}`);
    // parameter order does not matter
    const size = { width: 8, height: 8 };
    expect(textureKey("k", "p", size, { a: 1, b: true })).toBe(textureKey("k", "p", size, { b: true, a: 1 }));
  });

  test("a key's size is a TextureSize, never a bare number", () => {
    // a type check only: tsc rejects the call, so the function is never run
    const _bareNumber = () =>
      // @ts-expect-error a bare number is not a TextureSize
      textureKey("k", "p", 8);
    expect(typeof _bareNumber).toBe("function");
  });

  test("seat back and pan textures are 512 × 1024", () => {
    expect(SEAT_TEXTURE_SIZE).toEqual({ width: 512, height: 1024 });
  });
});

describe("setGhosted", () => {
  // three compiles an opaque material with alpha forced to 1 and rebuilds the program only when the material's version
  // changes: flipping `transparent` alone leaves a ghosted bin opaque if its program was last built unghosted.
  test("asks for a rebuilt program when, and only when, transparency changes", () => {
    const m = new THREE.MeshStandardMaterial();
    const v0 = m.version;
    setGhosted(m, true, 0.16);
    expect([m.transparent, m.opacity, m.depthWrite]).toEqual([true, 0.16, false]);
    expect(m.version).toBeGreaterThan(v0);
    const v1 = m.version;
    setGhosted(m, true, 0.16);
    expect(m.version).toBe(v1);
    setGhosted(m, false, 0.16);
    expect([m.transparent, m.opacity, m.depthWrite]).toEqual([false, 1, true]);
    expect(m.version).toBeGreaterThan(v1);
  });
});
