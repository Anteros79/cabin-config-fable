import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  // the first layout is set in an effect after the canvas reports ready; under load it can trail the attribute
  await waitFor(() => expect(calls("setLayout")).toHaveLength(1));
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
  // like the first layout, the first selection is applied in an effect that can trail the ready attribute under load
  await waitFor(() => expect(calls("setSelection").at(-1)?.args).toEqual(["SEAT:7C"]));
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

describe("the 3D toolbar", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("groups each have a visible label: View holds the five presets, Layers holds toggle buttons", async () => {
    renderCabin(workspace);
    await ready();
    const view = screen.getByRole("group", { name: "View" });
    expect(within(view).getByText("View")).toBeVisible();
    for (const name of ["Cutaway", "Overhead", "Aisle", "Focus", "Focus rear"]) expect(within(view).getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(within(view).getByRole("button", { name: "Overhead" }));
    expect(calls("setCamera").at(-1)?.args[0]).toBe("overhead");

    const layers = screen.getByRole("group", { name: "Layers" });
    const context = within(layers).getByRole("button", { name: "Context (walls)" });
    expect(context).toHaveAttribute("aria-pressed", "false");
    expect(within(layers).getByRole("button", { name: "Seats" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(context);
    expect(context).toHaveAttribute("aria-pressed", "true");
    expect(calls("setLayers").at(-1)?.args[0]).toMatchObject({ context: true });
    expect(screen.getByRole("group", { name: "Light and style" })).toBeInTheDocument();
  });

  test("the six nudge buttons sit in a Move camera disclosure and stay reachable", async () => {
    renderCabin(workspace);
    await ready();
    const disclosure = screen.getByRole("button", { name: "Move camera" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Rotate left" })).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(disclosure.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    for (const name of ["Rotate left", "Rotate right", "Tilt up", "Tilt down", "Zoom in", "Zoom out"])
      expect(within(panel as HTMLElement).getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    expect(calls("nudge").map((c) => c.args[0])).toEqual(["left"]);
  });

  test("on a narrow screen Light and style is one disclosure", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(max-width: 699px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderCabin(workspace);
    await ready();
    const disclosure = screen.getByRole("button", { name: "Light and style" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox", { name: "Light" })).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole("combobox", { name: "Light" })).toBeInTheDocument();
  });

  test("the first-use hint shows until Got it is pressed once", async () => {
    const first = renderCabin(workspace);
    await ready();
    expect(screen.getByText("Drag to orbit · Pinch or Ctrl+scroll to zoom · Click a seat to select")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/^Drag to orbit ·/)).toBeNull();
    expect(localStorage.getItem("cabin-kit.hint.3d")).not.toBeNull();
    first.unmount();
    renderCabin(workspace);
    await ready();
    expect(screen.queryByText(/^Drag to orbit ·/)).toBeNull();
  });
});
