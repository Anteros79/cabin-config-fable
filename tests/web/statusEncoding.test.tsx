import { render, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { CarriedObservation, Observation, VisitRecord } from "../../src/domain/types.ts";
import { Cabin3D } from "../../src/web/components/Cabin3D.tsx";
import { CabinMap } from "../../src/web/components/CabinMap.tsx";
import { buildStates, type LocationStatus, STATUS_ENCODING, type Workspace } from "../../src/web/model.ts";
import { STATUS_COLOUR } from "../../src/web/scene/materials.ts";
import { BADGE_GLYPHS } from "../../src/web/scene/textures.ts";
import { fixtureRelease, snapshotFor } from "../helpers.ts";
import { blocks, declarations, lightTokens, resolveToken, styleFile } from "./css.ts";

// jsdom has no WebGL; the legend does not need a scene.
vi.mock("../../src/web/scene/CabinScene.ts", () => ({
  CabinScene: class {
    constructor() {
      throw new Error("no WebGL in jsdom");
    }
  },
}));

const STATUSES = Object.keys(STATUS_ENCODING) as LocationStatus[];
/** The dark theme's tokens (the system-setting block; the chosen-dark block is held equal to it in tokens.test.ts). */
const DARK = declarations(blocks(blocks(styleFile("tokens.css"), "@media (prefers-color-scheme: dark)")[0] ?? "", ':root:not([data-theme="light"])')[0] ?? "");
/**
 * The value of a `--status-*` token in tokens.css, in the light theme or the dark one: one hex colour. Recorded,
 * unresolved and alternate are the same in both; the problem statuses differ, and the 3D view draws them as the page has them.
 */
function tokenHex(token: string, theme: "light" | "dark" = "light"): string {
  const value = theme === "dark" ? resolveToken(token, DARK, lightTokens()) : (lightTokens().get(token) ?? "");
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`no hex value for ${token} in tokens.css`);
  return value;
}

// ---- colour vision deficiency simulation ------------------------------------------------------

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearRgb = (hex: string) => [1, 3, 5].map((i) => srgbToLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255));

/** Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB. */
const MACHADO: Record<"protanopia" | "deuteranopia", number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

const simulate = (m: number[][], rgb: number[]) =>
  m.map((row) =>
    Math.min(
      1,
      Math.max(
        0,
        row.reduce((s, k, i) => s + k * (rgb[i] ?? 0), 0),
      ),
    ),
  );

/** CIELAB (D65) of a linear RGB colour. */
function lab([r = 0, g = 0, b = 0]: number[]): number[] {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference. */
const deltaE = (a: number[], b: number[]) => {
  const [l1 = 0, a1 = 0, b1 = 0] = lab(a);
  const [l2 = 0, a2 = 0, b2 = 0] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

// ---- a visit workspace with one location in each status ---------------------------------------

const snap = snapshotFor(fixtureRelease(), "N100TL", "2026-11-12");
const recordAt = (locationId: string, componentId: string): VisitRecord => ({
  locationId,
  componentId,
  selection: "PRIMARY",
  substituteId: null,
  quantity: 1,
  note: "",
  version: 1,
  ruleId: "R",
  primaryPartNo: "P",
  locationLabel: locationId,
  componentName: componentId,
  lines: [],
  createdAt: "2026-11-12T12:01:00.000Z",
  updatedAt: "2026-11-12T12:01:00.000Z",
});

const problemAt = (locationId: string, componentId: string, over: Partial<Observation>): Observation => ({
  id: `OBS-${locationId}-${componentId}`,
  tail: "N100TL",
  status: "OPEN",
  version: 1,
  melClass: { class: "COSMETIC" },
  dueDate: null,
  blocksSeat: false,
  openedInVisitId: "visit-1",
  closedInVisitId: null,
  closedAs: null,
  locationLabel: locationId,
  componentName: componentId,
  createdAt: "2026-11-12T12:02:00.000Z",
  updatedAt: "2026-11-12T12:02:00.000Z",
  locationId,
  componentId,
  condition: "STAINED",
  note: "",
  outcome: "NOTED",
  ...over,
});
const carriedProblem: CarriedObservation = {
  observation: { ...problemAt("SEAT:4C", "CUSHION", { outcome: "DEFERRED" }), openedInVisitId: "visit-0" },
  placement: "SAME",
  locationId: "SEAT:4C",
  overdue: false,
};

function workspaceWithEveryStatus(): Workspace {
  const components = snap.resolution.components.map((c) =>
    c.locationId === "SEAT:5B" && c.componentId === "CUSHION"
      ? { locationId: c.locationId, componentId: c.componentId, status: "NO_MATCH" as const, message: "none", excluded: [] }
      : c,
  );
  return {
    mode: "visit",
    layout: snap.context.layoutRevision,
    resolution: { ...snap.resolution, components },
    componentDefs: snap.resolution.componentDefs,
    records: [recordAt("SEAT:3A", "CUSHION")],
    editable: true,
    unresolvedReason: null,
    observations: [
      problemAt("SEAT:4A", "CUSHION", { outcome: "MUST_FIX" }),
      problemAt("SEAT:4B", "CUSHION", { outcome: "DEFERRED" }),
      problemAt("SEAT:4D", "CUSHION", { outcome: "NOTED" }),
    ],
    carried: [carriedProblem],
    checkDate: "2026-11-12",
    mel: [],
  };
}

describe("STATUS_ENCODING", () => {
  test("every status has a distinct glyph or is 'none', and a label", () => {
    const glyphs = STATUSES.map((s) => STATUS_ENCODING[s].glyph).filter((g) => g !== "none");
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(STATUS_ENCODING.none.glyph).toBe("none");
    for (const s of STATUSES) {
      expect(STATUS_ENCODING[s].label.trim().length).toBeGreaterThan(0);
      // a status with a glyph has a colour token defined in tokens.css
      if (STATUS_ENCODING[s].glyph !== "none") expect(tokenHex(STATUS_ENCODING[s].token)).toMatch(/^#/);
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`status token colours are distinguishable under simulated deuteranopia and protanopia, in the ${theme} theme`, () => {
      const coloured = STATUSES.filter((s) => STATUS_ENCODING[s].token !== "");
      expect(coloured).toEqual(["mustFix", "deferred", "carried", "noted", "recorded", "unresolved", "alternate"]);
      for (const [kind, matrix] of Object.entries(MACHADO)) {
        for (const [i, a] of coloured.entries()) {
          for (const b of coloured.slice(i + 1)) {
            const difference = deltaE(
              simulate(matrix, linearRgb(tokenHex(STATUS_ENCODING[a].token, theme))),
              simulate(matrix, linearRgb(tokenHex(STATUS_ENCODING[b].token, theme))),
            );
            const differentGlyph = STATUS_ENCODING[a].glyph !== STATUS_ENCODING[b].glyph;
            expect(difference >= 15 || differentGlyph, `${a} and ${b} under ${kind}: ΔE ${difference.toFixed(1)}, same glyph`).toBe(true);
            // and the colours alone are distinguishable too, so a glyph too small to read still leaves the colour
            expect(difference, `${a} and ${b} under ${kind}`).toBeGreaterThanOrEqual(15);
          }
        }
      }
    });
  }
});

describe("the scene uses the same encoding", () => {
  test("each 3D status colour is exactly its --status-* token", () => {
    for (const s of ["recorded", "unresolved", "alternate"] as const) {
      expect(`#${STATUS_COLOUR[s].getHexString()}`).toBe(tokenHex(STATUS_ENCODING[s].token).toLowerCase());
    }
  });

  test("every glyph has a cell in the badge atlas", () => {
    for (const s of STATUSES) expect(BADGE_GLYPHS, s).toContain(STATUS_ENCODING[s].glyph);
  });
});

describe("glyphs in the map and the legend", () => {
  test("buildStates gives each status used below", () => {
    const { flags } = buildStates(workspaceWithEveryStatus());
    expect(flags.get("SEAT:3A")?.status).toBe("recorded");
    expect(flags.get("SEAT:5B")?.status).toBe("unresolved");
    expect([...flags.values()].some((f) => f.status === "alternate")).toBe(true);
    expect(["SEAT:4A", "SEAT:4B", "SEAT:4C", "SEAT:4D"].map((id) => flags.get(id)?.status)).toEqual(["mustFix", "deferred", "carried", "noted"]);
  });

  test("the legend and the map render the same glyph for a status", () => {
    const ws = workspaceWithEveryStatus();
    const { scene, flags } = buildStates(ws);
    const legend = render(<Cabin3D workspace={ws} states={scene} selection={null} onSelect={vi.fn()} visualProfiles={[]} onFailed={vi.fn()} />);
    const legendList = legend.getByRole("list", { name: "Legend" });
    const legendGlyph = (s: LocationStatus) => legendList.querySelector(`[data-status="${s}"] svg`)?.outerHTML;
    const legendHtml = Object.fromEntries(STATUSES.map((s) => [s, legendGlyph(s)]));
    legend.unmount();

    const map = render(<CabinMap workspace={ws} flags={flags} selection={null} onSelect={vi.fn()} />);
    for (const s of STATUSES) {
      const located = ws.layout.locations.find((l) => flags.get(l.id)?.status === s);
      if (STATUS_ENCODING[s].glyph === "none") {
        // no glyph anywhere: not in the legend, not on a location without status
        expect(legendHtml[s]).toBeUndefined();
        const plain = ws.layout.locations.find((l) => !flags.has(l.id) || flags.get(l.id)?.status === "none");
        if (!plain) throw new Error("no location without status");
        expect(map.container.querySelector(`[data-location="${plain.id}"] svg, [data-seat="${plain.seat?.code}"] svg`)).toBeNull();
        continue;
      }
      if (!located) throw new Error(`no location with status ${s}`);
      const button = map.container.querySelector(`[data-location="${located.id}"]`) ?? map.container.querySelector(`[data-seat="${located.seat?.code}"]`);
      if (!button) throw new Error(`no map button for ${located.id}`);
      const glyph = button.querySelector("svg");
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(glyph?.outerHTML).toBe(legendHtml[s]);
      // the map's own key shows the same glyph beside the same label
      const key = within(map.getByRole("list", { name: "Status key" }));
      const entry = key.getByText(STATUS_ENCODING[s].label).closest("li");
      expect(entry?.querySelector("svg")?.outerHTML).toBe(legendHtml[s]);
    }
  });
});
