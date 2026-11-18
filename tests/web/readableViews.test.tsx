import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreparation } from "../../src/domain/prep.ts";
import { buildReport } from "../../src/domain/report.ts";
import type { Observation } from "../../src/domain/types.ts";
import type { LayoutDetail, ReferenceInfo } from "../../src/web/api.ts";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { LayoutsView } from "../../src/web/views/LayoutsView.tsx";
import { PrepView } from "../../src/web/views/PrepView.tsx";
import { ReferenceView } from "../../src/web/views/ReferenceView.tsx";
import { ReportView } from "../../src/web/views/ReportView.tsx";
import { VisitsView } from "../../src/web/views/VisitsView.tsx";
import { at, CUSHION_3A, fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

// The 3D view is not under test; its text is not view text.
vi.mock("../../src/web/components/Viewer.tsx", () => ({ Viewer: () => <p>3D view</p> }));

const release = fixtureRelease();
const snap = snapshotFor(release, "N100TL", "2026-11-12");
const visit = visitWith(snap, [CUSHION_3A]);
const reportEnvelope = {
  report: buildReport(visit, "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z"),
  basisSha256: null,
  linkedEvents: [{ seq: 1, type: "ADVISORY", at: "2026-11-12T12:05:00.000Z", payload: { note: "Checked twice", author: "R. Lee" } }],
};
const layoutRevision = at(release.layoutRevisions, 0);
const layoutDetail: LayoutDetail = { releaseId: release.id, layoutRevision, source: null, categories: [], components: release.components };
const layoutsList = {
  releaseId: release.id,
  layouts: [
    {
      id: layoutRevision.id,
      layoutId: layoutRevision.layoutId,
      revision: layoutRevision.revision,
      namespace: layoutRevision.namespace,
      status: layoutRevision.status,
      name: layoutRevision.name,
      subtypeId: layoutRevision.subtypeId,
      seatSetStatus: layoutRevision.seatSetStatus,
      seatCount: 6,
      declaredSeatCount: null,
      floorMapStatus: layoutRevision.floorMapStatus,
      binMapStatus: layoutRevision.binMapStatus,
      tierCounts: { standard: 6 },
      variants: [],
      notes: [],
    },
  ],
  layoutCategories: [],
  visualProfiles: [],
};
const reference: ReferenceInfo = {
  releaseId: release.id,
  label: "Fixture release",
  contentHash: "ab".repeat(32),
  activatedAt: "2026-11-10T08:30:00.000Z",
  authorityNotice: "Fictional demonstration.",
  dateRule: "Dates are inclusive.",
  replacementCountSemantics: "Counts are replacements.",
  namespaces: { fixture: "Fictional fixtures." },
  counts: { aircraft: 4, layoutRevisions: { fixture: 2, candidate: 5 }, accepted: 0 },
  visualProfiles: [],
  findings: [{ severity: "warning", code: "SEAT_COUNT_MISMATCH", message: "Declared and drawn seat counts differ." }],
  stats: {},
  sources: [],
  releases: [
    {
      id: release.id,
      status: "active",
      createdAt: "2026-11-10T08:29:00.000Z",
      activatedAt: "2026-11-10T08:30:00.000Z",
      label: "x",
      findingCounts: { warning: 12, error: 3 },
    },
  ],
};
const visitItem = {
  id: visit.id,
  number: visit.number,
  tail: visit.tail,
  checkDate: visit.checkDate,
  status: "DRAFT",
  variantId: "V1",
  recordCount: 1,
  technician: "",
  updatedAt: "2026-11-12T10:00:00.000Z",
};

function answer(_method: string, url: string): Answer {
  if (url.startsWith("/api/tails")) return { body: { tails: [] } };
  if (url === `/api/visits/${visit.id}/report`) return { body: reportEnvelope };
  if (url.startsWith(`/api/visits/${visit.id}/preparation`)) return { body: buildPreparation(snap) };
  if (url === `/api/visits/${visit.id}`) return { body: { visit } };
  if (url.startsWith("/api/visits")) return { body: { items: [visitItem], total: 1 } };
  if (url === "/api/layouts") return { body: layoutsList };
  if (url.startsWith("/api/layouts/")) return { body: layoutDetail };
  if (url === "/api/reference") return { body: reference };
  throw new Error(`unexpected ${url}`);
}

const VIEWS: [string, () => ReactElement, string][] = [
  ["visit workspace", () => <CheckView visitId={visit.id} navigate={vi.fn()} visualProfiles={[]} />, "visit"],
  ["report", () => <ReportView visitId={visit.id} />, "report"],
  ["preparation list", () => <PrepView visitId={visit.id} tail={null} date={null} />, "preparation list"],
  ["saved visits", () => <VisitsView status={null} q="" page={1} navigate={vi.fn()} />, "saved visits"],
  ["layouts", () => <LayoutsView layoutId={null} visualProfiles={[]} />, "layouts"],
  ["one layout", () => <LayoutsView layoutId={layoutRevision.id} visualProfiles={[]} />, "layout"],
  ["reference data", () => <ReferenceView />, "reference data"],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("views show people words, not machine values", () => {
  for (const [name, view] of VIEWS) {
    it(`${name}: no raw ISO timestamp or JSON string`, async () => {
      stubFetch(answer);
      const { container } = render(view());
      await waitFor(() => expect(container.querySelector("[aria-busy='true']")).toBeNull());
      await waitFor(() => expect(container.textContent?.length).toBeGreaterThan(40));
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text).not.toMatch(/\{"/);
      for (const time of container.querySelectorAll("time")) {
        expect(time.getAttribute("dateTime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(time.getAttribute("title")).toBe(time.getAttribute("dateTime"));
      }
    });
  }

  it("visit workspace with a recorded location selected: the saved record card names its time in words", async () => {
    stubFetch(answer);
    const { container } = render(<CheckView visitId={visit.id} navigate={vi.fn()} visualProfiles={[]} />);
    const [recorded] = visit.records;
    if (!recorded) throw new Error("fixture visit has no record");
    fireEvent.click(await screen.findByRole("button", { name: `Show ${recorded.locationLabel} ${recorded.componentName}` }));
    await screen.findByText(/^Saved\. Record version/);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const saved = screen.getByText(/^Saved\. Record version/);
    expect(saved.querySelector("time")).toHaveAttribute("dateTime", recorded.updatedAt);
  });

  it("the report and the reference name states, severities and counts in words", async () => {
    stubFetch(answer);
    const report = render(<ReportView visitId={visit.id} />);
    await screen.findByText("12 Nov 2026, 12:02 UTC");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(report.container.textContent).not.toMatch(/\bRESOLVED\b|\bDRAFT\b(?! PREVIEW)/);
    report.unmount();
    render(<ReferenceView />);
    await screen.findByText("findings: 3 blocking findings, 12 warnings", { exact: false });
    expect(screen.getByText("2 fixture, 5 candidate")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
  });
});

describe("the after-action report sections", () => {
  /** A problem as stored: every code field set, so a leak would show. */
  const problem = (extra: Partial<Observation>): Observation => ({
    id: "OBS-1",
    tail: visit.tail,
    status: "OPEN",
    version: 1,
    locationId: "SEAT:3A",
    componentId: "TRAY",
    condition: "WONT_LATCH",
    note: "",
    outcome: "DEFERRED",
    deferUntil: "NEXT_CHECK",
    reason: "NO_STOCK",
    melClass: { class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Fictional deferral" },
    dueDate: "2026-11-22",
    blocksSeat: false,
    openedInVisitId: visit.id,
    closedInVisitId: null,
    closedAs: null,
    locationLabel: "Seat 3A",
    componentName: "Tray table",
    createdAt: "2026-11-12T12:01:00.000Z",
    updatedAt: "2026-11-12T12:01:00.000Z",
    ...extra,
  });
  const deferredMel = problem({ id: "DM" });
  const noGo = problem({
    id: "NG",
    outcome: "MUST_FIX",
    raisedTo: "NO_GO",
    melClass: { class: "NO_GO", reason: "Fictional no-go." },
    dueDate: null,
    componentId: "SEATBELT",
  });
  const overdue = problem({ id: "OD", locationId: "SEAT:3B", locationLabel: "Seat 3B", dueDate: "2026-11-01", openedInVisitId: "visit-0" });
  const closed = problem({ id: "CL", status: "CLOSED", closedInVisitId: visit.id, closedAs: "FIXED", condition: "OTHER", componentId: "CUSHION" });
  const v3 = {
    ...visit,
    aircraftHeld: true,
    observations: [deferredMel, noGo, closed],
    carried: [{ observation: overdue, placement: "SAME" as const, locationId: "SEAT:3B", overdue: true }],
    events: [
      { seq: 2, type: "OBSERVATION_ADDED", at: "2026-11-12T12:03:00.000Z", payload: { observation: deferredMel } },
      { seq: 3, type: "OBSERVATION_UPDATED", at: "2026-11-12T12:04:00.000Z", payload: { before: noGo, after: noGo } },
      { seq: 4, type: "OBSERVATION_CLOSED", at: "2026-11-12T12:05:00.000Z", payload: { before: closed, after: closed } },
      { seq: 5, type: "COMPLETED", at: "2026-11-12T12:06:00.000Z", payload: { aircraftHeld: true } },
    ],
  };

  it("no raw codes or ISO timestamps in the new sections", async () => {
    const envelope = { report: buildReport(v3, "FINAL", "2026-11-12T12:07:00.000Z"), basisSha256: null, linkedEvents: [] };
    stubFetch((method, url) => (url === `/api/visits/${visit.id}/report` ? { body: envelope } : answer(method, url)));
    const { container } = render(<ReportView visitId={visit.id} />);
    await screen.findByRole("heading", { name: "What happened, in order" });
    await screen.findByRole("heading", { name: /^Seats/ });
    const sections = ["r-summary", "r-picture", "r-timeline", "r-deferred", "r-mustfix", "r-noted", "r-closed", "r-carried", "r-open"].map(
      (id) => container.querySelector(`#${id}`)?.closest("section") as HTMLElement,
    );
    for (const section of sections) {
      expect(section).toBeInstanceOf(HTMLElement);
      const text = section.textContent ?? "";
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toMatch(/\{"/);
      expect(text).not.toMatch(
        /\b(NO_GO|WONT_LATCH|MUST_FIX|NEXT_CHECK|NO_STOCK|DEFERRED|NOTED|COSMETIC|REPLACED|FIXED|OTHER|OBSERVATION_\w+|RECORD_\w+|COMPLETED|SEAT:|mustFix)\b/,
      );
      for (const time of section.querySelectorAll("time")) expect(time.getAttribute("dateTime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(sections[2]?.querySelectorAll("time")).toHaveLength(4);
  });
});

describe("loading placeholders", () => {
  for (const [name, view, thing] of VIEWS) {
    it(`${name}: the panel is busy, the placeholder is hidden from assistive technology, and one line says what is loading`, () => {
      stubFetch((method, url) => (url.startsWith("/api/tails") ? answer(method, url) : deferred<{ body: unknown }>().promise));
      const { container } = render(view());
      const skeletons = container.querySelectorAll("[data-skeleton]");
      expect(skeletons).toHaveLength(1);
      expect(skeletons[0]).toHaveAttribute("aria-hidden", "true");
      expect(skeletons[0]?.closest("[aria-busy='true']")).not.toBeNull();
      expect(screen.getAllByText(/^Loading /)).toHaveLength(1);
      expect(screen.getByText(`Loading ${thing}`)).toHaveClass("sr-only");
    });
  }
});

describe("a layout without a seat set", () => {
  it("says so and links back to all layouts", async () => {
    stubFetch(() => ({ body: { ...layoutDetail, layoutRevision: { ...layoutRevision, seatSetStatus: "not-supplied", locations: [] } } }));
    render(<LayoutsView layoutId={layoutRevision.id} visualProfiles={[]} />);
    await screen.findByText("This layout has no seat set.");
    expect(screen.getByRole("link", { name: "All layouts" })).toHaveAttribute("href", "#/layouts");
  });
});
