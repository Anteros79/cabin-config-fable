import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisitsView } from "../../src/web/views/VisitsView.tsx";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

const item = (n: number) => ({
  id: `3f2b8c1e-5a4d-4e6f-9a7b-${String(n).padStart(12, "0")}`,
  number: n,
  tail: "N100TL",
  checkDate: "2026-11-12",
  status: "DRAFT",
  variantId: "V1",
  recordCount: 0,
  technician: "",
  updatedAt: "2026-11-12T10:00:00.000Z",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VisitsView", () => {
  it("the search field stops at the 100 characters the server accepts", () => {
    stubFetch((): Answer => ({ body: { items: [], total: 0 } }));
    render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    expect(screen.getByLabelText(/^Search tail/)).toHaveAttribute("maxlength", "100");
  });

  it("Apply is disabled while the list is loading", async () => {
    const answer = deferred<{ body: unknown }>();
    stubFetch((): Answer => answer.promise);
    render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    answer.resolve({ body: { items: [item(1)], total: 1 } });
    await waitFor(() => expect(apply).toBeEnabled());
  });

  it("an out-of-range page is replaced by the last page once the total is known", async () => {
    stubFetch((): Answer => ({ body: { items: [], total: 60 } }));
    const navigate = vi.fn();
    render(<VisitsView status="DRAFT" q="N100" page={9999} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/visits?status=DRAFT&q=N100&page=3", { replace: true }));
    expect(screen.queryByText("No visits match this filter.")).toBeNull();
  });

  it("an empty list on a later page goes back to the first page", async () => {
    stubFetch((): Answer => ({ body: { items: [], total: 0 } }));
    const navigate = vi.fn();
    render(<VisitsView status={null} q="" page={4} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/visits", { replace: true }));
  });

  it("an empty store and an empty filter show different messages, each with its next step", async () => {
    stubFetch((): Answer => ({ body: { items: [], total: 0 } }));
    const view = render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    await screen.findByText("No visits yet.");
    expect(screen.getByRole("link", { name: "Start a check" })).toHaveAttribute("href", "#/check");
    expect(screen.queryByText("No visits match this filter.")).toBeNull();
    view.unmount();
    render(<VisitsView status="DRAFT" q="N9" page={1} navigate={vi.fn()} />);
    await screen.findByText("No visits match this filter.");
    expect(screen.getByRole("link", { name: "Clear filter" })).toHaveAttribute("href", "#/visits");
    expect(screen.queryByText("No visits yet.")).toBeNull();
  });

  it("the pager is hidden when everything fits on one page", async () => {
    stubFetch((): Answer => ({ body: { items: [item(1), item(2)], total: 2 } }));
    const view = render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    await screen.findByText("2 visits");
    expect(screen.queryByRole("navigation", { name: "Visit pages" })).toBeNull();
    view.unmount();
    stubFetch((): Answer => ({ body: { items: [item(1)], total: 60 } }));
    render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    await screen.findByText(/page 1 of 3/);
    expect(screen.getByRole("navigation", { name: "Visit pages" })).toBeInTheDocument();
  });

  it("dates read as words; the machine value stays on the time element", async () => {
    stubFetch((): Answer => ({ body: { items: [item(1)], total: 1 } }));
    const { container } = render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    await screen.findByText("12 Nov 2026");
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-11-12T10:00:00.000Z");
    expect(time).toHaveAttribute("title", "2026-11-12T10:00:00.000Z");
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("while loading, the table is a placeholder hidden from assistive technology and the panel is busy", () => {
    stubFetch((): Answer => deferred<{ body: unknown }>().promise);
    const { container } = render(<VisitsView status={null} q="" page={1} navigate={vi.fn()} />);
    expect(container.querySelector("section")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("[data-skeleton]")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Loading saved visits")).toHaveClass("sr-only");
  });
});
