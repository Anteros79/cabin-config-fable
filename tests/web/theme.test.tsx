import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeControl } from "../../src/web/components/ThemeControl.tsx";
import { applyTheme, chooseTheme, onThemeChange, storedTheme, THEME_KEY } from "../../src/web/theme.ts";

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
