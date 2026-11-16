import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

afterEach(() => cleanup());

// jsdom implements neither window.confirm nor the dialog methods; tests that need them override these.
beforeEach(() => {
  // A prompt nobody expected fails the test; a test that expects one stubs its own answer.
  vi.stubGlobal(
    "confirm",
    vi.fn((message?: string) => {
      throw new Error(`Unexpected window.confirm: ${message}`);
    }),
  );
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
