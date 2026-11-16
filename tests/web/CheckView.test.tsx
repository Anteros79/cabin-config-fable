import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Visit, VisitRecord, VisitState } from "../../src/domain/types.ts";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { CUSHION_3A, fixtureRelease, KIT_PRIMARY, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

// The 3D view is not under test here; a stand-in lets a test select a location the way a click in the cabin would.
vi.mock("../../src/web/components/Viewer.tsx", () => ({
  Viewer: ({ onSelect }: { onSelect(locationId: string, componentId: string | null): void }) => (
    <button type="button" onClick={() => onSelect("SEAT:3A", "CUSHION")}>
      Pick seat 3A
    </button>
  ),
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

describe("CheckView writes", () => {
  it("Start visit twice after a lost response sends one key", async () => {
    const result = lookup(release, "N100TL", "2026-11-12");
    let posts = 0;
    const sent = stubFetch((method, url): Answer => {
      if (url.startsWith("/api/tails")) return { body: { tails: [] } };
      if (url.startsWith("/api/lookup")) return { body: result };
      if (method === "POST" && url === "/api/visits") {
        posts += 1;
        return posts === 1 ? "reject" : { status: 201, body: { visit: base } };
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
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/visit/${base.id}`));
    const creates = sent.filter((s) => s.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body?.idempotencyKey).toEqual(expect.any(String));
    expect(creates[1]?.body?.idempotencyKey).toBe(creates[0]?.body?.idempotencyKey);
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
    stubFetch((method): Answer => (method === "GET" ? { body: { visit: base } } : answer.promise));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete visit…" }));
    const confirm = screen.getByRole("button", { name: "Confirm completion" });
    expect(confirm).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: removeLabel(cushion) }));
    expect(confirm).toBeDisabled();
    answer.resolve("reject");
    await screen.findByText(/A save has an unknown outcome/);
    expect(confirm).toBeDisabled();
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
