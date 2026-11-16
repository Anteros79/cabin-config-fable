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
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/visits?status=DRAFT&q=N100&page=3"));
    expect(screen.queryByText("No visits match.")).toBeNull();
  });

  it("an empty list on a later page goes back to the first page", async () => {
    stubFetch((): Answer => ({ body: { items: [], total: 0 } }));
    const navigate = vi.fn();
    render(<VisitsView status={null} q="" page={4} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/visits"));
  });
});
