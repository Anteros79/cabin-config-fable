import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Cabin3D, hoverLabelPosition, WHEEL_HINT, WHEEL_HINT_MS } from "../../src/web/components/Cabin3D.tsx";
import { Viewer } from "../../src/web/components/Viewer.tsx";
import { buildStates, type Workspace } from "../../src/web/model.ts";
import type { SceneCallbacks } from "../../src/web/scene/CabinScene.ts";
import { at, fixtureRelease } from "../helpers.ts";
import { styleFile } from "./css.ts";

// jsdom has no WebGL: the scene is a recording stand-in, so these tests see exactly which scene methods the component calls.
const scenes = vi.hoisted(() => ({ constructed: 0, calls: [] as { name: string; args: unknown[] }[], callbacks: null as unknown }));
vi.mock("../../src/web/scene/CabinScene.ts", () => ({
  CabinScene: class {
    constructor(_canvas: unknown, callbacks: unknown) {
      scenes.constructed += 1;
      scenes.callbacks = callbacks;
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
  scenes.callbacks = null;
  sessionStorage.clear();
});

const callbacks = () => scenes.callbacks as SceneCallbacks;

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
  // the first layout is set in an effect after the canvas reports ready; wait for it before counting
  await waitFor(() => expect(calls("setLayout")).toHaveLength(1));
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

test("the hover label sits 14 px right of and below the pointer, flips near an edge and stays inside the canvas", () => {
  const label = { width: 80, height: 20 };
  const wrap = { width: 400, height: 300 };
  expect(hoverLabelPosition({ x: 100, y: 50 }, label, wrap)).toEqual({ left: 114, top: 64 });
  // near the right and bottom edges it goes to the left of and above the pointer
  expect(hoverLabelPosition({ x: 390, y: 295 }, label, wrap)).toEqual({ left: 296, top: 261 });
  // a label wider than the room left on either side is clamped inside the wrap
  expect(hoverLabelPosition({ x: 60, y: 10 }, { width: 380, height: 20 }, wrap)).toEqual({ left: 16, top: 24 });
});

function renderSelectable(paused = false) {
  const onSelect = vi.fn();
  const props = { workspace, states: buildStates(workspace).scene, onSelect, visualProfiles: [], onFailed: vi.fn() };
  const view = render(<Cabin3D {...props} selection={null} paused={paused} />);
  return {
    onSelect,
    select: (selection: string | null, nowPaused = paused) => view.rerender(<Cabin3D {...props} selection={selection} paused={nowPaused} />),
  };
}

test("a location selected outside the canvas while the 3D view shows is brought into view; a pick in the canvas is not", async () => {
  const { select, onSelect } = renderSelectable();
  await ready();
  // selected in the map, list, work list or go-to
  select("SEAT:7C");
  expect(calls("revealLocation").map((c) => c.args[0])).toEqual(["SEAT:7C"]);
  // picked in the canvas: the parent selects it, and the camera stays
  act(() => callbacks().onPick("SEAT:9D", "CUSHION"));
  expect(onSelect).toHaveBeenCalledWith("SEAT:9D", "CUSHION");
  select("SEAT:9D");
  expect(calls("setSelection").at(-1)?.args).toEqual(["SEAT:9D"]);
  expect(calls("revealLocation")).toHaveLength(1);
  // the next selection from outside moves it again
  select("SEAT:2A");
  expect(calls("revealLocation").map((c) => c.args[0])).toEqual(["SEAT:7C", "SEAT:2A"]);
  // clearing the selection moves nothing
  select(null);
  expect(calls("revealLocation")).toHaveLength(2);
});

test("a selection made while the 3D view is hidden, or already there when it starts, does not move the camera", async () => {
  const onSelect = vi.fn();
  const props = { workspace, states: buildStates(workspace).scene, onSelect, visualProfiles: [], onFailed: vi.fn() };
  const view = render(<Cabin3D {...props} selection="SEAT:7C" />);
  await ready();
  expect(calls("setSelection").at(-1)?.args).toEqual(["SEAT:7C"]);
  view.rerender(<Cabin3D {...props} selection="SEAT:9D" paused />);
  view.rerender(<Cabin3D {...props} selection="SEAT:9D" />);
  expect(calls("revealLocation")).toHaveLength(0);
});

test("the wheel hint shows for 2 s the first time the wheel scrolls past the view, and not again in the session", async () => {
  renderCabin(workspace);
  await ready();
  // the live region is there before the hint, so its text is announced when set
  const region = screen.getByRole("status");
  expect(region).toBeEmptyDOMElement();
  vi.useFakeTimers();
  try {
    act(() => callbacks().onWheelPassedThrough?.());
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent(WHEEL_HINT);
    expect(WHEEL_HINT).toBe("Click the view, then scroll to zoom");
    act(() => vi.advanceTimersByTime(WHEEL_HINT_MS - 1));
    expect(screen.queryByText(WHEEL_HINT)).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(region).toBeEmptyDOMElement();
    act(() => callbacks().onWheelPassedThrough?.());
    expect(screen.queryByText(WHEEL_HINT)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("the canvas lets a vertical touch drag scroll the page", () => {
  const css = styleFile("viewer.css");
  const rule = /\.canvas-wrap canvas \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/touch-action:\s*pan-y;/);
});
