import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { LIGHT_SCENE_THEME, SELECT_COLOUR } from "../../src/web/scene/materials.ts";
import { allCss, blocks, declarations, lightTokens, resolveToken, STYLES_DIR, styleFile, styleFiles } from "./css.ts";

/** Files that may hold colour literals: the tokens, and print, which pins paper colours. */
const LITERALS_ALLOWED = new Set(["tokens.css", "print.css"]);
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
/** CSS named colours an author might reach for; system colours (Canvas, Highlight...) stay allowed for forced colours. */
const NAMED_COLOUR =
  /:\s*[^;{}]*\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|brown|tan|beige|ivory|crimson|indigo|violet|cyan|magenta)\b/i;

describe("stylesheet files", () => {
  test("index.css imports every file in src/web/styles, tokens first and print last", () => {
    const names = styleFiles().map((f) => f.name);
    expect(names).toEqual(["tokens.css", "base.css", "layout.css", "forms.css", "viewer.css", "map.css", "inspector.css", "report.css", "print.css"]);
    expect(
      readdirSync(STYLES_DIR)
        .filter((n) => n !== "index.css")
        .sort(),
    ).toEqual([...names].sort());
  });

  test("no colour literal outside tokens.css and print.css", () => {
    const found: string[] = [];
    for (const { name, css } of styleFiles()) {
      if (LITERALS_ALLOWED.has(name)) continue;
      css.split("\n").forEach((line, i) => {
        const code = line.replace(/\/\*.*?\*\//g, "");
        if (COLOUR_LITERAL.test(code) || NAMED_COLOUR.test(code)) found.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("no raw font size, space step, control size, radius, shadow or duration outside tokens.css and print.css", () => {
    // Enforced: these properties take their lengths and times from tokens. Not enforced, as structure rather than design
    // steps: layout dimensions (width, height, max-width, max-height, grid tracks, columns, flex bases), positions
    // (top, left, right, bottom, inset, vertical-align), border and outline widths and offsets, and gradient stops.
    const ENFORCED =
      /^(font-size|margin(-\w+)?|padding(-\w+)?|(row-|column-)?gap|min-height|min-width|border(-\w+)*-radius|box-shadow|transition(-\w+)?|animation(-\w+)?)$/;
    // structural values that stay literal: zero, auto, keywords, 100%, !important
    const ALLOWED = /^(0|auto|none|inherit|100%|!important|-?var\(--[\w-]+\))$/;
    const found: string[] = [];
    for (const { name, css } of styleFiles()) {
      if (LITERALS_ALLOWED.has(name)) continue;
      css.split("\n").forEach((line, i) => {
        const m = /^\s*([a-z-]+)\s*:\s*([^;{]+);/.exec(line.replace(/\/\*.*?\*\//g, ""));
        if (!m?.[1] || !ENFORCED.test(m[1])) return;
        const values = (m[2] ?? "").replace(/,/g, " ").trim().split(/\s+/);
        if (values.some((v) => !ALLOWED.test(v))) found.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("every var(--x) used is defined", () => {
    const css = allCss();
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // set inline by components: StatusGlyph sets --status-colour
    defined.add("--status-colour");
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});

// ---- themes --------------------------------------------------------------------------------------

const tokensCss = styleFile("tokens.css");
const light = lightTokens();
const darkBySystem = declarations(blocks(blocks(tokensCss, "@media (prefers-color-scheme: dark)")[0] ?? "", ':root:not([data-theme="light"])')[0] ?? "");
const darkByChoice = declarations(blocks(tokensCss, ':root[data-theme="dark"]')[0] ?? "");
const lightByChoice = declarations(blocks(tokensCss, ':root[data-theme="light"]')[0] ?? "");
const printed = declarations(blocks(blocks(styleFile("print.css"), "@media print")[0] ?? "", ':root:not([data-theme="light"])')[0] ?? "");

type Rgba = [number, number, number, number];
/** A token's colour in a theme, composited over `under` when it is translucent. */
function colour(name: string, theme: Map<string, string>[], under?: Rgba): Rgba {
  const value = resolveToken(name, ...theme);
  let rgba: Rgba;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    rgba = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)).concat(1) as Rgba;
  } else {
    const parts = /^rgba\(([^)]+)\)$/.exec(value)?.[1]?.split(",").map(Number);
    if (parts?.length !== 4) throw new Error(`${name} is not a colour: ${value}`);
    rgba = parts as Rgba;
  }
  if (rgba[3] === 1 || !under) return rgba;
  const a = rgba[3];
  return [0, 1, 2].map((i) => (rgba[i] ?? 0) * a + (under[i] ?? 0) * (1 - a)).concat(1) as Rgba;
}
function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const GRAPHIC = 3;
const SURFACES = ["--surface-0", "--surface-1", "--surface-2", "--surface-hover", "--surface-muted", "--surface-control"];
/** [foreground, background, minimum ratio, backdrop under a translucent background]. */
const PAIRS: [string, string, number, string?][] = [
  ...SURFACES.map((s): [string, string, number] => ["--text-body", s, TEXT]),
  ...SURFACES.map((s): [string, string, number] => ["--text-strong", s, TEXT]),
  ...SURFACES.map((s): [string, string, number] => ["--text-muted", s, TEXT]),
  ["--accent", "--surface-0", TEXT],
  ["--accent", "--surface-1", TEXT],
  ["--accent-contrast", "--accent", TEXT],
  ["--accent-contrast", "--accent-hover", TEXT],
  ["--header-text", "--header-bg", TEXT],
  ["--header-current-text", "--header-current-bg", TEXT],
  ["--badge-text", "--badge-bg", TEXT],
  ...SURFACES.map((s): [string, string, number] => ["--focus", s, GRAPHIC]),
  ["--header-focus", "--header-bg", GRAPHIC],
  ["--select", "--surface-0", GRAPHIC],
  ["--select", "--surface-1", GRAPHIC],
  ["--border-strong", "--surface-1", GRAPHIC],
  ["--success", "--surface-1", TEXT],
  ["--success", "--success-bg", TEXT],
  ["--success-text", "--success-bg", TEXT],
  ["--warning", "--surface-1", TEXT],
  ["--warning", "--warning-bg", TEXT],
  ["--warning-text", "--warning-bg", TEXT],
  ["--danger", "--surface-1", TEXT],
  ["--danger", "--danger-bg", TEXT],
  ["--danger-text", "--danger-bg", TEXT],
  ["--danger-contrast", "--danger", TEXT],
  ["--info-text", "--info-bg", TEXT],
  ["--status-recorded-text", "--status-recorded-bg", TEXT],
  ["--status-unresolved-text", "--status-unresolved-bg", TEXT],
  ["--status-alternate-text", "--status-alternate-bg", TEXT],
  ["--status-glyph", "--status-recorded", GRAPHIC],
  ["--status-glyph", "--status-unresolved", GRAPHIC],
  ["--status-glyph", "--status-alternate", GRAPHIC],
  ["--hint-text", "--hint-bg", TEXT],
  ["--overlay-text", "--overlay-bg", TEXT, "--scene-bg"],
  ["--text-body", "--legend-bg", TEXT, "--scene-bg"],
  ["--text-muted", "--scene-bg", TEXT],
  ["--header-border", "--header-bg", GRAPHIC, "--header-bg"],
];

describe("themes", () => {
  test("the page declares both colour schemes; a choice pins one", () => {
    expect(blocks(tokensCss, ":root")[0]).toMatch(/color-scheme: light dark;/);
    expect(blocks(tokensCss, ':root[data-theme="dark"]')[0]).toMatch(/color-scheme: dark;/);
    expect(blocks(tokensCss, ':root[data-theme="light"]')[0]).toMatch(/color-scheme: light;/);
    expect(lightByChoice.size).toBe(0);
  });

  test("the system dark theme and the chosen dark theme are the same", () => {
    expect(darkBySystem.size).toBeGreaterThan(20);
    expect(Object.fromEntries(darkByChoice)).toEqual(Object.fromEntries(darkBySystem));
  });

  test("the dark theme redefines light tokens only, and never the status, tier or select colours", () => {
    for (const name of darkBySystem.keys()) expect(light.has(name), name).toBe(true);
    for (const fixed of [
      "--select",
      "--status-recorded",
      "--status-unresolved",
      "--status-alternate",
      "--status-glyph",
      "--tier-elr",
      "--tier-pref",
      "--tier-exit",
    ]) {
      expect(darkBySystem.has(fixed), fixed).toBe(false);
    }
  });

  test("print always uses the light tokens", () => {
    expect(printed.size).toBeGreaterThan(0);
    for (const name of darkBySystem.keys()) expect(printed.get(name), name).toBe(light.get(name));
    for (const [name, value] of printed) expect(light.get(name), name).toBe(value);
  });

  for (const [themeName, theme] of [
    ["light", [light]],
    ["dark", [darkBySystem, light]],
  ] as const) {
    test(`text and status token pairs meet WCAG AA in the ${themeName} theme`, () => {
      const failures: string[] = [];
      for (const [fg, bg, min, backdrop] of PAIRS) {
        const under = backdrop ? colour(backdrop, [...theme]) : undefined;
        const ratio = contrast(colour(fg, [...theme], under), colour(bg, [...theme], under));
        if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("the 3D view uses the same colours", () => {
  test("the select colour and the scene's starting theme are the light tokens", () => {
    expect(SELECT_COLOUR).toBe(light.get("--select"));
    expect(LIGHT_SCENE_THEME).toEqual({ background: light.get("--scene-bg"), outline: light.get("--scene-outline"), wash: light.get("--scene-wash") });
  });
});
