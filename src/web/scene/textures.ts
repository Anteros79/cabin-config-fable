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

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2D canvas is unavailable");
  return { c, g };
}

function toTexture(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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

/**
 * Seat back, front face. Evidence: tall back with a horizontal seam under the headrest, an
 * angled pale upper band in the banded family, and a lower field of parallel stitched channels
 * meeting in an off-centre chevron ("recarro 2.jpg", "seats 4.jpg", "seats 5.jpg", "seats 8.jpg").
 */
export function backFrontTexture(p: ProfilePalette): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const { c, g } = canvas(w, h);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, p.upholsteryDark);
  grad.addColorStop(0.18, p.upholstery);
  grad.addColorStop(0.82, p.upholstery);
  grad.addColorStop(1, p.upholsteryDark);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  grain(g, w, h, 0.05, 7);

  const fieldTop = p.band ? 222 : 204;
  // lower stitched field: parallel channels converging on an off-centre chevron line
  g.save();
  g.beginPath();
  g.rect(10, fieldTop, w - 20, h - fieldTop - 6);
  g.clip();
  const apex = w * 0.66;
  g.lineWidth = 2.2;
  for (let i = -6; i < 14; i++) {
    const y0 = fieldTop + i * 46;
    for (const pass of [0, 1]) {
      g.strokeStyle = pass === 0 ? (p.id === "concept-gray" ? "rgba(0,0,0,0.2)" : "rgba(0,0,0,0.42)") : p.stitch;
      g.lineWidth = pass === 0 ? 4.5 : 1.3;
      if (pass === 1) g.setLineDash([5, 3]);
      else g.setLineDash([]);
      g.beginPath();
      g.moveTo(0, y0 - 150);
      g.lineTo(apex, y0 + 70);
      g.lineTo(w, y0 - 40);
      g.stroke();
    }
  }
  g.restore();
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
    g.strokeStyle = "rgba(10,16,50,0.55)";
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, 226);
    g.lineTo(w, 186);
    g.stroke();
  }
  // horizontal seams below the headrest
  g.strokeStyle = "rgba(0,0,0,0.5)";
  g.lineWidth = 2.5;
  for (const y of p.band ? [] : [148, 204]) {
    g.beginPath();
    g.moveTo(6, y);
    g.lineTo(w - 6, y);
    g.stroke();
  }
  // soft vignette for leather sheen
  const sheen = g.createLinearGradient(0, 0, 0, h);
  sheen.addColorStop(0, "rgba(255,255,255,0.06)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.22)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, w, h);
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
  const w = 256;
  const h = 512;
  const { c, g } = canvas(w, h);
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
  const size = 1024;
  const { c, g } = canvas(size, size);
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
  const w = 512;
  const h = 256;
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
  const w = 256;
  const h = 128;
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
  const w = 256;
  const h = 256;
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
