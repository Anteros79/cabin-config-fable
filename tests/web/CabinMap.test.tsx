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
