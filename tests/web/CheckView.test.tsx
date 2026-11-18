import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Observation, Visit, VisitRecord, VisitState } from "../../src/domain/types.ts";
import { ToastProvider } from "../../src/web/components/Toasts.tsx";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { at, CUSHION_3A, fixtureRelease, KIT_PRIMARY, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

// The 3D view is not under test here; a stand-in lets a test select a location the way a click in the cabin would.
vi.mock("../../src/web/components/Viewer.tsx", () => ({
  Viewer: ({ onSelect }: { onSelect(locationId: string, componentId: string | null): void }) => (
    <button type="button" onClick={() => onSelect("SEAT:3A", "CUSHION")}>
      Pick seat 3A
    </button>
  ),
}));

// The scene chunk is not loaded in jsdom; the stand-in records that a visit route asked for it.
const sceneModule = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../../src/web/components/sceneModule.ts", () => ({
  loadSceneModule: () => {
    sceneModule.loads += 1;
    return new Promise(() => {});
  },
}));

const release = fixtureRelease();
const snap = snapshotFor(release, "N100TL", "2026-11-12");
const base = visitWith(snap, [CUSHION_3A, KIT_PRIMARY]);
const [cushion, kit] = base.records as [VisitRecord, VisitRecord];
const removeLabel = (r: VisitRecord) => `Remove ${r.locationLabel} ${r.componentName}`;
const stateOf = (visit: Visit, patch: Partial<VisitState>): VisitState => {
  const { snapshot: _snapshot, ...rest } = visit;
  return { ...rest, ...patch };
};
const workCount = (scope: HTMLElement) => within(scope).getByRole("heading", { name: /Recorded work/ }).textContent;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CheckView scene chunk", () => {
  it("a visit route starts loading the 3D scene before the visit answers; the check page does not (Task 6.5)", async () => {
    sceneModule.loads = 0;
    const answer = deferred<{ body: unknown }>();
    stubFetch((): Answer => answer.promise);
    const view = render(<CheckView visitId={null} navigate={vi.fn()} visualProfiles={[]} />);
    expect(sceneModule.loads, "no visit, no scene").toBe(0);
    view.unmount();
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    await waitFor(() => expect(sceneModule.loads).toBe(1));
  });
});

describe("CheckView writes", () => {
  // N2: a busy store refusing the second attempt says nothing about the first, so the third still sends the first key.
  it("Start visit after a lost response and then a busy store still sends one key", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    let posts = 0;
    const sent = stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (url.startsWith("/api/lookup")) return { body: result };
      if (method === "POST" && url === "/api/visits") {
        posts += 1;
        if (posts === 1) return "reject";
        if (posts === 2)
          return { status: 503, body: { error: { code: "STORE_BUSY", message: "The visit store is busy. Nothing was saved; retry.", details: null } } };
        return { status: 201, body: { visit: base } };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const navigate = vi.fn();
    render(<CheckView visitId={null} navigate={navigate} visualProfiles={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    const start = await screen.findByRole("button", { name: "Start visit (saves a draft)" });
    fireEvent.click(start);
    await screen.findByText(/may or may not have been saved/);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start visit (saves a draft)" }));
    await screen.findByText(/first attempt may already be stored/);
    expect(screen.queryByText(/^Not saved/), "the refusal answers only for the retry").toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start visit (saves a draft)" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/visit/${base.id}`));
    const creates = sent.filter((s) => s.method === "POST");
    expect(creates).toHaveLength(3);
    expect(creates[0]?.body?.idempotencyKey).toEqual(expect.any(String));
    expect(creates[1]?.body?.idempotencyKey).toBe(creates[0]?.body?.idempotencyKey);
    expect(creates[2]?.body?.idempotencyKey).toBe(creates[0]?.body?.idempotencyKey);
  });

  it("an empty tail is looked up and reported as invalid input, and the route lookup comes back after it", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    const invalid = { ...lookup(release, "", "2026-11-12"), state: "INVALID_INPUT" };
    const sent = stubFetch((_method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      return { body: url.includes("tail=N100TL") ? result : invalid };
    });
    const navigate = vi.fn();
    const { container } = render(<CheckView visitId={null} tail="N100TL" date="2026-11-12" navigate={navigate} visualProfiles={[]} />);
    await waitFor(() => expect(container.querySelector(".status-card")?.getAttribute("data-state")).toBe(result.state));
    fireEvent.change(screen.getByLabelText("Tail number"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    await waitFor(() => expect(container.querySelector(".status-card")?.getAttribute("data-state")).toBe("INVALID_INPUT"));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Tail number"), { target: { value: "N100TL" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    await waitFor(() => expect(container.querySelector(".status-card")?.getAttribute("data-state")).toBe(result.state));
    expect(sent.filter((s) => s.url.startsWith("/api/lookup")).map((s) => s.url.includes("tail=N100TL"))).toEqual([true, false, true]);
  });

  // WebKit lets a datalist suggestion take the first Enter, so the tail input submits its own form on Enter (I1).
  it("Enter in the tail input looks it up exactly once", async () => {
    stubFetch((_method, url): Answer => (url.startsWith("/api/tails") ? { body: { tails: [] } } : { body: lookup(release, "N100TL", "2026-11-12") }));
    const navigate = vi.fn();
    render(<CheckView visitId={null} navigate={navigate} visualProfiles={[]} />);
    const input = screen.getByLabelText("Tail number");
    fireEvent.change(input, { target: { value: "N100TL" } });
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true }), "an input method's Enter is left alone").toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: "Enter" }), "the browser's own Enter handling is cancelled").toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[0]).toMatch(/^#\/check\?tail=N100TL/);
  });

  it("a late lookup answer for a previous tail never shows under the next one", async () => {
    const first = lookup(release, "N100TL", "2026-11-12");
    const second = lookup(release, "N200TL", "2026-06-30");
    const slow = deferred<{ body: unknown }>();
    stubFetch((_method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      return url.includes("tail=N100TL") ? slow.promise : { body: second };
    });
    const view = render(<CheckView visitId={null} tail="N100TL" date="2026-11-12" navigate={vi.fn()} visualProfiles={[]} />);
    view.rerender(<CheckView visitId={null} tail="N200TL" date="2026-06-30" navigate={vi.fn()} visualProfiles={[]} />);
    const prepLink = () => screen.getByRole("link", { name: "Preparation parts list" }).getAttribute("href");
    await waitFor(() => expect(prepLink()).toContain("tail=N200TL"));
    slow.resolve({ body: first });
    await act(async () => {});
    expect(prepLink()).toContain("tail=N200TL");
    expect(screen.getAllByRole("link", { name: "Preparation parts list" })).toHaveLength(1);
  });

  it("a technician name the server refuses (INVALID_TECHNICIAN) is shown as a plain alert, with no retry and no navigation", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    const message =
      "The technician name contains a hidden or control character, such as a tab, a line break or an invisible formatting mark. Remove it and try again.";
    const sent = stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (url.startsWith("/api/lookup")) return { body: result };
      if (method === "POST") return { status: 422, body: { error: { code: "INVALID_TECHNICIAN", message, details: null } } };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const navigate = vi.fn();
    render(<CheckView visitId={null} navigate={navigate} visualProfiles={[]} />);
    fireEvent.change(screen.getByLabelText("Technician (optional)"), { target: { value: "Demo\ttech" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start visit (saves a draft)" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`Not saved: ${message}`);
    expect(within(alert).queryByRole("button", { name: "Retry safely" })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.method === "POST").map((s) => s.body?.technician)).toEqual(["Demo\ttech"]);
  });

  it("Start visit is disabled while the visit is being created", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    const answer = deferred<{ status: number; body: unknown }>();
    const sent = stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (url.startsWith("/api/lookup")) return { body: result };
      if (method === "POST") return answer.promise;
      throw new Error(`unexpected ${method} ${url}`);
    });
    const navigate = vi.fn();
    render(<CheckView visitId={null} navigate={navigate} visualProfiles={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Look up configuration" }));
    const start = await screen.findByRole("button", { name: "Start visit (saves a draft)" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(start).toBeDisabled();
    answer.resolve({ status: 201, body: { visit: base } });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("an older response does not overwrite a newer visit version", async () => {
    const loaded = { ...base, version: 5 };
    stubFetch((method, _url, body): Answer => {
      if (method === "GET") return { body: { visit: loaded, referenceNow: { releaseId: release.id, changedSinceVisit: false } } };
      // The first answer is older than the copy on screen (another tab wrote since); the second is newer.
      if (body?.componentId === cushion.componentId) return { body: { visit: stateOf(base, { version: 4, records: [] }), replayed: false } };
      return { body: { visit: stateOf(base, { version: 6, records: [cushion] }), replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    const removeCushion = await screen.findByRole("button", { name: removeLabel(cushion) });
    expect(workCount(document.body)).toContain("(2)");
    fireEvent.click(removeCushion);
    await waitFor(() => expect(screen.getByRole("button", { name: removeLabel(cushion) })).toBeEnabled());
    expect(workCount(document.body)).toContain("(2)");
    fireEvent.click(screen.getByRole("button", { name: removeLabel(kit) }));
    await waitFor(() => expect(workCount(document.body)).toContain("(1)"));
    expect(screen.queryByRole("button", { name: removeLabel(kit) })).toBeNull();
  });

  it("navigating from visit A to visit B never shows A under B's URL, and writes go to B", async () => {
    const other: Visit = { ...base, id: "visit-2", number: 2, records: [cushion] };
    const slowA = deferred<{ body: unknown }>();
    const sent = stubFetch((method, url): Answer => {
      if (method === "GET" && url === `/api/visits/${base.id}`) return slowA.promise;
      if (method === "GET" && url === `/api/visits/${other.id}`) return { body: { visit: other } };
      return { body: { visit: stateOf(other, { version: other.version + 1, records: [] }), replayed: false } };
    });
    const view = render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    view.rerender(<CheckView visitId={other.id} navigate={vi.fn()} visualProfiles={[]} />);
    await screen.findByRole("heading", { name: /^Visit #2/ });
    slowA.resolve({ body: { visit: base } });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: /^Visit #2/ })).toBeInTheDocument();
    expect(workCount(document.body)).toContain("(1)");
    fireEvent.click(screen.getByRole("button", { name: removeLabel(cushion) }));
    await waitFor(() => expect(workCount(document.body)).toContain("(0)"));
    const writes = sent.filter((s) => s.method === "POST");
    expect(writes.map((s) => s.url)).toEqual([`/api/visits/${other.id}/records/remove`]);
  });

  it("a conflict reload that answers after a newer write answer does not bring back the older version", async () => {
    const loaded = { ...base, version: 5 };
    const reload = deferred<{ body: unknown }>();
    let gets = 0;
    stubFetch((method, url, body): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") {
        gets += 1;
        return gets === 1 ? { body: { visit: loaded } } : reload.promise;
      }
      if (body?.componentId === cushion.componentId)
        return { status: 409, body: { error: { code: "STALE_RECORD", message: "The record changed since it was read.", details: null } } };
      return { body: { visit: stateOf(base, { version: 7, records: [cushion] }), replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    await waitFor(() => expect(gets).toBe(2));
    // The write answer (version 7) arrives while the conflict reload is still in flight.
    fireEvent.click(screen.getByRole("button", { name: removeLabel(kit) }));
    await waitFor(() => expect(workCount(document.body)).toContain("(1)"));
    reload.resolve({ body: { visit: { ...base, version: 6 } } });
    await act(async () => {});
    expect(workCount(document.body)).toContain("(1)");
    expect(screen.queryByRole("button", { name: removeLabel(kit) })).toBeNull();
  });

  it("Remove is disabled while its record is saving", async () => {
    const answer = deferred<{ body: unknown }>();
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: base } };
      return answer.promise;
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    const removeCushion = await screen.findByRole("button", { name: removeLabel(cushion) });
    fireEvent.click(removeCushion);
    expect(removeCushion).toBeDisabled();
    fireEvent.click(removeCushion);
    // A write on another record is not blocked by this one.
    expect(screen.getByRole("button", { name: removeLabel(kit) })).toBeEnabled();
    answer.resolve({ body: { visit: stateOf(base, { version: base.version + 1, records: [kit] }), replayed: false } });
    await waitFor(() => expect(screen.queryByRole("button", { name: removeLabel(cushion) })).toBeNull());
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("Confirm completion waits while a record save is in flight or has an unknown outcome", async () => {
    const answer = deferred<"reject">();
    const sent = stubFetch((method): Answer => (method === "GET" ? { body: { visit: base } } : answer.promise));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    const confirm = screen.getByRole("button", { name: "Confirm completion" });
    expect(confirm).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(screen.getByRole("button", { name: removeLabel(cushion) }));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    answer.resolve("reject");
    await screen.findByText(/A save has an unknown outcome/);
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    // pressing it anyway sends no completion
    const posts = () => sent.filter((s) => s.url.endsWith("/complete")).length;
    fireEvent.click(confirm);
    expect(posts()).toBe(0);
  });

  it("two tabs: the tab whose answer was lost retries with the same key and the other tab's save survives", async () => {
    // A tiny stand-in for the server: removals, versions and idempotency keys. A replay answers with the response
    // stored for the key, which may be older than the visit is now (the strictest behaviour a store may have).
    let server: VisitState = stateOf(base, {});
    const seen = new Map<string, { scope: string; response: VisitState }>();
    let dropNextAnswer = true;
    const sent = stubFetch((method, _url, body): Answer => {
      if (method === "GET") return { body: { visit: { ...server, snapshot: snap } } };
      const key = String(body?.idempotencyKey);
      const scope = `${body?.locationId}|${body?.componentId}|${body?.expectedRecordVersion}`;
      const prior = seen.get(key);
      if (prior) {
        if (prior.scope !== scope) return { status: 422, body: { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "reused", details: null } } };
        return { body: { visit: prior.response, replayed: true } };
      }
      server = {
        ...server,
        version: server.version + 1,
        records: server.records.filter((r) => !(r.locationId === body?.locationId && r.componentId === body?.componentId)),
      };
      seen.set(key, { scope, response: server });
      if (dropNextAnswer) {
        // Committed on the server, but the answer never reaches the tab.
        dropNextAnswer = false;
        return "reject";
      }
      return { body: { visit: server, replayed: false } };
    });
    const tabA = render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />).container;
    const tabB = render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />).container;
    await within(tabA).findByRole("button", { name: removeLabel(cushion) });
    await within(tabB).findByRole("button", { name: removeLabel(kit) });

    // Tab A removes the cushion through its inspector card; the connection drops after the commit.
    fireEvent.click(within(tabA).getByRole("button", { name: "Pick seat 3A" }));
    const cardA = await within(tabA).findByRole("region", { name: new RegExp(`^${cushion.componentName}`) });
    fireEvent.click(within(cardA).getByRole("button", { name: "Remove" }));
    await within(cardA).findByText(/may or may not have been saved/);

    // Tab B removes the carpet kit and gets its answer.
    fireEvent.click(within(tabB).getByRole("button", { name: removeLabel(kit) }));
    await waitFor(() => expect(within(tabB).queryByRole("button", { name: removeLabel(kit) })).toBeNull());
    const afterB = server.version;

    // Tab A retries safely: same key, so the server replays instead of applying the removal again. The replayed
    // answer predates tab B's removal, so tab A must not show it as current; it reloads and shows what is stored.
    fireEvent.click(within(cardA).getByRole("button", { name: "Retry safely" }));
    await within(tabA).findByText(/nothing was duplicated/);
    expect(server.version).toBe(afterB);
    expect(server.records).toEqual([]);
    await waitFor(() => expect(workCount(tabA)).toContain("(0)"));
    expect(workCount(tabB)).toContain("(0)");

    const removals = sent.filter((s) => s.method === "POST");
    expect(removals).toHaveLength(3);
    const [first, other, retry] = removals;
    expect(retry?.body?.idempotencyKey).toBe(first?.body?.idempotencyKey);
    expect(other?.body?.idempotencyKey).not.toBe(first?.body?.idempotencyKey);
  });
});

describe("CheckView undo after Remove", () => {
  const renderWithToasts = () =>
    render(
      <ToastProvider>
        <CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />
      </ToastProvider>,
    );
  const inputOf = (r: VisitRecord) => ({
    locationId: r.locationId,
    componentId: r.componentId,
    selection: r.selection,
    substituteId: r.substituteId,
    quantity: r.quantity,
    note: r.note,
  });

  it("Undo after Remove re-creates the record through the write queue, with its own key and version 0", async () => {
    const sent = stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") return { body: { visit: base } };
      if (url.endsWith("/records/remove")) return { body: { visit: stateOf(base, { version: base.version + 1, records: [kit] }), replayed: false } };
      return { body: { visit: stateOf(base, { version: base.version + 2, records: [kit, { ...cushion, version: 1 }] }), replayed: false } };
    });
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    await screen.findByText(`Removed ${cushion.locationLabel} / ${cushion.componentName}.`);
    await waitFor(() => expect(workCount(document.body)).toContain("(1)"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(workCount(document.body)).toContain("(2)"));
    const [removal, undo] = sent.filter((s) => s.method !== "GET");
    expect(undo?.method).toBe("PUT");
    expect(undo?.url).toBe(`/api/visits/${base.id}/records`);
    expect(undo?.body).toMatchObject({ record: inputOf(cushion), expectedRecordVersion: 0 });
    expect(undo?.body?.idempotencyKey).toEqual(expect.any(String));
    expect(undo?.body?.idempotencyKey).not.toBe(removal?.body?.idempotencyKey);
    await screen.findByText(`Restored ${cushion.locationLabel} / ${cushion.componentName}.`);
  });

  it("an undo that conflicts shows the normal conflict message and reloads", async () => {
    let gets = 0;
    stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") {
        gets += 1;
        return { body: { visit: base } };
      }
      if (url.endsWith("/records/remove")) return { body: { visit: stateOf(base, { version: base.version + 1, records: [kit] }), replayed: false } };
      return { status: 409, body: { error: { code: "STALE_RECORD", message: "The record changed since it was read.", details: null } } };
    });
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Not saved: The record changed since it was read. The current saved work has been reloaded.");
    await waitFor(() => expect(gets).toBe(2));
  });

  it("a removal whose outcome is unknown offers no Undo", async () => {
    stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") return { body: { visit: base } };
      return "reject";
    });
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    await waitFor(() => expect(screen.getByRole("button", { name: removeLabel(cushion) })).toBeEnabled());
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(/^Removed /)).toBeNull();
  });

  it("leaving the visit withdraws its Undo", async () => {
    stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") return { body: { visit: base } };
      return { body: { visit: stateOf(base, { version: base.version + 1, records: [kit] }), replayed: false } };
    });
    const view = render(
      <ToastProvider>
        <CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    await screen.findByRole("button", { name: "Undo" });
    view.rerender(
      <ToastProvider>
        <p>another screen</p>
      </ToastProvider>,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(/^Removed /)).toBeNull();
  });

  it("after Undo, focus goes to the inspector heading of the restored location", async () => {
    stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") return { body: { visit: base } };
      if (url.endsWith("/records/remove")) return { body: { visit: stateOf(base, { version: base.version + 1, records: [kit] }), replayed: false } };
      return { body: { visit: stateOf(base, { version: base.version + 2, records: [kit, { ...cushion, version: 1 }] }), replayed: false } };
    });
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    undo.focus();
    fireEvent.click(undo);
    await waitFor(() => expect(document.getElementById("inspector-heading")).toHaveFocus());
    expect(document.getElementById("inspector-heading")).toHaveTextContent(cushion.locationLabel);
  });
});

describe("CheckView edit that loses a race with completion (I2)", () => {
  const locked = { status: 409, body: { error: { code: "VISIT_LOCKED", message: "This visit is completed and locked.", details: null } } };
  const completed: Visit = { ...base, status: "COMPLETED", version: base.version + 1, completedAt: "2026-11-12T10:00:00.000Z" };
  const notSaved = (r: VisitRecord) =>
    `Not saved: ${r.locationLabel} / ${r.componentName}. The visit was completed elsewhere; this change is not in the report.`;
  /** The server: the draft at first; once a write is refused as locked, the completed visit. */
  const stubLocked = () => {
    let refused = false;
    stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (method === "GET") return { body: { visit: refused ? completed : base } };
      refused = true;
      return locked;
    });
  };
  const renderWithToasts = () =>
    render(
      <ToastProvider>
        <CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />
      </ToastProvider>,
    );
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an update refused because the visit was completed says so in a toast that stays after the form is gone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubLocked();
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: "Pick seat 3A" }));
    const card = await screen.findByRole("region", { name: new RegExp(`^${cushion.componentName}`) });
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "changed" } });
    fireEvent.click(within(card).getByRole("button", { name: "Update record" }));
    await screen.findByText(notSaved(cushion));
    // The reload shows the completed visit: the form, and its own "Not saved" line, are gone.
    await screen.findByText("Completed and locked");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Update record" })).toBeNull());
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(notSaved(cushion))).toBeInTheDocument();
  });

  it("a removal refused because the visit was completed says so in a toast that stays, with no Undo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubLocked();
    renderWithToasts();
    fireEvent.click(await screen.findByRole("button", { name: removeLabel(cushion) }));
    await screen.findByText(notSaved(cushion));
    await screen.findByText("Completed and locked");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(notSaved(cushion))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("CheckView problems, carried over and completion", () => {
  const obs = (id: string, over: Partial<Observation> = {}): Observation => ({
    id,
    tail: "N100TL",
    status: "OPEN",
    version: 1,
    locationId: "SEAT:3A",
    componentId: "SEATBELT",
    condition: "BROKEN",
    note: "",
    outcome: "DEFERRED",
    deferUntil: "NEXT_CHECK",
    reason: "NO_STOCK",
    melClass: { class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Seat blocked and placarded INOP", blocksSeat: true },
    dueDate: "2026-11-22",
    blocksSeat: true,
    openedInVisitId: "visit-0",
    closedInVisitId: null,
    closedAs: null,
    locationLabel: "Seat 3A",
    componentName: "Seat belt",
    createdAt: "2026-11-05T09:00:00.000Z",
    updatedAt: "2026-11-05T09:00:00.000Z",
    ...over,
  });
  const belt = obs("OBS-BELT");
  const assist = obs("OBS-ASSIST", {
    locationId: "BIN:L-03",
    componentId: "BIN_ASSIST",
    condition: "BROKEN",
    melClass: { class: "COSMETIC" },
    dueDate: null,
    blocksSeat: false,
    locationLabel: "Overhead bin L-03 (rows 6-8, 6 bags)",
    componentName: "Bin assist strut",
  });
  const tray = obs("OBS-TRAY", {
    componentId: "TRAY",
    outcome: "MUST_FIX",
    deferUntil: undefined,
    reason: undefined,
    melClass: { class: "NO_GO", reason: "Raised by the technician" },
    raisedTo: "NO_GO",
    dueDate: null,
    blocksSeat: false,
    openedInVisitId: base.id,
    componentName: "Tray table (on the seat in front)",
  });
  const withCarried: Visit = {
    ...base,
    carried: [
      { observation: belt, placement: "SAME", locationId: "SEAT:3A", overdue: false },
      { observation: assist, placement: "ORPHANED", locationId: null, overdue: false },
    ],
  };
  const event = { seq: 1, type: "OBSERVATION_ADDED", at: "2026-11-12T12:02:00.000Z", payload: {} };

  it("carried-over panel lists the deferral and Show selects it", async () => {
    stubFetch((): Answer => ({ body: { visit: withCarried } }));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    const panel = await screen.findByRole("region", { name: /^Carried over/ });
    const item = within(panel).getByText("Seat 3A / Seat belt").closest("li") as HTMLElement;
    expect(item).toHaveTextContent("Broken");
    expect(item).toHaveTextContent("Defer");
    expect(item).toHaveTextContent("Fix by 22 Nov 2026");
    fireEvent.click(within(item).getByRole("button", { name: "Show Seat 3A Seat belt" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Seat 3A" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^Seat belt/ })).toHaveClass("highlighted");
  });

  it("an orphaned item appears under No longer at this position", async () => {
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: withCarried } };
      return { body: { visit: stateOf(withCarried, { version: base.version + 1, carried: [at(withCarried.carried, 0)] }), replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    const panel = await screen.findByRole("region", { name: /^Carried over/ });
    const heading = within(panel).getByRole("heading", { name: "No longer at this position" });
    const item = within(heading.nextElementSibling as HTMLElement)
      .getByText(/Overhead bin L-03 .* \/ Bin assist strut/)
      .closest("li") as HTMLElement;
    expect(
      within(item)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mark fixed"]);
    fireEvent.click(within(item).getByRole("button", { name: /^Mark fixed/ }));
    await waitFor(() => expect(within(panel).queryByRole("heading", { name: "No longer at this position" })).toBeNull());
    const close = sent.find((s) => s.method === "POST");
    expect(close?.url).toBe(`/api/visits/${base.id}/observations/OBS-ASSIST/close`);
    expect(close?.body).toMatchObject({ closedAs: "FIXED", expectedVersion: 1, idempotencyKey: expect.any(String) });
  });

  it("an orphaned item's close with no answer offers Retry safely with the same key", async () => {
    let posts = 0;
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: withCarried } };
      posts += 1;
      return posts === 1
        ? "reject"
        : { body: { visit: stateOf(withCarried, { version: base.version + 1, carried: [at(withCarried.carried, 0)] }), replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    const panel = await screen.findByRole("region", { name: /^Carried over/ });
    fireEvent.click(within(panel).getByRole("button", { name: /^Mark fixed/ }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect(within(panel).queryByRole("heading", { name: "No longer at this position" })).toBeNull());
    const closes = sent.filter((s) => s.method === "POST");
    expect(closes).toHaveLength(2);
    expect(closes[1]?.body?.idempotencyKey).toBe(closes[0]?.body?.idempotencyKey);
  });

  it("complete with an open must-fix needs the hold checkbox and sends aircraftHeld", async () => {
    const visit: Visit = { ...withCarried, observations: [tray], events: [event] };
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit } };
      return { body: { visit: stateOf(visit, { status: "COMPLETED" }), report: {}, alreadyCompleted: false } };
    });
    const navigate = vi.fn();
    render(<CheckView visitId={base.id} navigate={navigate} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getByText(/Seat 3A \/ Tray table/)
        .closest("li"),
    ).toHaveTextContent("Broken");
    expect(within(dialog).queryByRole("button", { name: "Confirm completion" })).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Complete check" });
    const held = within(dialog).getByRole("checkbox", { name: "Aircraft held, reported to maintenance" });
    expect(held).toBeRequired();
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(0);
    fireEvent.click(held);
    expect(confirm).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(confirm);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/visit/${base.id}/report`));
    expect(sent.find((s) => s.method === "POST")?.body).toMatchObject({ confirm: true, aircraftHeld: true });
  });

  it("an overdue carried MEL deferral is listed as must-fix in the completion dialog", async () => {
    const overdue: Visit = { ...base, checkDate: "2026-11-23", carried: [{ observation: belt, placement: "SAME", locationId: "SEAT:3A", overdue: true }] };
    stubFetch((): Answer => ({ body: { visit: overdue } }));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Seat 3A / Seat belt").closest("li")).toHaveTextContent("Overdue since 22 Nov 2026");
    expect(within(dialog).getByRole("checkbox", { name: "Aircraft held, reported to maintenance" })).toBeInTheDocument();
  });

  it("a must-fix the server still reports keeps the dialog open with the hold checkbox", async () => {
    const lateTray = { ...tray, openedInVisitId: "visit-0" };
    let refused = false;
    const sent = stubFetch((method, url): Answer => {
      if (method === "GET")
        return {
          body: { visit: refused ? { ...base, carried: [{ observation: lateTray, placement: "SAME", locationId: "SEAT:3A", overdue: false }] } : base },
        };
      if (url.endsWith("/complete") && !refused) {
        refused = true;
        return {
          status: 409,
          body: { error: { code: "MUST_FIX_OPEN", message: "A must-fix problem is still open on this aircraft.", details: { observationIds: ["OBS-TRAY"] } } },
        };
      }
      return { body: { visit: stateOf(base, { status: "COMPLETED" }), report: {}, alreadyCompleted: false } };
    });
    const navigate = vi.fn();
    render(<CheckView visitId={base.id} navigate={navigate} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm completion" }));
    const held = await screen.findByRole("checkbox", { name: "Aircraft held, reported to maintenance" });
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText(/Seat 3A \/ Tray table/);
    fireEvent.click(held);
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete check" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/visit/${base.id}/report`));
    const completes = sent.filter((s) => s.url.endsWith("/complete"));
    expect(completes.map((s) => s.body?.aircraftHeld)).toEqual([undefined, true]);
    expect(completes[1]?.body?.idempotencyKey).not.toBe(completes[0]?.body?.idempotencyKey);
  });

  it("a visit with only a problem written down can be completed", async () => {
    stubFetch((): Answer => ({ body: { visit: { ...base, records: [], recordCount: 0, events: [event] } } }));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    expect(await screen.findByRole("button", { name: "Complete visit…" })).toBeEnabled();
  });

  it("a problem save with no answer keeps the form and its input, and Retry safely closes it with the same key", async () => {
    let posts = 0;
    const saved = stateOf(base, {
      version: base.version + 1,
      observations: [obs("OBS-NEW", { componentId: "CUSHION", condition: "STAINED", outcome: "NOTED", openedInVisitId: base.id })],
    });
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: base } };
      posts += 1;
      return posts === 1 ? "reject" : { status: 201, body: { visit: saved, replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick seat 3A" }));
    const card = await screen.findByRole("region", { name: new RegExp(`^${cushion.componentName}`) });
    fireEvent.click(within(card).getByRole("button", { name: "Note a problem" }));
    fireEvent.click(within(card).getByRole("radio", { name: "Stained" }));
    fireEvent.click(within(card).getByRole("radio", { name: "Note only" }));
    fireEvent.change(within(card).getByLabelText(/^Note about the problem/), { target: { value: "coffee" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save problem" }));
    await within(card).findByText(/may or may not have been saved/);
    expect(within(card).getByLabelText(/^Note about the problem/)).toHaveValue("coffee");
    expect(within(card).getByRole("button", { name: "Save problem" })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect(within(card).queryByRole("group", { name: "Note a problem" })).toBeNull());
    const adds = sent.filter((s) => s.method === "POST");
    expect(adds.map((s) => s.url)).toEqual([`/api/visits/${base.id}/observations`, `/api/visits/${base.id}/observations`]);
    expect(adds[1]?.body?.idempotencyKey).toBe(adds[0]?.body?.idempotencyKey);
    expect(adds[0]?.body?.observation).toStrictEqual({ locationId: "SEAT:3A", componentId: "CUSHION", condition: "STAINED", note: "coffee", outcome: "NOTED" });
  });
});
