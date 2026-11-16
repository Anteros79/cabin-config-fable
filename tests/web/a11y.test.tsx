import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/App.tsx";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { CUSHION_3A, fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { allCss, blocks, lightTokens, styleFiles } from "./css.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

// jsdom has no WebGL: the scene is a stand-in whose every method does nothing (or fails, when a test asks). The 3D component,
// its canvas and the tabs are real.
const scenes = vi.hoisted(() => ({ failLayout: false, disposed: 0, calls: [] as string[] }));
vi.mock("../../src/web/scene/CabinScene.ts", () => ({
  CabinScene: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in that answers every method call
      return new Proxy(
        {},
        {
          get: (_target, name) => () => {
            scenes.calls.push(String(name));
            if (name === "setLayout" && scenes.failLayout) throw new Error("The test scene could not be built.");
            if (name === "dispose") scenes.disposed += 1;
          },
        },
      );
    }
  },
}));

const release = fixtureRelease();
const snap = snapshotFor(release, "N100TL", "2026-11-12");
const visit = visitWith(snap, [CUSHION_3A]);
const health = { status: "ok", authorityNotice: "", reference: { available: true, releaseId: release.id }, visits: { available: true } };

function stubApp(more: (method: string, url: string) => Answer | undefined = () => undefined) {
  return stubFetch((method, url): Answer => {
    const extra = more(method, url);
    if (extra) return extra;
    if (url.startsWith("/api/health")) return { body: health };
    if (url.startsWith("/api/layouts")) return { body: { layouts: [], layoutCategories: [], visualProfiles: [] } };
    if (url.startsWith("/api/tails")) return { body: { tails: [] } };
    if (url.startsWith("/api/visits?")) return { body: { items: [], total: 0 } };
    throw new Error(`unexpected ${method} ${url}`);
  });
}

async function openVisit() {
  stubFetch((): Answer => ({ body: { visit } }));
  render(<CheckView visitId={visit.id} navigate={vi.fn()} visualProfiles={[]} />);
  await screen.findByRole("heading", { name: /^Visit #/ });
  await act(async () => {});
}

beforeEach(() => {
  scenes.failLayout = false;
  scenes.disposed = 0;
  scenes.calls = [];
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("focus and announcements", () => {
  it("route change moves focus to the view heading and announces it", async () => {
    window.location.hash = "#/visits";
    stubApp();
    render(<App />);
    await screen.findByRole("heading", { name: "Saved visits" });
    // Not on first load: focus stays where the browser put it, and nothing is announced.
    expect(document.activeElement).toBe(document.body);
    const live = document.querySelector("p[aria-live=polite].sr-only");
    expect(live).toHaveTextContent(/^$/);

    window.location.hash = "#/layouts";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    // Layouts load first; focus goes to the heading once it is shown.
    const heading = await screen.findByRole("heading", { level: 2, name: "Layouts" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(live).toHaveTextContent("Layouts · Cabin Kit");
  });

  it("the completion dialog closes on Escape and returns focus to its opener", async () => {
    await openVisit();
    const opener = screen.getByRole("button", { name: "Complete visit…" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Complete and lock this visit?" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Escape on a modal dialog fires `cancel`; the dialog handles it instead of letting the browser close it unannounced.
    const escapeKey = new Event("cancel", { cancelable: true });
    fireEvent(dialog, escapeKey);
    expect(escapeKey.defaultPrevented).toBe(true);
    expect(dialog).not.toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("a close the browser makes itself closes the dialog; a late close event after reopening does not", async () => {
    await openVisit();
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    let dialog = screen.getByRole("dialog", { name: "Complete and lock this visit?" });
    // A late `close` from an earlier close arrives while the dialog is open: it stays open.
    fireEvent(dialog, new Event("close"));
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Confirm completion" })).toBeInTheDocument();
    // The browser closed it (a second Escape): the dialog follows.
    dialog.removeAttribute("open");
    fireEvent(dialog, new Event("close"));
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    dialog = screen.getByRole("dialog", { name: "Complete and lock this visit?" });
    expect(dialog).toHaveAttribute("open");
  });

  it("a view that loads after the person moved focus does not take focus back", async () => {
    window.location.hash = "#/visits";
    const layouts = deferred<{ body: unknown }>();
    let held = false;
    stubApp((_m, url) => {
      // the first layouts read is App's own; the view's read is held until the person has moved on
      if (!url.startsWith("/api/layouts")) return undefined;
      if (held) return layouts.promise;
      held = true;
      return undefined;
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Saved visits" });
    window.location.hash = "#/layouts";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const nav = screen.getByRole("link", { name: "Reference" });
    nav.focus();
    await act(async () => {
      layouts.resolve({ body: { layouts: [], layoutCategories: [], visualProfiles: [] } });
    });
    await screen.findByRole("heading", { level: 2, name: "Layouts" });
    expect(nav).toHaveFocus();
  });

  it("Confirm completion keeps focus while it waits for the completion answer, and a second press sends nothing", async () => {
    const answer = deferred<{ body: unknown }>();
    const sent = stubFetch((method): Answer => (method === "GET" ? { body: { visit } } : answer.promise));
    render(<CheckView visitId={visit.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    const confirm = screen.getByRole("button", { name: "Confirm completion" });
    const completions = () => sent.filter((s) => s.url.endsWith("/complete"));
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(completions()).toHaveLength(1));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).not.toBeDisabled();
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    await act(async () => {});
    expect(completions()).toHaveLength(1);
    await act(async () => {
      answer.resolve({ body: { visit: { ...visit, status: "COMPLETED" }, replayed: false } });
    });
  });

  it("Discard, then Cancel in the completion dialog, returns focus to Complete visit", async () => {
    await openVisit();
    fireEvent.click(screen.getByRole("tab", { name: "Map and list" }));
    fireEvent.click(screen.getByRole("button", { name: /^Seat 3A/ }));
    const card = await screen.findByRole("region", { name: /^Seat cushion cover/ });
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
    const opener = screen.getByRole("button", { name: "Complete visit…" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
  });

  it("after a 3D failure the scene is disposed and the map still selects", async () => {
    scenes.failLayout = true;
    await openVisit();
    await screen.findByText(/3D view unavailable/);
    expect(scenes.disposed).toBe(1);
    expect(window.__cabinKit?.scene ?? null).toBeNull();
    expect(screen.queryByRole("application")).toBeNull();
    expect(screen.getByRole("tab", { name: "3D cutaway" })).toBeDisabled();
    expect(document.getElementById("panel-3d")).not.toBeNull();
    const before = scenes.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Seat 3A/ }));
    expect(await screen.findByRole("heading", { name: "Seat 3A" })).toBeInTheDocument();
    expect(scenes.calls.length).toBe(before);
  });

  it("Cancel in the completion dialog returns focus to Complete visit", async () => {
    await openVisit();
    const opener = screen.getByRole("button", { name: "Complete visit…" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("tabs: arrow keys move and activate; aria-controls resolves to an element", async () => {
    await openVisit();
    const tablist = screen.getByRole("tablist", { name: "Cabin view" });
    const [three, map] = within(tablist).getAllByRole("tab") as [HTMLElement, HTMLElement];
    for (const tab of [three, map]) {
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute("role", "tabpanel");
    }
    expect(three).toHaveAttribute("tabindex", "0");
    expect(map).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("panel-map")).not.toBeVisible();

    three.focus();
    fireEvent.keyDown(three, { key: "ArrowRight" });
    expect(map).toHaveFocus();
    expect(map).toHaveAttribute("aria-selected", "true");
    expect(map).toHaveAttribute("tabindex", "0");
    expect(three).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("panel-map")).toBeVisible();
    expect(document.getElementById("panel-3d")).not.toBeVisible();

    fireEvent.keyDown(map, { key: "ArrowRight" });
    expect(three).toHaveFocus();
    expect(three).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(three, { key: "End" });
    expect(map).toHaveFocus();
    fireEvent.keyDown(map, { key: "Home" });
    expect(three).toHaveFocus();
    fireEvent.keyDown(three, { key: "ArrowLeft" });
    expect(map).toHaveFocus();
  });

  it("Go to parts focuses the inspector heading", async () => {
    await openVisit();
    fireEvent.click(screen.getByRole("tab", { name: "Map and list" }));
    fireEvent.click(screen.getByRole("button", { name: /^Seat 3A/ }));
    const heading = await screen.findByRole("heading", { name: "Seat 3A" });
    fireEvent.click(screen.getByRole("button", { name: "Go to parts for Seat 3A" }));
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute("id", "inspector-heading");
  });

  it("Enter on the canvas goes to the parts for the selected location", async () => {
    await openVisit();
    fireEvent.click(screen.getByRole("tab", { name: "Map and list" }));
    fireEvent.click(screen.getByRole("button", { name: /^Seat 3A/ }));
    const heading = await screen.findByRole("heading", { name: "Seat 3A" });
    fireEvent.click(screen.getByRole("tab", { name: "3D cutaway" }));
    const canvas = screen.getByRole("application");
    await waitFor(() => expect(canvas).toHaveAttribute("data-ready", "true"));
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(heading).toHaveFocus();
  });

  it("the canvas exposes role and description", async () => {
    await openVisit();
    const canvas = screen.getByRole("application");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveAttribute("aria-roledescription", "3D cabin view");
    expect(canvas).toHaveAttribute("tabindex", "0");
    const keys = document.getElementById(canvas.getAttribute("aria-describedby") ?? "");
    expect(keys?.tagName).toBe("UL");
    expect(keys).toHaveClass("sr-only");
    expect(keys).toHaveTextContent(/Arrow keys orbit/);
    expect(keys).toHaveTextContent(/Map and list tab/);
    expect(canvas).toHaveAccessibleDescription(/Arrow keys orbit the camera/);
  });
});

describe("styles", () => {
  const css = allCss();
  /** The declarations of every rule whose selector list is exactly `selector`. */
  const rulesFor = (source: string, selector: string): string[] => {
    const out: string[] = [];
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of source.matchAll(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))) out.push(m[2] ?? "");
    return out;
  };
  // each file keeps the forced-colours rules for its own parts
  const forced = blocks(css, "@media (forced-colors: active)").join("\n");
  const outsideForced = styleFiles()
    .map((f) => {
      const at = f.css.indexOf("@media (forced-colors: active)");
      return at < 0 ? f.css : f.css.slice(0, at);
    })
    .join("\n");

  it("styles: header focus ring uses the header focus token; selection does not use outline", () => {
    expect(rulesFor(css, ".app-header :focus-visible").join("")).toMatch(/outline-color:\s*var\(--header-focus\);/);
    const selected = rulesFor(outsideForced, "button.loc.selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toMatch(/outline/);
    // an ink ring carries the 3:1 contrast; the select band inside it matches the 3D selection colour
    expect(selected[0]).toMatch(/box-shadow:\s*var\(--shadow-select\);/);
    expect(lightTokens().get("--shadow-select")).toMatch(/^inset 0 0 0 2px var\(--text-strong\), inset 0 0 0 5px var\(--select\)$/);
    expect(rulesFor(css, "button.loc.selected::before").join("")).toMatch(/bottom:\s*5px;/);
    expect(rulesFor(css, ".canvas-wrap canvas:focus-visible").join("")).toMatch(/outline-offset:\s*-3px;/);
  });

  it("styles: the user's font size is respected and table headers are not sticky", () => {
    expect(css).not.toMatch(/font-size:\s*15px/);
    expect(rulesFor(css, "html").join("")).toMatch(/font-size:\s*var\(--font-size-root\);/);
    expect(lightTokens().get("--font-size-root")).toBe("93.75%");
    expect(css).not.toMatch(/position:\s*sticky;\s*top:\s*0;/);
    expect(css).not.toMatch(/--sel:/);
  });

  it("styles: forced colours mark the current tab, nav item and selected seat, and keep swatches", () => {
    expect(forced).not.toBe("");
    for (const selector of ['.tabs [role="tab"][aria-selected="true"]', '.app-header nav a[aria-current="page"]']) {
      expect(rulesFor(forced, selector).join(""), selector).toMatch(/border-bottom: 3px solid Highlight;/);
    }
    for (const selector of [".swatch", "button.loc::before"]) {
      expect(rulesFor(forced, selector).join(""), selector).toMatch(/forced-color-adjust: none;\s*border: 1px solid CanvasText;/);
    }
    expect(rulesFor(forced, "button.loc.selected").join("")).toMatch(/outline: 3px solid Highlight;/);
  });
});
