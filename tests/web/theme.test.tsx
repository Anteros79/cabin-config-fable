import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeControl } from "../../src/web/components/ThemeControl.tsx";
import { applyTheme, chooseTheme, onThemeChange, sceneThemeTokens, storedTheme, THEME_KEY } from "../../src/web/theme.ts";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme choice", () => {
  test("is kept under cabin-kit.theme and set on <html> as data-theme", () => {
    expect(THEME_KEY).toBe("cabin-kit.theme");
    chooseTheme("dark");
    expect(localStorage.getItem("cabin-kit.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storedTheme()).toBe("dark");
    chooseTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("system forgets the choice and removes data-theme, so the system setting applies", () => {
    chooseTheme("dark");
    chooseTheme("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe("system");
  });

  test("an unknown stored value means system", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(storedTheme()).toBe("system");
  });

  test("storage that refuses still applies the choice to the page", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      chooseTheme("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      setItem.mockRestore();
    }
  });

  test("a change of data-theme is reported to listeners until they stop listening", async () => {
    const listener = vi.fn();
    const stop = onThemeChange(listener);
    applyTheme("dark");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    stop();
    applyTheme("light");
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a change of the system colour scheme is reported to listeners until they stop listening", () => {
    const handlers = new Set<() => void>();
    const query = {
      matches: false,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn((_: string, h: () => void) => handlers.add(h)),
      removeEventListener: vi.fn((_: string, h: () => void) => handlers.delete(h)),
    };
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const listener = vi.fn();
      const stop = onThemeChange(listener);
      expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
      for (const h of handlers) h();
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
      expect(handlers.size).toBe(0);
      expect(query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the 3D view's colours from the page", () => {
  const SCENE = { "--scene-bg": "#1b2030", "--scene-outline": "#e3e7f0", "--scene-wash": "#d5dae6" };
  const STATUS = {
    "--scene-status-mustfix": "#ff6bb0",
    "--scene-status-deferred": "#ff9d45",
    "--scene-status-carried": "#b090e0",
    "--scene-status-noted": "#90d0f0",
    "--scene-status-blocked": "#7a84a0",
  };
  const set = (tokens: Record<string, string>) => {
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
  };
  afterEach(() => {
    for (const name of [...Object.keys(SCENE), ...Object.keys(STATUS)]) document.documentElement.style.removeProperty(name);
  });

  test("no stylesheet: null, so the scene keeps its own light values", () => {
    expect(sceneThemeTokens()).toBeNull();
  });

  test("the problem status and blocked colours come with the background, outline and wash (VAC-15)", () => {
    set({ ...SCENE, ...STATUS });
    expect(sceneThemeTokens()).toEqual({
      background: "#1b2030",
      outline: "#e3e7f0",
      wash: "#d5dae6",
      status: { mustFix: "#ff6bb0", deferred: "#ff9d45", carried: "#b090e0", noted: "#90d0f0", blocked: "#7a84a0" },
    });
  });

  test("a status token that cannot be read is left out, so the scene keeps that one colour", () => {
    set({ ...SCENE, "--scene-status-deferred": "#ff9d45" });
    expect(sceneThemeTokens()?.status).toEqual({ deferred: "#ff9d45" });
  });
});

describe("the header's theme control", () => {
  test("is a group of three toggle buttons, System, Light and Dark, with the stored choice pressed", () => {
    localStorage.setItem(THEME_KEY, "light");
    render(<ThemeControl />);
    const group = screen.getByRole("group", { name: "Colour theme" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });

  test("pressing a button applies and keeps that theme", async () => {
    render(<ThemeControl />);
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
