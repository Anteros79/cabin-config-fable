import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The stylesheet folder (WEB-16). */
export const STYLES_DIR = join(import.meta.dirname, "../../src/web/styles");

/** The stylesheet's files in cascade order, as index.css imports them. */
export function styleFiles(): { name: string; css: string }[] {
  const index = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
  return [...index.matchAll(/@import "\.\/([\w-]+\.css)";/g)].map((m) => {
    const name = m[1] ?? "";
    return { name, css: readFileSync(join(STYLES_DIR, name), "utf8") };
  });
}

/** Every stylesheet file joined in cascade order. */
export function allCss(): string {
  return styleFiles()
    .map((f) => f.css)
    .join("\n");
}

/** One stylesheet file. */
export function styleFile(name: string): string {
  return readFileSync(join(STYLES_DIR, name), "utf8");
}

/** The body of each block opened by `prelude` (an at-rule or a selector), outer braces removed. */
export function blocks(css: string, prelude: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`${prelude} {`, from);
    if (at < 0) return out;
    const open = at + prelude.length + 1;
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i;
  }
}

/** The custom properties declared directly in a block (not in nested blocks). */
export function declarations(block: string): Map<string, string> {
  const flat = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "");
  const map = new Map<string, string>();
  for (const m of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1] ?? "", (m[2] ?? "").replace(/\s+/g, " ").trim());
  return map;
}

/** The light tokens: the first `:root` block of tokens.css. */
export function lightTokens(): Map<string, string> {
  return declarations(blocks(styleFile("tokens.css"), ":root")[0] ?? "");
}

/** A token's value with every `var(--x)` replaced by the value it points at, looked up in `themes` in order. */
export function resolveToken(name: string, ...themes: Map<string, string>[]): string {
  const value = themes.map((t) => t.get(name)).find((v) => v !== undefined);
  if (value === undefined) throw new Error(`token ${name} is not defined`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, inner: string) => resolveToken(inner, ...themes));
}
