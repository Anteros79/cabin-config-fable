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

/** The 3D view's colours as the page now has them (`--scene-bg`, `--scene-outline`, `--scene-wash`), or null without the stylesheet. */
export function sceneThemeTokens(): { background: string; outline: string; wash: string } | null {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--scene-bg").trim();
  const outline = style.getPropertyValue("--scene-outline").trim();
  const wash = style.getPropertyValue("--scene-wash").trim();
  return background && outline && wash ? { background, outline, wash } : null;
}

applyTheme(storedTheme());
