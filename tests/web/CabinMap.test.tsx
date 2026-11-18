import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CabinMap } from "../../src/web/components/CabinMap.tsx";
import type { Workspace } from "../../src/web/model.ts";
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
