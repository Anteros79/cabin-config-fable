import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { allCss, STYLES_DIR, styleFiles } from "./css.ts";

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

  test("every var(--x) used is defined", () => {
    const css = allCss();
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // set inline by components: StatusGlyph sets --status-colour
    defined.add("--status-colour");
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
