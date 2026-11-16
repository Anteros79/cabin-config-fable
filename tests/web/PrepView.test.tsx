import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreparation } from "../../src/domain/prep.ts";
import { PrepView } from "../../src/web/views/PrepView.tsx";
import { fixtureRelease, snapshotFor } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

const release = fixtureRelease();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrepView", () => {
  it("a late answer for the previous lookup is not shown under the next one", async () => {
    const first = buildPreparation(snapshotFor(release, "N100TL", "2026-11-12"));
    const second = buildPreparation(snapshotFor(release, "N200TL", "2026-06-30"));
    const slow = deferred<{ body: unknown }>();
    stubFetch((_method, url): Answer => (url.includes("tail=N100TL") ? slow.promise : { body: second }));
    const view = render(<PrepView visitId={null} tail="N100TL" date="2026-11-12" />);
    view.rerender(<PrepView visitId={null} tail="N200TL" date="2026-06-30" />);
    await screen.findByRole("heading", { name: /N200TL · 2026-06-30/ });
    slow.resolve({ body: first });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: /N200TL · 2026-06-30/ })).toBeInTheDocument();
  });
});
