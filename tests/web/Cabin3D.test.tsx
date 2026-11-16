import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Cabin3D } from "../../src/web/components/Cabin3D.tsx";
import { Viewer } from "../../src/web/components/Viewer.tsx";
import { buildStates, type Workspace } from "../../src/web/model.ts";
import { at, fixtureRelease } from "../helpers.ts";

// jsdom has no WebGL: the scene is a recording stand-in, so these tests see exactly which scene methods the component calls.
const scenes = vi.hoisted(() => ({ constructed: 0, calls: [] as { name: string; args: unknown[] }[] }));
vi.mock("../../src/web/scene/CabinScene.ts", () => ({
  CabinScene: class {
    constructor() {
      scenes.constructed += 1;
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in that records every method call
      return new Proxy(
        {},
        {
          get:
            (_target, name) =>
            (...args: unknown[]) => {
              scenes.calls.push({ name: String(name), args });
            },
        },
      );
    }
  },
}));

const calls = (name: string) => scenes.calls.filter((c) => c.name === name);

const release = fixtureRelease();
const layout = at(release.layoutRevisions, 0);
const workspace: Workspace = {
  mode: "explore",
  layout,
  resolution: null,
  componentDefs: {},
  records: [],
  editable: false,
  unresolvedReason: null,
};

beforeEach(() => {
  scenes.constructed = 0;
  scenes.calls = [];
});

function renderCabin(ws: Workspace) {
  const props = { states: buildStates(ws).scene, selection: null, onSelect: vi.fn(), visualProfiles: [], onFailed: vi.fn() };
  const view = render(<Cabin3D workspace={ws} {...props} />);
  return { ...view, rerenderWith: (next: Workspace) => view.rerender(<Cabin3D workspace={next} {...props} states={buildStates(next).scene} />) };
}

async function ready() {
  await waitFor(() => expect(document.querySelector("canvas")).toHaveAttribute("data-ready", "true"));
}

test("a save that returns a new layout object with the same id does not call setLayout again", async () => {
  const { rerenderWith } = renderCabin(workspace);
  await ready();
  expect(calls("setLayout")).toHaveLength(1);
  const statesBefore = calls("setStates").length;
  rerenderWith(structuredClone(workspace));
  rerenderWith(structuredClone(workspace));
  expect(calls("setLayout")).toHaveLength(1);
  // the new records still reach the scene
  expect(calls("setStates").length).toBeGreaterThan(statesBefore);
});

test("a layout with a different id is set on the scene", async () => {
  const { rerenderWith } = renderCabin(workspace);
  await ready();
  rerenderWith({ ...workspace, layout: { ...layout, id: `${layout.id}-other` } });
  expect(calls("setLayout")).toHaveLength(2);
});

test("switching to Map and back keeps one scene instance", async () => {
  render(<Viewer workspace={workspace} selection={null} onSelect={vi.fn()} visualProfiles={[]} />);
  await ready();
  scenes.calls = [];
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Map and list" })));
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "3D cutaway" })));
  expect(scenes.constructed).toBe(1);
  expect(calls("dispose")).toHaveLength(0);
  expect(calls("setLayout")).toHaveLength(0);
  expect(calls("setPaused").map((c) => c.args[0])).toEqual([true, false]);
});

test("Cmd+= on the focused canvas is not prevented", async () => {
  renderCabin(workspace);
  await ready();
  const canvas = document.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  canvas.focus();
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    expect(fireEvent.keyDown(canvas, { key: "=", ...modifier })).toBe(true);
    expect(fireEvent.keyDown(canvas, { key: "ArrowLeft", ...modifier })).toBe(true);
  }
  expect(calls("nudge")).toHaveLength(0);
  // without a modifier the key still drives the camera
  expect(fireEvent.keyDown(canvas, { key: "=" })).toBe(false);
  expect(calls("nudge").map((c) => c.args[0])).toEqual(["in"]);
});
