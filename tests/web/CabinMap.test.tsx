import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MelClass, Observation } from "../../src/domain/types.ts";
import { CabinMap } from "../../src/web/components/CabinMap.tsx";
import { buildStates, type Workspace } from "../../src/web/model.ts";
import { fixtureRelease, snapshotFor } from "../helpers.ts";

const snap = snapshotFor(fixtureRelease(), "N100TL", "2026-11-12");
const workspace: Workspace = {
  mode: "visit",
  layout: snap.context.layoutRevision,
  resolution: snap.resolution,
  componentDefs: snap.resolution.componentDefs,
  records: [],
  editable: true,
  unresolvedReason: null,
  observations: [],
  carried: [],
  checkDate: "2026-11-12",
  mel: [],
};

describe("CabinMap Go to location", () => {
  // WebKit lets a datalist suggestion take the first Enter, so the input submits its own form on Enter (I1).
  it("Enter in the input submits the form exactly once", () => {
    const onSelect = vi.fn();
    render(<CabinMap workspace={workspace} flags={new Map()} selection={null} onSelect={onSelect} />);
    const input = screen.getByLabelText("Go to location");
    const submits = vi.fn();
    input.closest("form")?.addEventListener("submit", submits);
    fireEvent.change(input, { target: { value: "3A" } });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(notPrevented, "the browser's own Enter handling is cancelled, so it cannot submit a second time").toBe(false);
    expect(submits).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("SEAT:3A", null);
  });

  it("Enter while an input method is composing does not submit", () => {
    const onSelect = vi.fn();
    render(<CabinMap workspace={workspace} flags={new Map()} selection={null} onSelect={onSelect} />);
    const input = screen.getByLabelText("Go to location");
    fireEvent.change(input, { target: { value: "3A" } });
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    fireEvent.keyDown(input, { key: "a" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("CabinMap Go to a piece", () => {
  const goTo = (text: string, selection: string | null = null) => {
    const onSelect = vi.fn();
    const view = render(<CabinMap workspace={workspace} flags={new Map()} selection={selection} onSelect={onSelect} />);
    const input = screen.getByLabelText("Go to location");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    view.unmount();
    return onSelect;
  };

  it("go to 12A life vest selects the seat and focuses LIFE_VEST", () => {
    expect(goTo("12A life vest")).toHaveBeenCalledWith("SEAT:12A", "LIFE_VEST");
    expect(goTo("12a LIFE VEST")).toHaveBeenCalledWith("SEAT:12A", "LIFE_VEST");
  });

  it("go to 12A headrest, in any case, focuses HEADREST", () => {
    expect(goTo("12A headrest")).toHaveBeenCalledWith("SEAT:12A", "HEADREST");
    expect(goTo("12a Headrest")).toHaveBeenCalledWith("SEAT:12A", "HEADREST");
    expect(goTo("seat 12A seat belt")).toHaveBeenCalledWith("SEAT:12A", "SEATBELT");
  });

  it("go to L-04 latch focuses BIN_LATCH", () => {
    expect(goTo("L-04 latch")).toHaveBeenCalledWith("BIN:L-04", "BIN_LATCH");
    expect(goTo("l4 latch striker")).toHaveBeenCalledWith("BIN:L-04", "BIN_STRIKER");
  });

  it("12AB and armrest 12A 12B select ARMREST:12-AB", () => {
    expect(goTo("12AB")).toHaveBeenCalledWith("ARMREST:12-AB", null);
    expect(goTo("armrest 12A 12B")).toHaveBeenCalledWith("ARMREST:12-AB", null);
    expect(goTo("12B 12A armrest")).toHaveBeenCalledWith("ARMREST:12-AB", null);
  });

  it("locations still go by code, id and label", () => {
    expect(goTo("3A")).toHaveBeenCalledWith("SEAT:3A", null);
    expect(goTo("FWD")).toHaveBeenCalledWith("FLOOR:FWD", null);
    expect(goTo("Overhead bin L-04")).toHaveBeenCalledWith("BIN:L-04", null);
    expect(goTo("Full cabin floor")).toHaveBeenCalledWith("FLOOR:FULL-CABIN", null);
  });

  it("a piece word that matches nothing there still selects the location and says so", () => {
    const onSelect = vi.fn();
    render(<CabinMap workspace={workspace} flags={new Map()} selection={null} onSelect={onSelect} />);
    const input = screen.getByLabelText("Go to location");
    fireEvent.change(input, { target: { value: "12A wing" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSelect).toHaveBeenCalledWith("SEAT:12A", null);
    expect(screen.getByRole("status")).toHaveTextContent('Selected Seat 12A. No piece there matches "wing".');
  });

  it("the suggestions list the pieces of the selected location only, and each one goes back to that piece", () => {
    for (const locationId of ["SEAT:12A", "BIN:L-04"]) {
      const location = workspace.layout.locations.find((l) => l.id === locationId);
      const { container, unmount } = render(<CabinMap workspace={workspace} flags={new Map()} selection={locationId} onSelect={vi.fn()} />);
      const values = [...container.querySelectorAll("#goto-options option")].map((o) => o.getAttribute("value") ?? "");
      unmount();
      const pieces = values.slice(workspace.layout.locations.length);
      expect(values.length).toBe(workspace.layout.locations.length + (location?.componentIds.length ?? 0));
      expect(pieces.map((v) => goTo(v, locationId).mock.calls[0])).toEqual(location?.componentIds.map((c) => [locationId, c]));
    }
  });
});

const MEL_C: MelClass = { class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Seat blocked and placarded INOP" };
const problem = (locationId: string, componentId: string, over: Partial<Observation> = {}): Observation => ({
  id: `OBS-${locationId}-${componentId}`,
  tail: "N100TL",
  status: "OPEN",
  version: 1,
  melClass: { class: "COSMETIC" },
  dueDate: null,
  blocksSeat: false,
  openedInVisitId: "visit-1",
  closedInVisitId: null,
  closedAs: null,
  locationLabel: locationId,
  componentName: componentId,
  createdAt: "2026-11-12T12:02:00.000Z",
  updatedAt: "2026-11-12T12:02:00.000Z",
  locationId,
  componentId,
  condition: "STAINED",
  note: "",
  outcome: "NOTED",
  ...over,
});
const showMap = (ws: Workspace, selection: string | null, onSelect = vi.fn()) => {
  const view = render(<CabinMap workspace={ws} flags={buildStates(ws).flags} selection={selection} onSelect={onSelect} />);
  return { ...view, onSelect };
};

describe("CabinMap armrests, pieces and statuses", () => {
  it("armrest 12-AB is a button between 12A and 12B", () => {
    const { container } = showMap(workspace, null);
    const armrest = screen.getByRole("button", { name: "Armrest between 12A and 12B" });
    expect(armrest).toBe(container.querySelector('[data-location="ARMREST:12-AB"]'));
    const before = container.querySelector('[data-seat="12A"]') as Element;
    const after = container.querySelector('[data-seat="12B"]') as Element;
    expect(before.compareDocumentPosition(armrest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(armrest.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(armrest);
  });

  it("clicking an armrest selects it with no piece", () => {
    const { onSelect } = showMap(workspace, null);
    fireEvent.click(screen.getByRole("button", { name: "Armrest between 12A and 12B" }));
    expect(onSelect).toHaveBeenCalledWith("ARMREST:12-AB", null);
  });

  it("selecting 12A lists its seven pieces and the life vest is selectable", () => {
    const { container, onSelect } = showMap(workspace, "SEAT:12A");
    const list = screen.getByRole("region", { name: "Pieces at Seat 12A" });
    const pieces = [...list.querySelectorAll("button[data-component]")];
    expect(pieces.map((b) => b.getAttribute("data-component"))).toHaveLength(7);
    expect(container.querySelector('[data-seat="12A"]')?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(list).getByRole("button", { name: /life vest/i }));
    expect(onSelect).toHaveBeenCalledWith("SEAT:12A", "LIFE_VEST");
  });

  it("a seat's own armrests are reachable from its piece list", () => {
    const { onSelect } = showMap(workspace, "SEAT:12A");
    const list = screen.getByRole("region", { name: "Pieces at Seat 12A" });
    fireEvent.click(within(list).getByRole("button", { name: "Armrest between 12A and 12B, next to this seat" }));
    expect(onSelect).toHaveBeenCalledWith("ARMREST:12-AB", null);
  });

  it("a bin lists its inner pieces by type", () => {
    const bin = workspace.layout.locations.find((l) => l.id === "BIN:L-04");
    const { onSelect } = showMap(workspace, "BIN:L-04");
    const list = screen.getByRole("region", { name: `Pieces at ${bin?.label}` });
    const ids = [...list.querySelectorAll("button[data-component]")].map((b) => b.getAttribute("data-component"));
    expect(ids).toEqual(bin?.componentIds);
    expect(list).toHaveTextContent(`${bin?.bin?.capacityBags} bags`);
    fireEvent.click(list.querySelector('[data-component="BIN_LATCH"]') as Element);
    expect(onSelect).toHaveBeenCalledWith("BIN:L-04", "BIN_LATCH");
    expect(screen.getByText(/^L-04 · rows \d+-\d+ · \d+ bags$/)).toBeInTheDocument();
  });

  it("a mustFix piece shows the Must fix badge text", () => {
    const ws = { ...workspace, observations: [problem("SEAT:3A", "CUSHION", { outcome: "MUST_FIX", melClass: MEL_C })] };
    const { container } = showMap(ws, "SEAT:3A");
    const piece = within(screen.getByRole("region", { name: "Pieces at Seat 3A" })).getByRole("button", { name: /cushion/i });
    expect(piece).toHaveTextContent("Must fix");
    expect(container.querySelector('[data-seat="3A"]')?.getAttribute("aria-label")).toContain("Must fix");
    expect(piece.querySelector("svg")?.getAttribute("data-glyph")).toBe("alert");
  });

  it("Deferred, Carried and Noted badges read as words", () => {
    const deferral = problem("SEAT:3A", "SEATBELT", { outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-22", condition: "WORN" });
    const carried = {
      observation: {
        ...problem("SEAT:3A", "HEADREST", { outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-22", condition: "WORN" }),
        openedInVisitId: "visit-0",
      },
      placement: "SAME" as const,
      locationId: "SEAT:3A",
      overdue: false,
    };
    const ws = { ...workspace, observations: [deferral, problem("SEAT:3A", "CUSHION")], carried: [carried] };
    showMap(ws, "SEAT:3A");
    const list = screen.getByRole("region", { name: "Pieces at Seat 3A" });
    expect(within(list).getByRole("button", { name: /seat belt/i })).toHaveTextContent("Deferred");
    expect(within(list).getByRole("button", { name: /headrest/i })).toHaveTextContent("Carried");
    expect(within(list).getByRole("button", { name: /cushion/i })).toHaveTextContent("Noted");
  });

  it("a blocked seat shows Blocked", () => {
    const belt = problem("SEAT:3A", "SEATBELT", { condition: "BROKEN", outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-22", blocksSeat: true });
    const ws = { ...workspace, observations: [belt] };
    const { container } = showMap(ws, "SEAT:3A");
    expect(within(screen.getByRole("region", { name: "Pieces at Seat 3A" })).getByText("Blocked")).toBeInTheDocument();
    expect(container.querySelector('[data-seat="3A"]')?.getAttribute("aria-label")).toContain("Blocked");
    expect(container.querySelector('[data-seat="3B"]')?.getAttribute("aria-label")).not.toContain("Blocked");
  });
});
