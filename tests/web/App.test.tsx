import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import { App } from "../../src/web/App.tsx";
import { fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, stubFetch } from "./fetchStub.ts";

vi.mock("../../src/web/components/Viewer.tsx", () => ({ Viewer: () => <p>3D view</p> }));

const release = fixtureRelease();
const snap = snapshotFor(release, "N100TL", "2026-11-12");
const ID = "3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b";
const draft = { ...visitWith(snap, []), id: ID, number: 7 };
const health = {
  status: "ok",
  authorityNotice: "",
  reference: { available: true, releaseId: release.id },
  visits: { available: true },
};

/** Answers the app's own background calls; `more` handles the rest. */
function stubApp(more: (method: string, url: string) => Answer | undefined = () => undefined) {
  return stubFetch((method, url): Answer => {
    const extra = more(method, url);
    if (extra) return extra;
    if (url.startsWith("/api/health")) return { body: health };
    if (url.startsWith("/api/layouts")) return { body: { layouts: [], layoutCategories: [], visualProfiles: [] } };
    if (url.startsWith("/api/tails")) return { body: { tails: [] } };
    throw new Error(`unexpected ${method} ${url}`);
  });
}
const go = (hash: string) => {
  window.location.hash = hash;
};
const hashChanged = async (hash: string) => {
  go(hash);
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  go("");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App routing", () => {
  it("Skip to content focuses main and keeps the route", async () => {
    go(`#/visit/${ID}`);
    stubApp((_m, url) => (url === `/api/visits/${ID}` ? { body: { visit: draft } } : undefined));
    render(<App />);
    await screen.findByRole("heading", { name: /Visit #7/ });
    const skip = screen.getByRole("button", { name: "Skip to content" });
    fireEvent.click(skip);
    expect(window.location.hash).toBe(`#/visit/${ID}`);
    expect(document.activeElement).toBe(document.getElementById("main"));
    // Even if the browser did change the hash to the anchor, the route stays.
    await hashChanged("#main");
    expect(screen.getByRole("heading", { name: /Visit #7/ })).toBeInTheDocument();
  });

  it("a malformed hash shows the not-found panel, not a blank page", async () => {
    go("#/visit/%E0%A4%A");
    stubApp();
    render(<App />);
    expect(await screen.findByText("This page does not exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /appearance check/ })).toHaveAttribute("href", "#/");
    expect(document.title).toBe("Page not found · Cabin Kit");
  });

  it("the title names the visit", async () => {
    go(`#/visit/${ID}`);
    stubApp((_m, url) => (url === `/api/visits/${ID}` ? { body: { visit: draft } } : undefined));
    render(<App />);
    await waitFor(() => expect(document.title).toBe(`Visit #7 · ${draft.tail} · Cabin Kit`));
  });

  it("Back after opening the preparation list restores the lookup", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    const sent = stubApp((_m, url) => (url.startsWith("/api/lookup") ? { body: result } : undefined));
    go("#/check?tail=N100TL&date=2026-11-12");
    render(<App />);
    await screen.findByText(/Configuration resolved/);
    expect(screen.getByLabelText("Tail number")).toHaveValue("N100TL");
    expect(screen.getByLabelText("Appearance-check date")).toHaveValue("2026-11-12");
    await hashChanged("#/prep?tail=N100TL&date=2026-11-12");
    await waitFor(() => expect(screen.queryByText(/Configuration resolved/)).toBeNull());
    await hashChanged("#/check?tail=N100TL&date=2026-11-12");
    await screen.findByText(/Configuration resolved/);
    expect(sent.filter((s) => s.url.startsWith("/api/lookup"))).toHaveLength(2);
  });

  it("submitting the lookup writes it into the URL", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    stubApp((_m, url) => (url.startsWith("/api/lookup") ? { body: result } : undefined));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Tail number"), { target: { value: "N100TL" } });
    fireEvent.change(screen.getByLabelText("Appearance-check date"), { target: { value: "2026-11-12" } });
    fireEvent.change(screen.getByLabelText("Technician (optional)"), { target: { value: "A. Tech" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    expect(window.location.hash).toBe("#/check?tail=N100TL&date=2026-11-12");
    expect(sessionStorage.getItem("cabin-kit.technician")).toBe("A. Tech");
    expect(window.location.hash).not.toContain("Tech");
  });

  it("the resume link disappears when the stored draft is completed elsewhere", async () => {
    localStorage.setItem("cabin-kit:last-visit", ID);
    const completed = { ...draft, status: "COMPLETED" as const };
    stubApp((_m, url) => (url === `/api/visits/${ID}` ? { body: { visit: completed } } : undefined));
    render(<App />);
    expect(screen.getByRole("link", { name: "Resume the last draft visit" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Resume the last draft visit" })).toBeNull());
    expect(localStorage.getItem("cabin-kit:last-visit")).toBeNull();
  });

  it("the resume link disappears when the stored draft no longer exists", async () => {
    localStorage.setItem("cabin-kit:last-visit", ID);
    stubApp((_m, url) =>
      url === `/api/visits/${ID}` ? { status: 404, body: { error: { code: "NOT_FOUND", message: "No such visit.", details: null } } } : undefined,
    );
    render(<App />);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Resume the last draft visit" })).toBeNull());
    expect(localStorage.getItem("cabin-kit:last-visit")).toBeNull();
  });

  it("the resume link stays for a draft that is still open", async () => {
    localStorage.setItem("cabin-kit:last-visit", ID);
    const sent = stubApp((_m, url) => (url === `/api/visits/${ID}` ? { body: { visit: draft } } : undefined));
    render(<App />);
    await waitFor(() => expect(sent.some((s) => s.url === `/api/visits/${ID}`)).toBe(true));
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Resume the last draft visit" })).toBeInTheDocument();
  });

  it("the health poll pauses while the page is hidden and checks at once when it is shown again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let visibility: DocumentVisibilityState = "visible";
    const restore = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const show = async (next: DocumentVisibilityState) => {
      visibility = next;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    };
    try {
      const sent = stubApp();
      const healthChecks = () => sent.filter((s) => s.url.startsWith("/api/health")).length;
      render(<App />);
      await waitFor(() => expect(healthChecks()).toBe(1));
      await act(async () => vi.advanceTimersByTime(15000));
      expect(healthChecks()).toBe(2);
      await show("hidden");
      await act(async () => vi.advanceTimersByTime(60000));
      expect(healthChecks()).toBe(2);
      await show("visible");
      expect(healthChecks()).toBe(3);
      await act(async () => vi.advanceTimersByTime(15000));
      expect(healthChecks()).toBe(4);
    } finally {
      vi.useRealTimers();
      if (restore) Object.defineProperty(document, "visibilityState", restore);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("an out-of-range visits page is replaced in history, so Back does not return to it", async () => {
    stubApp((_m, url) => (url.startsWith("/api/visits?") ? { body: { items: [], total: 60 } } : undefined));
    go("#/visits?page=9999");
    const entries = window.history.length;
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#/visits?page=3"));
    expect(window.history.length).toBe(entries);
    await screen.findByText(/page 3 of 3/);
  });

  it("VisitsView filter and page come from and go to the URL", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: ID,
      number: i + 1,
      tail: "N100TL",
      checkDate: "2026-11-12",
      status: "DRAFT",
      variantId: "V1",
      recordCount: 0,
      technician: "",
      updatedAt: "2026-11-12T10:00:00.000Z",
    }));
    const sent = stubApp((_m, url) => (url.startsWith("/api/visits?") ? { body: { items, total: 60 } } : undefined));
    go("#/visits?status=DRAFT&q=N100&page=2");
    render(<App />);
    await screen.findByText(/page 2 of 3/);
    const list = sent.find((s) => s.url.startsWith("/api/visits?"));
    expect(list?.url).toContain("status=DRAFT");
    expect(list?.url).toContain("q=N100");
    expect(list?.url).toContain("offset=25");
    expect(screen.getByLabelText("Status")).toHaveValue("DRAFT");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(window.location.hash).toBe("#/visits?status=DRAFT&q=N100&page=3");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "COMPLETED" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(window.location.hash).toBe("#/visits?status=COMPLETED&q=N100");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Saved visits" })).toHaveAttribute("aria-current", "page");
  });
});
