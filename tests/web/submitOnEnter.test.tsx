import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { forgetSuggestionKeys, submitOnEnter } from "../../src/web/submitOnEnter.ts";

function Form({ onSubmit }: { onSubmit(): void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="where">Where</label>
      <input id="where" list="where-options" onKeyDown={submitOnEnter} onInput={forgetSuggestionKeys} />
      <datalist id="where-options">
        <option value="3A">Seat 3A</option>
        <option value="L-01">Overhead bin L-01</option>
      </datalist>
    </form>
  );
}

function setup() {
  const onSubmit = vi.fn();
  render(<Form onSubmit={onSubmit} />);
  const input = screen.getByLabelText("Where");
  const type = (value: string) => fireEvent.input(input, { target: { value } });
  return { onSubmit, input, type };
}

describe("submitOnEnter", () => {
  // WebKit's suggestion picker takes the first Enter for a text matching a suggestion's value or label (N1).
  it.each(["3A", "Overhead bin L-01", "3"])("typed text (%j) then Enter submits once and cancels the browser's Enter", (value) => {
    const { onSubmit, input, type } = setup();
    type(value);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // After the arrow keys a suggestion may be highlighted: WebKit's Enter accepts it, so that Enter is left alone.
  it.each(["ArrowDown", "ArrowUp"])("%s then Enter leaves Enter to the browser", (key) => {
    const { onSubmit, input, type } = setup();
    type("3");
    fireEvent.keyDown(input, { key });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ArrowDown, then typing, then Enter submits", () => {
    const { onSubmit, input, type } = setup();
    type("3");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    type("3A");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("an input method's Enter is left alone, whether it reports isComposing or keyCode 229 (Safari)", () => {
    const { onSubmit, input, type } = setup();
    type("3A");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("other keys are left alone", () => {
    const { onSubmit, input, type } = setup();
    type("3A");
    expect(fireEvent.keyDown(input, { key: "a" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
