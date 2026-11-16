import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Selection, hover and status marks that read at any distance (WEB-21).
 *
 * Outlines are inverted hulls: the location's own shape drawn again from the inside (back faces), every vertex pushed out
 * along its normal in view space, in one flat unlit colour. The object hides the inside of the hull, so only a rim around
 * its silhouette shows. A rim also keeps a minimum width in screen pixels, so it does not vanish when the whole cabin is
 * in view. Status badges are camera-facing discs drawn from a glyph atlas, one instance per location.
 */

/** The viewport height in CSS pixels, shared by every outline and badge so their pixel minimums follow the canvas. */
export type ViewportUniform = { value: number };

/** Selection: 18 mm in the select colour, at least 3 px. */
export const SELECTION_OUTLINE = { widthMetres: 0.018, minPixels: 3 } as const;
/** Hover: 9 mm of white, at least 3 px, with a dark 3 mm hull inside it so it reads on pale shells and the pale background. */
export const HOVER_OUTLINE = { colour: "#ffffff", widthMetres: 0.009, minPixels: 3, inner: { colour: "#141a2e", widthMetres: 0.003, minPixels: 1.5 } } as const;

export interface OutlineOptions {
  /** the rim is never narrower than this many CSS pixels (needs `viewport`) */
  minPixels?: number;
  /** a second, narrower hull in another colour inside the first, drawn in the same call */
  inner?: { colour: THREE.ColorRepresentation; widthMetres: number; minPixels?: number };
  viewport?: ViewportUniform;
}

/**
 * The shape an outline is drawn from: positions only, with vertices that share a position welded and their normals
 * averaged, so a pushed hull stays closed at hard edges instead of cracking open along them.
 */
export function hullGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions = parts.map((part) => {
    const flat = part.index ? part.toNonIndexed() : part;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", (flat.getAttribute("position") as THREE.BufferAttribute).clone());
    if (flat !== part) flat.dispose();
    return g;
  });
  const merged = mergeGeometries(positions);
  for (const g of positions) g.dispose();
  if (!merged) throw new Error("hull parts could not be merged");
  const welded = mergeVertices(merged, 1e-4);
  merged.dispose();
  welded.computeVertexNormals();
  welded.computeBoundingSphere();
  return welded;
}

/** The pixel-minimum width of a rim at a view-space depth: `projectionMatrix[1][1]` is 1 / tan(fov / 2). */
const MIN_WIDTH_GLSL = /* glsl */ `
float outlineMetresPerPixel( float depth ) {
  return outlineViewportHeight > 0.0 ? 2.0 * depth / ( projectionMatrix[ 1 ][ 1 ] * outlineViewportHeight ) : 0.0;
}
`;

/**
 * An inverted-hull outline of `geometry`: back faces only, pushed `widthMetres` along their normals in view space (so a
 * scaled mesh keeps the same width), unlit and not tone mapped, so it is drawn as exactly `colour`. With `inner`, the
 * mesh is two instances: the first draws the inner hull, the second the outer one, in a single draw call.
 */
export function createOutline(
  geometry: THREE.BufferGeometry,
  colour: THREE.ColorRepresentation,
  widthMetres: number,
  options: OutlineOptions = {},
): THREE.Mesh {
  const inner = options.inner;
  const uniforms = {
    outlineWidth: { value: widthMetres },
    outlineMinPixels: { value: options.minPixels ?? 0 },
    outlineInnerWidth: { value: inner?.widthMetres ?? widthMetres },
    outlineInnerMinPixels: { value: inner?.minPixels ?? 0 },
    outlineInnerColour: { value: new THREE.Color(inner?.colour ?? colour) },
    outlineViewportHeight: options.viewport ?? { value: 0 },
  };
  const material = new THREE.MeshBasicMaterial({ color: colour, side: THREE.BackSide, depthTest: true, toneMapped: false });
  if (inner) material.defines = { OUTLINE_TWO_TONE: "" };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        /* glsl */ `uniform float outlineWidth;
uniform float outlineMinPixels;
uniform float outlineInnerWidth;
uniform float outlineInnerMinPixels;
uniform float outlineViewportHeight;
varying float vOutlineInner;
${MIN_WIDTH_GLSL}
void main() {`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
#ifdef OUTLINE_TWO_TONE
  float outlineInner = gl_InstanceID == 0 ? 1.0 : 0.0;
#else
  float outlineInner = 0.0;
#endif
float outlineMetres = mix( outlineWidth, outlineInnerWidth, outlineInner );
float outlinePixels = mix( outlineMinPixels, outlineInnerMinPixels, outlineInner );
float outlinePush = max( outlineMetres, outlinePixels * outlineMetresPerPixel( -mvPosition.z ) );
mvPosition.xyz += normalize( normalMatrix * normal ) * outlinePush;
gl_Position = projectionMatrix * mvPosition;
vOutlineInner = outlineInner;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 outlineInnerColour;\nvarying float vOutlineInner;\nvoid main() {")
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( mix( diffuse, outlineInnerColour, vOutlineInner ), opacity );");
  };
  material.customProgramCacheKey = () => (inner ? "outline-two-tone" : "outline");
  const mesh = inner ? new THREE.InstancedMesh(geometry, material, 2) : new THREE.Mesh(geometry, material);
  // the geometry is swapped for each location it outlines; the marks are few, so they are never culled
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 8;
  return mesh;
}

/**
 * A flat frame lying on the floor around an area of `lx` × `lz` metres, inside its edge: a hull cannot outline a floor
 * area, whose inside nothing hides. `rings` run from the edge inward, each `width` metres in its own colour.
 */
export function frameGeometry(lx: number, lz: number, rings: readonly { width: number; colour: THREE.ColorRepresentation }[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let inset = 0;
  for (const ring of rings) {
    const hx = lx / 2 - inset;
    const hz = lz / 2 - inset;
    const ix = hx - ring.width;
    const iz = hz - ring.width;
    const shape = new THREE.Shape([new THREE.Vector2(-hx, -hz), new THREE.Vector2(hx, -hz), new THREE.Vector2(hx, hz), new THREE.Vector2(-hx, hz)]);
    shape.holes.push(new THREE.Path([new THREE.Vector2(-ix, -iz), new THREE.Vector2(-ix, iz), new THREE.Vector2(ix, iz), new THREE.Vector2(ix, -iz)]));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute("uv");
    const colour = new THREE.Color(ring.colour);
    const count = g.getAttribute("position").count;
    g.setAttribute("color", new THREE.Float32BufferAttribute(Array.from({ length: count }, () => [colour.r, colour.g, colour.b]).flat(), 3));
    parts.push(g);
    inset += ring.width;
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("frame rings could not be merged");
  return merged;
}

/** The mesh that draws a frameGeometry(): vertex colours, unlit, not tone mapped, lifted clear of the floor overlays. */
export function createFrame(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  return mesh;
}

// ---- status badges ----------------------------------------------------------------------------------

/** Badge discs: 12 cm across, at least 14 px. */
export const BADGE = { sizeMetres: 0.12, minPixels: 14, liftMetres: 0.2 } as const;

/**
 * One camera-facing disc per instance, showing the atlas cell in the instance's `badgeCell` attribute, tinted by the
 * instance colour. An instance's matrix places its centre; the mesh's count says how many are drawn. Unlit and not tone mapped, so a disc
 * is drawn in exactly the status colour of the legend. Each disc is pulled a little toward the camera, so it is drawn
 * over the headrest, floor or bin door it sits on, but stays hidden behind anything nearer.
 */
export function createBadges(count: number, atlas: THREE.Texture, cells: number, viewport: ViewportUniform): THREE.InstancedMesh {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute("badgeCell", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  const material = new THREE.MeshBasicMaterial({ map: atlas, transparent: true, alphaTest: 0.1, toneMapped: false, depthTest: true, depthWrite: true });
  const uniforms = {
    badgeSize: { value: BADGE.sizeMetres },
    badgeMinPixels: { value: BADGE.minPixels },
    badgeLift: { value: BADGE.liftMetres },
    outlineViewportHeight: viewport,
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        /* glsl */ `uniform float badgeSize;
uniform float badgeMinPixels;
uniform float badgeLift;
uniform float outlineViewportHeight;
attribute float badgeCell;
${MIN_WIDTH_GLSL}
void main() {`,
      )
      .replace("#include <uv_vertex>", `#include <uv_vertex>\nvMapUv.x = ( vMapUv.x + badgeCell ) / ${cells.toFixed(1)};`)
      .replace(
        "#include <project_vertex>",
        /* glsl */ `vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
float badgeDepth = -mvPosition.z;
float badgeSide = max( badgeSize, badgeMinPixels * outlineMetresPerPixel( badgeDepth ) );
mvPosition.xyz -= normalize( mvPosition.xyz ) * min( badgeLift, badgeDepth * 0.5 );
mvPosition.xy += position.xy * badgeSide;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => `badges-${cells}`;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return mesh;
}
