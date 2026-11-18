import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReport } from "../../src/domain/report.ts";
import type { Observation, Report, Visit, VisitEvent } from "../../src/domain/types.ts";
import type { LocationState } from "../../src/web/scene/CabinScene.ts";
import { ReportView } from "../../src/web/views/ReportView.tsx";
import { CUSHION_3A, fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

// The 3D view is not under test here: a stand-in records what the report hands it.
const shown3d = vi.hoisted(() => ({ states: null as Map<string, LocationState> | null }));
vi.mock("../../src/web/components/Cabin3D.tsx", () => ({
  Cabin3D: (props: { states: Map<string, LocationState> }) => {
    shown3d.states = props.states;
    return <p>3D stand-in</p>;
  },
}));

const visit = visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), [CUSHION_3A]);
const envelope = { report: buildReport(visit, "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z"), basisSha256: null, linkedEvents: [] };
const { snapshot: _snapshot, ...state } = visit;

/** Answers the report and the visit (for its frozen layout) by URL. */
const reportAnswer =
  (env: { report: Report; basisSha256: string | null; linkedEvents: VisitEvent[] }, v: Visit = visit) =>
  (_method: string, url: string): Answer =>
    url.endsWith("/report") ? { body: env } : { body: { visit: v } };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function typeNote(text: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), { target: { value: text } });
}

describe("ReportView linked notes", () => {
  it("a double click on Add linked note sends one request", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    const sent = stubFetch((method, url): Answer => (method === "GET" ? reportAnswer(envelope)(method, url) : answer.promise));
    render(<ReportView visitId={visit.id} />);
    await typeNote("Cushion cover reseated");
    const add = screen.getByRole("button", { name: "Add linked note" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(add).toBeDisabled();
    answer.resolve({ status: 201, body: { visit: state, replayed: false } });
    await screen.findByText(/Linked note added/);
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("a late report answer for the previous visit is not shown under the next visit", async () => {
    const other = { ...visit, id: "visit-2", number: 2 };
    const otherEnvelope = { report: buildReport(other, "DRAFT_PREVIEW", "2026-11-12T12:03:00.000Z"), basisSha256: null, linkedEvents: [] };
    const slow = deferred<{ body: unknown }>();
    stubFetch((_method, url): Answer => (url === `/api/visits/${visit.id}/report` ? slow.promise : { body: otherEnvelope }));
    const view = render(<ReportView visitId={visit.id} />);
    view.rerender(<ReportView visitId={other.id} />);
    await screen.findByText("#2");
    slow.resolve({ body: envelope });
    await act(async () => {});
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.queryByText("#1")).toBeNull();
  });

  it("a lost response on a linked note says the outcome is unknown and offers a safe retry", async () => {
    let posts = 0;
    const sent = stubFetch((method, url): Answer => {
      if (method === "GET") return reportAnswer(envelope)(method, url);
      posts += 1;
      return posts === 1 ? "reject" : { status: 201, body: { visit: state, replayed: true } };
    });
    render(<ReportView visitId={visit.id} />);
    await typeNote("Cushion cover reseated");
    fireEvent.click(screen.getByRole("button", { name: "Add linked note" }));
    await screen.findByText(/may or may not have been saved/);
    // The typed note is kept for the retry.
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("Cushion cover reseated");
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    await screen.findByText(/Linked note added/);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue(""));
    const notes = sent.filter((s) => s.method === "POST");
    expect(notes).toHaveLength(2);
    expect(notes[0]?.body).toMatchObject({ type: "ADVISORY", note: "Cushion cover reseated", idempotencyKey: expect.any(String) });
    expect(notes[1]?.body?.idempotencyKey).toBe(notes[0]?.body?.idempotencyKey);
  });
});

const COSMETIC = { class: "COSMETIC" } as const;
const MEL_C = { class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Fictional deferral" } as const;

function obs(extra: Partial<Observation> = {}): Observation {
  return {
    id: "OBS-1",
    tail: "N100TL",
    status: "OPEN",
    version: 1,
    locationId: "SEAT:3A",
    componentId: "HEADREST",
    condition: "STAINED",
    note: "",
    outcome: "NOTED",
    melClass: COSMETIC,
    dueDate: null,
    blocksSeat: false,
    openedInVisitId: "visit-1",
    closedInVisitId: null,
    closedAs: null,
    locationLabel: "Seat 3A",
    componentName: "Headrest cover",
    createdAt: "2026-11-12T12:01:00.000Z",
    updatedAt: "2026-11-12T12:01:00.000Z",
    ...extra,
  };
}
const ev = (seq: number, type: string, payload: Record<string, unknown>): VisitEvent => ({ seq, type, at: `2026-11-12T12:0${seq}:00.000Z`, payload });

/** A v3 visit with one problem of each outcome, one carried in, and a timeline. */
function outcomeVisit(over: Partial<Visit> = {}): Visit {
  const noted = obs({ id: "N", outcome: "NOTED", note: "Small mark" });
  const deferredMel = obs({
    id: "DM",
    outcome: "DEFERRED",
    locationId: "SEAT:3C",
    componentId: "TRAY",
    condition: "WONT_LATCH",
    deferUntil: "NEXT_CHECK",
    melClass: MEL_C,
    dueDate: "2026-11-22",
    locationLabel: "Seat 3C",
    componentName: "Tray table",
  });
  const mustFix = obs({
    id: "MF",
    outcome: "MUST_FIX",
    locationId: "SEAT:4A",
    condition: "BROKEN",
    melClass: { class: "NO_GO", reason: "Fictional no-go." },
    locationLabel: "Seat 4A",
  });
  const closed = obs({ id: "CL", status: "CLOSED", closedInVisitId: "visit-1", closedAs: "REPLACED", locationId: "SEAT:4B", locationLabel: "Seat 4B" });
  const carried = obs({ id: "CA", outcome: "DEFERRED", openedInVisitId: "visit-0", locationId: "SEAT:5A", locationLabel: "Seat 5A", condition: "TORN" });
  return {
    ...visit,
    observations: [noted, deferredMel, mustFix, closed],
    carried: [{ observation: carried, placement: "SAME", locationId: "SEAT:5A", overdue: false, openedCheckDate: "2026-11-05" }],
    events: [
      ev(1, "RECORD_ADDED", { locationId: "SEAT:3A", componentId: "CUSHION" }),
      ev(2, "OBSERVATION_ADDED", { observation: deferredMel }),
      ev(3, "OBSERVATION_ADDED", { observation: mustFix }),
      ev(4, "OBSERVATION_CLOSED", { before: closed, after: closed }),
    ],
    ...over,
  };
}

const outcomeEnvelope = (v: Visit) => ({ report: buildReport(v, "DRAFT_PREVIEW", "2026-11-12T12:09:00.000Z"), basisSha256: null, linkedEvents: [] });
const NEW_HEADINGS = [
  "Summary",
  "Cabin picture",
  "What happened, in order",
  "Deferred",
  "Must be fixed",
  "Noted",
  "Closed this check",
  "Carried over in",
  "Still open",
];

describe("ReportView after-action sections", () => {
  it("a v3 report shows Summary, Cabin picture, timeline and the outcome lists", async () => {
    const v = outcomeVisit();
    const env = outcomeEnvelope(v);
    stubFetch(reportAnswer(env, v));
    const { container } = render(<ReportView visitId={v.id} />);
    await screen.findByRole("heading", { name: "Summary" });
    // in the brief's order, then the existing sections
    const headings = [...NEW_HEADINGS, "Visit", "Aggregate part totals (1 part/unit lines)"].map((name) => screen.getByRole("heading", { name, level: 3 }));
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i - 1]?.compareDocumentPosition(headings[i] as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(container.querySelector("h3#r-summary")).toHaveTextContent("Summary");
    // the timeline is an ordered list, one <time> per entry
    const timeline = container.querySelector("#r-timeline")?.closest("section");
    const items = timeline?.querySelectorAll("ol > li") ?? [];
    expect(items).toHaveLength(env.report.timeline?.length ?? -1);
    expect(items).toHaveLength(4);
    for (const li of items) expect(li.querySelector("time")).not.toBeNull();
    expect(items[1]).toHaveTextContent("Seat 3C · Tray table: problem deferred (Won't latch)");
    // the outcome lists name each problem where it sits
    const list = (name: string) => within(screen.getByRole("heading", { name, level: 3 }).closest("section") as HTMLElement);
    expect(list("Deferred").getByText(/Seat 3C · Tray table/)).toBeInTheDocument();
    expect(list("Must be fixed").getByText(/Seat 4A · Headrest cover/)).toBeInTheDocument();
    expect(list("Noted").getByText(/Small mark/)).toBeInTheDocument();
    expect(list("Closed this check").getByText(/Seat 4B · Headrest cover/)).toBeInTheDocument();
    expect(list("Carried over in").getByText(/Seat 5A · Headrest cover/)).toBeInTheDocument();
    expect(list("Still open").getAllByRole("listitem")).toHaveLength(3);
    // the cabin picture: a read-only map coloured by outcome, with no go-to and no selection
    const picture = within(container.querySelector("#r-picture")?.closest("section") as HTMLElement);
    const seat4a = await picture.findByRole("button", { name: /^Seat 4A.*Must fix/ });
    expect(seat4a).not.toHaveAttribute("aria-pressed");
    expect(picture.getByRole("button", { name: /^Seat 3C.*Deferred/ })).toBeInTheDocument();
    expect(picture.getByRole("button", { name: /^Seat 3A.*1 replacement recorded.*Noted/ })).toBeInTheDocument();
    expect(picture.queryByRole("textbox", { name: "Go to location" })).toBeNull();
    expect(picture.getByRole("list", { name: "Status key" })).toBeInTheDocument();
    fireEvent.click(seat4a);
    expect(picture.queryByRole("heading", { name: /^Pieces at/ })).toBeNull();
    // View in 3D mounts the scene on demand, with the same states
    expect(picture.queryByText("3D stand-in")).toBeNull();
    fireEvent.click(picture.getByRole("button", { name: "View in 3D" }));
    await picture.findByText("3D stand-in");
    expect(shown3d.states?.get("SEAT:4A")?.components.HEADREST).toBe("mustFix");
    expect(shown3d.states?.get("SEAT:3A")?.components).toMatchObject({ CUSHION: "recorded", HEADREST: "noted" });
  });

  it("a held aircraft's next report lists a carried overdue MEL deferral under Must be fixed and counts it (R43)", async () => {
    const overdue = obs({
      id: "OD",
      outcome: "DEFERRED",
      openedInVisitId: "visit-0",
      locationId: "SEAT:5A",
      locationLabel: "Seat 5A",
      componentId: "TRAY",
      componentName: "Tray table",
      condition: "BROKEN",
      melClass: MEL_C,
      dueDate: "2026-11-10",
    });
    const held = outcomeVisit({
      aircraftHeld: true,
      observations: [],
      carried: [{ observation: overdue, placement: "SAME", locationId: "SEAT:5A", overdue: true, openedCheckDate: "2026-11-01" }],
    });
    stubFetch(reportAnswer(outcomeEnvelope(held), held));
    render(<ReportView visitId={held.id} />);
    await screen.findByText("Not releasable: aircraft held");
    const facts = within(screen.getByRole("heading", { name: "Summary" }).closest("section") as HTMLElement);
    expect(facts.getByText("Must be fixed").nextElementSibling).toHaveTextContent("1");
    expect(facts.getByText("Carried over in").nextElementSibling).toHaveTextContent("0");
    const list = (name: string) => within(screen.getByRole("heading", { name, level: 3 }).closest("section") as HTMLElement);
    expect(list("Must be fixed").getByRole("listitem")).toHaveTextContent(/Seat 5A · Tray table.*carried over from an earlier check/);
    expect(list("Carried over in").getByText("None.")).toBeInTheDocument();
  });

  it("Not releasable shows when releasable is false", async () => {
    const held = outcomeVisit({ aircraftHeld: true });
    stubFetch(reportAnswer(outcomeEnvelope(held), held));
    const view = render(<ReportView visitId={held.id} />);
    const line = await screen.findByText("Not releasable: aircraft held");
    expect(line).toHaveClass("must-fix");
    expect(screen.queryByText("Not releasable: items must be fixed before flight")).toBeNull();
    view.unmount();
    // with no must-fix problem open it is releasable, and the line is gone
    const fine = outcomeVisit({ observations: [obs({ id: "N", outcome: "NOTED" })], carried: [] });
    stubFetch(reportAnswer(outcomeEnvelope(fine), fine));
    render(<ReportView visitId={fine.id} />);
    await screen.findByRole("heading", { name: "Summary" });
    expect(screen.queryByText("Not releasable: aircraft held")).toBeNull();
  });

  it("Not releasable on a visit that is not held says the items must be fixed, not that the aircraft is held", async () => {
    const draft = outcomeVisit({ aircraftHeld: false });
    const env = outcomeEnvelope(draft);
    expect(env.report.summary).toMatchObject({ releasable: false, aircraftHeld: false });
    stubFetch(reportAnswer(env, draft));
    render(<ReportView visitId={draft.id} />);
    const line = await screen.findByText("Not releasable: items must be fixed before flight");
    expect(line).toHaveClass("must-fix");
    expect(screen.queryByText("Not releasable: aircraft held")).toBeNull();
  });

  it("a /2 report shows no empty new sections", async () => {
    const { summary: _s, timeline: _t, observations: _o, pieceOutcomes: _p, ...rest } = outcomeEnvelope(outcomeVisit()).report;
    const old: Report = { ...rest, schema: "cabin-kit.report/2" };
    const sent = stubFetch(reportAnswer({ report: old, basisSha256: null, linkedEvents: [] }));
    render(<ReportView visitId={visit.id} />);
    await screen.findByRole("heading", { name: "Visit" });
    for (const name of NEW_HEADINGS) expect(screen.queryByRole("heading", { name })).toBeNull();
    expect(screen.queryByRole("button", { name: "View in 3D" })).toBeNull();
    // no layout is fetched for a picture that is not shown
    expect(sent.map((s) => s.url)).toEqual([`/api/visits/${visit.id}/report`]);
  });
});
