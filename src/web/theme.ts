/**
 * The colour theme (WEB-16): the system setting, or light or dark by choice. A choice is kept in localStorage and set as
 * `data-theme` on <html>, which tokens.css reads. Imported first by main.tsx, so the page is drawn in the right theme
 * from the start; a module rather than an inline script, which the CSP forbids.
 */
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "cabin-kit.theme";

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/** Apply a choice and keep it for the next visit; "system" forgets the choice. */
export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage refused (private mode): the choice still applies to this page
  }
  applyTheme(choice);
}

/** Call `listener` whenever the theme in effect may have changed: a choice here, or the system setting. */
export function onThemeChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  media?.addEventListener("change", listener);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", listener);
  };
}

/** The statuses (and the blocked badge) whose 3D colour follows the theme, and the token each is read from. */
const SCENE_STATUS_TOKENS = {
  mustFix: "--scene-status-mustfix",
  deferred: "--scene-status-deferred",
  carried: "--scene-status-carried",
  noted: "--scene-status-noted",
  blocked: "--scene-status-blocked",
} as const;
export type SceneStatusKey = keyof typeof SCENE_STATUS_TOKENS;

export interface PageSceneTheme {
  background: string;
  outline: string;
  wash: string;
  /** the colours that could be read; one missing keeps the scene's own (its light fallback) */
  status: Partial<Record<SceneStatusKey, string>>;
}

/**
 * The 3D view's colours as the page now has them (`--scene-bg`, `--scene-outline`, `--scene-wash` and the
 * `--scene-status-*` tokens), or null without the stylesheet.
 */
export function sceneThemeTokens(): PageSceneTheme | null {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const background = read("--scene-bg");
  const outline = read("--scene-outline");
  const wash = read("--scene-wash");
  if (!background || !outline || !wash) return null;
  const status: PageSceneTheme["status"] = {};
  for (const [key, token] of Object.entries(SCENE_STATUS_TOKENS) as [SceneStatusKey, string][]) {
    const value = read(token);
    if (value) status[key] = value;
  }
  return { background, outline, wash, status };
}

applyTheme(storedTheme());
