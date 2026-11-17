import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { submitOnEnter } from "../../src/web/submitOnEnter.ts";

function Form({ onSubmit, withList = true }: { onSubmit(): void; withList?: boolean }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="where">Where</label>
      <input id="where" list={withList ? "where-options" : undefined} onKeyDown={submitOnEnter} />
      {withList && (
        <datalist id="where-options">
          <option value="3A">Seat 3A</option>
          <option value="L-01">Lavatory 1</option>
        </datalist>
      )}
    </form>
  );
}

describe("submitOnEnter", () => {
  it.each(["3A", "3a", "  l-01 "])("an exact suggestion match (%j, any case) submits once and cancels the browser's Enter", (value) => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Where");
    fireEvent.change(input, { target: { value } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // WebKit uses this Enter to accept the highlighted suggestion; cancelling it would submit the typed text instead (N1).
  it("a partial text leaves Enter to the browser", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Where");
    fireEvent.change(input, { target: { value: "3" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("an input without a suggestion list leaves Enter to the browser", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} withList={false} />);
    const input = screen.getByLabelText("Where");
    fireEvent.change(input, { target: { value: "3A" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("an input method's Enter is left alone", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Where");
    fireEvent.change(input, { target: { value: "3A" } });
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("other keys are left alone", () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Where");
    fireEvent.change(input, { target: { value: "3A" } });
    expect(fireEvent.keyDown(input, { key: "a" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
