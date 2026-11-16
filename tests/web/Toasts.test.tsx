import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../../src/web/components/Toasts.tsx";

type Show = ReturnType<typeof useToast>["show"];
let show: Show;
function Grab() {
  show = useToast().show;
  return (
    <button type="button" data-testid="elsewhere">
      Elsewhere
    </button>
  );
}
const setup = () => render(<ToastProvider>{<Grab />}</ToastProvider>);
const region = () => screen.getByRole("status", { name: "Notifications" });
const messages = () =>
  within(region())
    .queryAllByRole("listitem")
    .map((li) => li.querySelector(".toast-message")?.textContent);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Toasts", () => {
  it("shows a message in the polite status region without moving focus", () => {
    setup();
    const elsewhere = screen.getByTestId("elsewhere");
    elsewhere.focus();
    act(() => show("Removed Seat 3A / Seat cushion."));
    expect(messages()).toEqual(["Removed Seat 3A / Seat cushion."]);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(elsewhere).toHaveFocus();
  });

  it("goes after 5 s, or 8 s when it has an action", () => {
    setup();
    act(() => show("Plain"));
    act(() => show("With action", { action: { label: "Undo", run: () => undefined } }));
    act(() => vi.advanceTimersByTime(4999));
    expect(messages()).toEqual(["Plain", "With action"]);
    act(() => vi.advanceTimersByTime(1));
    expect(messages()).toEqual(["With action"]);
    act(() => vi.advanceTimersByTime(3000));
    expect(messages()).toEqual([]);
  });

  it("the action runs once and closes the toast; the close button closes it too", () => {
    setup();
    const run = vi.fn();
    act(() => show("Removed", { action: { label: "Undo", run } }));
    act(() => show("Other"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(messages()).toEqual(["Other"]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: Other" }));
    expect(messages()).toEqual([]);
  });

  it("shows at most three; a fourth replaces the oldest", () => {
    setup();
    act(() => {
      show("one");
      show("two");
      show("three");
      show("four");
    });
    expect(messages()).toEqual(["two", "three", "four"]);
  });

  it("pauses while focus is inside, and resumes with the time that was left", () => {
    setup();
    act(() => show("Removed", { action: { label: "Undo", run: () => undefined } }));
    act(() => vi.advanceTimersByTime(6000));
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(messages()).toEqual(["Removed"]);
    act(() => screen.getByTestId("elsewhere").focus());
    act(() => vi.advanceTimersByTime(1999));
    expect(messages()).toEqual(["Removed"]);
    act(() => vi.advanceTimersByTime(1));
    expect(messages()).toEqual([]);
  });

  it("pauses while the pointer is over it", () => {
    setup();
    act(() => show("Saved"));
    fireEvent.mouseEnter(region());
    act(() => vi.advanceTimersByTime(60_000));
    expect(messages()).toEqual(["Saved"]);
    fireEvent.mouseLeave(region());
    act(() => vi.advanceTimersByTime(5000));
    expect(messages()).toEqual([]);
  });

  it("closing the toast that holds focus hands focus to main content, not to the page body", () => {
    render(
      <>
        <main id="main" tabIndex={-1}>
          content
        </main>
        <ToastProvider>
          <Grab />
        </ToastProvider>
      </>,
    );
    act(() => show("Removed", { action: { label: "Undo", run: () => undefined } }));
    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    fireEvent.click(undo);
    expect(document.getElementById("main")).toHaveFocus();
  });

  it("without a provider, show does nothing (a view rendered on its own)", () => {
    render(<Grab />);
    expect(() => show("nobody listens")).not.toThrow();
  });
});
