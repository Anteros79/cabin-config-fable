import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type LightMode = "neutral" | "blue";

/** scene.environmentIntensity per light mode: blue cabin light is dimmer overall, with its key and fill carrying the tint. */
export const ENVIRONMENT_INTENSITY: Record<LightMode, number> = { neutral: 1.0, blue: 0.55 };
/** In blue mode the emissive panels of the room take this colour, and its main light the paler one: a blue wash, whites stay pale. */
export const BLUE_PANEL_COLOUR = "#7d94ff";
export const BLUE_ROOM_LIGHT_COLOUR = "#c4cdff";

/**
 * Image-based light for the cabin (WEB-21): three's RoomEnvironment, its emissive panels tinted for blue cabin light,
 * prefiltered by PMREM. The caller owns the returned texture: disposing it also releases the render target behind it.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer, mode: LightMode): THREE.Texture {
  const room = new RoomEnvironment();
  if (mode === "blue") {
    room.traverse((object) => {
      if (object instanceof THREE.PointLight) object.color.set(BLUE_ROOM_LIGHT_COLOUR);
      const material = (object as THREE.Mesh).material;
      // the area lights are the emissive-only Lambert panels; the room shell and boxes keep their own materials
      if (material instanceof THREE.MeshLambertMaterial) material.emissive.set(BLUE_PANEL_COLOUR);
    });
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    const target = pmrem.fromScene(room, 0.04);
    const texture = target.texture;
    // Disposing a render target's texture alone would leave its framebuffer behind.
    texture.addEventListener("dispose", () => target.dispose());
    return texture;
  } finally {
    pmrem.dispose();
    room.dispose();
  }
}
