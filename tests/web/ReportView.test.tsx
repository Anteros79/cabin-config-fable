import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReport } from "../../src/domain/report.ts";
import { ReportView } from "../../src/web/views/ReportView.tsx";
import { CUSHION_3A, fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

const visit = visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), [CUSHION_3A]);
const envelope = { report: buildReport(visit, "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z"), basisSha256: null, linkedEvents: [] };
const { snapshot: _snapshot, ...state } = visit;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function typeNote(text: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), { target: { value: text } });
}

describe("ReportView linked notes", () => {
  it("a double click on Add linked note sends one request", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    const sent = stubFetch((method): Answer => (method === "GET" ? { body: envelope } : answer.promise));
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
    const sent = stubFetch((method): Answer => {
      if (method === "GET") return { body: envelope };
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
