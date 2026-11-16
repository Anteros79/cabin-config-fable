import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceView } from "../../src/web/views/ReferenceView.tsx";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReferenceView", () => {
  it("leaving the screen cancels the reference request", () => {
    const never = deferred<{ body: unknown }>();
    const sent = stubFetch((): Answer => never.promise);
    const view = render(<ReferenceView />);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.signal?.aborted).toBe(false);
    view.unmount();
    expect(sent[0]?.signal?.aborted).toBe(true);
  });
});
