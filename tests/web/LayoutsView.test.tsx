import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutDetail } from "../../src/web/api.ts";
import { LayoutsView } from "../../src/web/views/LayoutsView.tsx";
import { at, fixtureRelease } from "../helpers.ts";
import { type Answer, deferred, stubFetch } from "./fetchStub.ts";

vi.mock("../../src/web/components/Viewer.tsx", () => ({ Viewer: () => <p>3D view</p> }));

const release = fixtureRelease();
const detailOf = (index: number): LayoutDetail => ({
  releaseId: release.id,
  layoutRevision: at(release.layoutRevisions, index),
  source: null,
  categories: [],
  components: release.components,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LayoutsView", () => {
  it("a late answer for the previous layout is not shown under the next one", async () => {
    const first = detailOf(0);
    const second = detailOf(1);
    const slow = deferred<{ body: unknown }>();
    stubFetch((_method, url): Answer => (url === `/api/layouts/${encodeURIComponent(first.layoutRevision.id)}` ? slow.promise : { body: second }));
    const view = render(<LayoutsView layoutId={first.layoutRevision.id} visualProfiles={[]} />);
    view.rerender(<LayoutsView layoutId={second.layoutRevision.id} visualProfiles={[]} />);
    await screen.findByRole("heading", { name: second.layoutRevision.name });
    slow.resolve({ body: first });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: second.layoutRevision.name })).toBeInTheDocument();
  });
});
