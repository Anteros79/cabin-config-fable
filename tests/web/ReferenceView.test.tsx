import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceView } from "../../src/web/views/ReferenceView.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReferenceView", () => {
  it("leaving the screen cancels the reference request", () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>(() => undefined);
      }),
    );
    const view = render(<ReferenceView />);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });
});
