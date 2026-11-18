import * as THREE from "three";
import type { SceneStatusKey } from "../theme.ts";
import type { ProfilePalette } from "./textures.ts";

/**
 * Seat materials (WEB-21). Upholstery is a physical material: a soft sheen at grazing angles and a faint clear coat give
 * the leather its look under the environment light, and a normal map from the stitched height map gives the seams relief.
 * Final values, tuned by eye against comparison sheets 01 and 03, are recorded in docs/visual-families.md.
 */
export const UPHOLSTERY = {
  roughness: 0.55,
  /** scales the dielectric reflectance: at full strength the bright room's reflection greys the dark navy */
  specularIntensity: 0.5,
  sheen: 0.4,
  sheenRoughness: 0.5,
  /** how far the sheen colour is lifted from the upholstery toward white */
  sheenLift: 0.2,
  clearcoat: 0.08,
  clearcoatRoughness: 0.6,
  normalScale: 0.6,
} as const;
export const METAL = { metalness: 1, roughness: 0.35 } as const;
export const SHELL = { roughness: 0.7 } as const;
export const PAD = { roughness: 0.5 } as const;

export interface SeatMaps {
  colour: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
}

export interface SeatMaterialSet {
  upholstery: THREE.MeshPhysicalMaterial;
  shell: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  pad: THREE.MeshStandardMaterial;
}

const WHITE = new THREE.Color("#ffffff");

/** The materials of a seat in one visual family. Upholstery takes its colour from `maps.colour`, which already carries the family's palette. */
export function createSeatMaterials(profile: ProfilePalette, maps: SeatMaps): SeatMaterialSet {
  const upholstery = new THREE.MeshPhysicalMaterial({
    color: WHITE,
    map: maps.colour,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(UPHOLSTERY.normalScale, UPHOLSTERY.normalScale),
    roughness: UPHOLSTERY.roughness,
    roughnessMap: maps.roughness,
    specularIntensity: UPHOLSTERY.specularIntensity,
    sheen: UPHOLSTERY.sheen,
    sheenRoughness: UPHOLSTERY.sheenRoughness,
    sheenColor: new THREE.Color(profile.upholstery).lerp(WHITE, UPHOLSTERY.sheenLift),
    clearcoat: UPHOLSTERY.clearcoat,
    clearcoatRoughness: UPHOLSTERY.clearcoatRoughness,
  });
  return {
    upholstery,
    shell: new THREE.MeshStandardMaterial({ color: profile.shell, roughness: SHELL.roughness, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: profile.metal, roughness: METAL.roughness, metalness: METAL.metalness }),
    pad: new THREE.MeshStandardMaterial({ color: profile.armPad, roughness: PAD.roughness, metalness: 0 }),
  };
}

/**
 * The same upholstery on another part: with that part's maps, or plain in a palette colour (headrest, back core, wing
 * face), keeping sheen and clear coat. The sheen colour follows the part's colour.
 */
export function upholsteryVariant(base: THREE.MeshPhysicalMaterial, variant: { colour: string } | { maps: SeatMaps }): THREE.MeshPhysicalMaterial {
  const material = base.clone();
  if ("maps" in variant) {
    material.map = variant.maps.colour;
    material.normalMap = variant.maps.normal;
    material.roughnessMap = variant.maps.roughness;
  } else {
    material.map = material.normalMap = material.roughnessMap = null;
    material.color.set(variant.colour);
    material.sheenColor.set(variant.colour).lerp(WHITE, UPHOLSTERY.sheenLift);
  }
  return material;
}

/** The per-instance attribute that carries a seat piece's status tint: linear RGB, and the tint's opacity in w (0: none). */
export const STATUS_TINT_ATTRIBUTE = "statusTint";
/** How strongly a status tints a seat piece, as the translucent headrest overlay it replaces did (WEB-21). */
export const HEADREST_TINT_OPACITY = 0.6;

/**
 * A seat piece's status tint, drawn by the piece's own material instead of a second, translucent copy of its geometry
 * (WEB-20: that copy cost 900 triangles per tinted seat, 158 400 on a visit where every seat has a status). The final
 * colour is mixed toward the status colour after tone mapping and the output colour space, which is the same sum the
 * overlay's blending made: an unlit, not tone-mapped colour over the lit piece at the overlay's opacity. The mesh's
 * geometry must carry STATUS_TINT_ATTRIBUTE as an instanced vec4.
 */
export function withStatusTint<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `attribute vec4 ${STATUS_TINT_ATTRIBUTE};\nvarying vec4 vStatusTint;\nvoid main() {`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvStatusTint = ${STATUS_TINT_ATTRIBUTE};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying vec4 vStatusTint;\nvoid main() {")
      .replace(
        "#include <colorspace_fragment>",
        "#include <colorspace_fragment>\ngl_FragColor.rgb = mix( gl_FragColor.rgb, linearToOutputTexel( vec4( vStatusTint.rgb, 1.0 ) ).rgb, vStatusTint.a );",
      );
  };
  material.customProgramCacheKey = () => "status-tint";
  return material;
}

/**
 * Status colours in 3D: the seat piece tints, the floor and bin tints and the badge discs. They are the `--status-*` tokens
 * that STATUS_ENCODING names (src/web/styles/tokens.css), which the map and the legends draw; a test holds the two equal.
 * Recorded, unresolved and alternate are the same in every theme. The problem statuses follow the theme through the
 * `--scene-status-*` tokens (CabinScene.setTheme); the values here are their light values, used until the page's are read
 * (and in jsdom, which has no stylesheet).
 */
export const STATUS_COLOUR = {
  recorded: new THREE.Color("#2fe08a"),
  unresolved: new THREE.Color("#ff5757"),
  alternate: new THREE.Color("#5b8cff"),
  mustFix: new THREE.Color("#e00b75"),
  deferred: new THREE.Color("#d26203"),
  carried: new THREE.Color("#9a10ff"),
  noted: new THREE.Color("#0f6cb4"),
} as const;

/**
 * The disc of a blocked seat's "Blocked" badge: grey, the light value of `--scene-status-blocked` (the `--border-strong`
 * token the legend draws it with). The page's value replaces it per theme (CabinScene.setTheme).
 */
export const BLOCKED_COLOUR = new THREE.Color("#8791a8");

/** The selection outline and floor frame: the `--select` token, the same in every theme; a test holds the two equal. */
export const SELECT_COLOUR = "#b97c00";

/**
 * What the scene takes from the page theme (CabinScene.setTheme): the `--scene-bg`, `--scene-outline` and `--scene-wash`
 * tokens, and the `--scene-status-*` tokens.
 */
export interface SceneTheme {
  /** the background in neutral cabin light (blue cabin light keeps its own) */
  background: string;
  /** the hover outline's outer hull and floor frame */
  outline: string;
  /** the ceiling wash in neutral light (blue cabin light keeps its own) */
  wash: string;
  /** the problem status and blocked badge colours; one left out keeps its light value (STATUS_COLOUR, BLOCKED_COLOUR) */
  status?: Partial<Record<SceneStatusKey, string>>;
}
/** The light theme's values, which the scene starts with; a test holds them equal to tokens.css. */
export const LIGHT_SCENE_THEME: SceneTheme = { background: "#eef0f4", outline: "#ffffff", wash: "#ffffff" };

/** Tier and zone tints on the seat pan in the "Tier / zone" colour mode, keyed by commercial tier or maintenance zone. */
export const TIER_COLOUR: Record<string, THREE.Color> = {
  "Extra Legroom": new THREE.Color("#19c8b4"),
  Preferred: new THREE.Color("#b08cff"),
  ELR: new THREE.Color("#19c8b4"),
  EXIT: new THREE.Color("#ff9550"),
};
/** The legend swatch (`.swatch.<class>` in src/web/styles/viewer.css) that shows each tier tint. */
export const TIER_SWATCH: Record<string, string> = { "Extra Legroom": "tier-elr", Preferred: "tier-pref", ELR: "tier-elr", EXIT: "tier-exit" };

/**
 * A translucent status or tier overlay. It is not tone mapped: ACES would desaturate the colour (ΔE 26.5
 * for "recorded"), so the overlay would no longer match its legend swatch. Unmapped, it is drawn as exactly the swatch
 * colour before blending, at any exposure.
 */
export function createOverlayMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, color: "#ffffff", toneMapped: false });
}

/**
 * Ghost a material (translucent, not writing depth) or restore it. three compiles an opaque material with alpha forced to
 * 1 and rebuilds the program only on needsUpdate, so a change of transparency asks for one: otherwise a material whose
 * program was rebuilt while unghosted (as a light change does, since it changes the environment) stays opaque when ghosted.
 */
export function setGhosted(material: THREE.Material, ghost: boolean, ghostOpacity: number): void {
  if (material.transparent !== ghost) material.needsUpdate = true;
  material.transparent = ghost;
  material.opacity = ghost ? ghostOpacity : 1;
  material.depthWrite = !ghost;
}
