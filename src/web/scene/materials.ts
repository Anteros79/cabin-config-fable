import * as THREE from "three";
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

/** Status overlay colours. The legend swatches in styles.css use the same values. */
export const STATUS_COLOUR = { recorded: new THREE.Color("#2fe08a"), unresolved: new THREE.Color("#ff5757") };

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
