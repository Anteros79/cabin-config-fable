import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Cabin3D, hoverLabelPosition, WHEEL_HINT, WHEEL_HINT_MS } from "../../src/web/components/Cabin3D.tsx";
import { Viewer } from "../../src/web/components/Viewer.tsx";
import { buildStates, type Workspace } from "../../src/web/model.ts";
import type { SceneCallbacks } from "../../src/web/scene/CabinScene.ts";
import { poseToFrame } from "../../src/web/scene/cameraRig.ts";
import { setGhosted } from "../../src/web/scene/materials.ts";
import {
  BIN_FLOOR_TOP,
  BIN_OPEN_MS,
  BIN_OPENING,
  BinRun,
  binOpenMatrix,
  buildBinGeometry,
  buildPieceMeshes,
  buildSeatGeometries,
  openBottomEdge,
  pickPiece,
  pieceTargets,
  type SeatPart,
} from "../../src/web/scene/seatParts.ts";
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
  observations: [],
  carried: [],
  checkDate: "2026-11-12",
  mel: [],
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

describe("picking the pieces of a seat", () => {
  // The scene's own instanced meshes, built without a renderer: three raycasts them in jsdom as it does in the browser.
  const geoms = buildSeatGeometries();
  const pieces = buildPieceMeshes(layout, geoms, new THREE.MeshBasicMaterial());
  const place = (id: string) => {
    const p = layout.locations.find((l) => l.id === id)?.placement;
    if (!p) throw new Error(`no ${id} in the layout`);
    return new THREE.Vector3(p.x, 0, p.z);
  };
  /** The centre of a part's shape, placed at a location (in that location's own frame: seat or armrest). */
  const centreOf = (part: Exclude<SeatPart, "wings">, at: string) => {
    const geometry = geoms[part === "armPads" ? "armPad" : part];
    geometry.computeBoundingBox();
    return (geometry.boundingBox ?? new THREE.Box3()).getCenter(new THREE.Vector3()).add(place(at));
  };
  const pick = (from: THREE.Vector3, towards: THREE.Vector3, layers = { seats: true, underSeat: false }) => {
    const ray = new THREE.Raycaster(from, towards.clone().sub(from).normalize());
    const hit = pickPiece(ray.intersectObjects(pieceTargets(pieces, layers), false), pieces);
    return hit && { location: hit.location.id, component: hit.component };
  };

  test("a hit on the tray behind 11A selects SEAT:12A TRAY", () => {
    const tray = centreOf("tray", "SEAT:11A");
    // from the gap between the rows, looking forward at the back of 11A
    expect(pick(tray.clone().add(new THREE.Vector3(0.3, 0, 0)), tray)).toEqual({ location: "SEAT:12A", component: "TRAY" });
    const net = centreOf("net", "SEAT:11A");
    expect(pick(net.clone().add(new THREE.Vector3(0.3, 0, 0)), net)).toEqual({ location: "SEAT:12A", component: "SEATBACK_NET" });
    // the back itself still belongs to 11A
    expect(
      pick(new THREE.Vector3(place("SEAT:11A").x + 0.7, 1.0, place("SEAT:11A").z), new THREE.Vector3(place("SEAT:11A").x, 1.0, place("SEAT:11A").z)),
    ).toEqual({
      location: "SEAT:11A",
      component: "BACKREST",
    });
  });

  test("row 1 has its tray on the bulkhead panel ahead of it, and a seat with no seat behind draws none", () => {
    const tray = pieces.find((p) => p.part === "tray");
    if (!tray) throw new Error("no tray mesh");
    const owners = tray.locations.map((l) => l?.id);
    // every seat with a seat directly aft, plus the row-1 seats on the bulkhead
    expect(owners.filter((id) => id?.match(/^SEAT:1[A-F]$/))).toHaveLength(6);
    // S176 (30 rows, 14B, 14E, 15B and 15E omitted): A, C, D and F carry 29 trays each, B and E 26 each (none on 13,
    // 14 or 15), plus the six on the bulkhead
    expect(tray.locations).toHaveLength(4 * 29 + 2 * 26 + 6);
    // 16B and 16E sit behind omitted seats and are not in the first row: no tray of theirs is drawn
    expect(owners).not.toContain("SEAT:16B");
    expect(owners).not.toContain("SEAT:16E");
    // nothing is drawn on the back of a seat with no seat behind it: the last row, and 13B and 13E ahead of the gap
    const lastRow = Math.max(...layout.locations.map((l) => l.seat?.physicalRow ?? 0));
    expect(lastRow).toBe(30);
    const carriersOf = (part: "tray" | "net") => {
      const piece = pieces.find((p) => p.part === part);
      if (!piece) throw new Error(`no ${part} mesh`);
      const at = piece.matrices.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
      return layout.locations.filter((l) => l.kind === "SEAT" && at.some((v) => Math.abs(v.x - l.placement.x) < 1e-6 && Math.abs(v.z - l.placement.z) < 1e-6));
    };
    for (const part of ["tray", "net"] as const) {
      const on = carriersOf(part).map((l) => l.id);
      expect(
        on.filter((id) => id === "SEAT:13B" || id === "SEAT:13E"),
        part,
      ).toEqual([]);
      expect(
        carriersOf(part).filter((l) => l.seat?.physicalRow === lastRow),
        part,
      ).toEqual([]);
      expect(on, part).toHaveLength(4 * 29 + 2 * 26);
    }
    expect(pieces.panels).toHaveLength(6);
    const ahead = centreOf("tray", "SEAT:1C").sub(new THREE.Vector3(layout.geometry.rowPitch, 0, 0));
    expect(pick(ahead.clone().add(new THREE.Vector3(0.3, 0, 0)), ahead)).toEqual({ location: "SEAT:1C", component: "TRAY" });
  });

  test("the life vest is not pickable until Under seat is on", () => {
    const vest = centreOf("vest", "SEAT:12A");
    const from = vest.clone().add(new THREE.Vector3(-0.45, 0, 0));
    expect(pick(from, vest)?.component).not.toBe("LIFE_VEST");
    expect(pick(from, vest, { seats: true, underSeat: true })).toEqual({ location: "SEAT:12A", component: "LIFE_VEST" });
    expect(pick(from, vest, { seats: false, underSeat: true })).toBeNull();
  });

  test("an armrest pad selects ARMREST:12-AB", () => {
    const pad = centreOf("armPads", "ARMREST:12-AB");
    expect(pick(pad.clone().setY(1.5), pad)).toEqual({ location: "ARMREST:12-AB", component: "ARMREST" });
    // one pad per armrest location, not two per seat
    expect(pieces.find((p) => p.part === "armPads")?.locations).toHaveLength(layout.locations.filter((l) => l.kind === "ARMREST").length);
  });

  test("the headrest, the cushion and the belt are their own pieces", () => {
    const head = centreOf("headrest", "SEAT:12A");
    expect(pick(head.clone().add(new THREE.Vector3(-0.6, 0, 0)), head)).toEqual({ location: "SEAT:12A", component: "HEADREST" });
    const belt = centreOf("belt", "SEAT:12A");
    expect(
      pick(
        belt
          .clone()
          .setY(1.0)
          .add(new THREE.Vector3(-0.3, 0, 0)),
        belt,
      ),
    ).toEqual({ location: "SEAT:12A", component: "SEATBELT" });
    // the point the e2e build aims at for the cushion (screenPointOf "pan") is the cushion, not the belt
    const pan = place("SEAT:12A").add(new THREE.Vector3(-0.1, 0.52, 0));
    expect(pick(pan.clone().setY(3), pan)).toEqual({ location: "SEAT:12A", component: "CUSHION" });
  });
});

test("on a layout stored before the pieces, a pick only ever selects a piece the location lists", () => {
  // as in a visit store from 5d6679d: seats list CUSHION and BACKREST only, and there are no armrest locations
  const old = structuredClone(layout);
  old.locations = old.locations.filter((l) => l.kind !== "ARMREST").map((l) => (l.kind === "SEAT" ? { ...l, componentIds: ["CUSHION", "BACKREST"] } : l));
  const geoms = buildSeatGeometries();
  const pieces = buildPieceMeshes(old, geoms, new THREE.MeshBasicMaterial());
  for (const piece of pieces)
    piece.components.forEach((c, i) => {
      if (c !== null) expect(piece.locations[i]?.componentIds, `${piece.part} ${i}`).toContain(c);
    });
  const at = (part: "tray" | "headrest", id: string) => {
    const p = old.locations.find((l) => l.id === id)?.placement;
    geoms[part].computeBoundingBox();
    return (geoms[part].boundingBox ?? new THREE.Box3()).getCenter(new THREE.Vector3()).add(new THREE.Vector3(p?.x, 0, p?.z));
  };
  const pick = (from: THREE.Vector3, to: THREE.Vector3) => {
    const hit = pickPiece(
      new THREE.Raycaster(from, to.clone().sub(from).normalize()).intersectObjects(pieceTargets(pieces, { seats: true, underSeat: true }), false),
      pieces,
    );
    return hit && { location: hit.location.id, component: hit.component };
  };
  // the headrest is part of the backrest, as before; the slab on the back of 11A is 11A's backrest
  const head = at("headrest", "SEAT:12A");
  expect(pick(head.clone().add(new THREE.Vector3(-0.6, 0, 0)), head)).toEqual({ location: "SEAT:12A", component: "BACKREST" });
  const tray = at("tray", "SEAT:11A");
  expect(pick(tray.clone().add(new THREE.Vector3(0.3, 0, 0)), tray)).toEqual({ location: "SEAT:11A", component: "BACKREST" });
  // two pads per seat, as drawn before, selecting no piece; no bulkhead tray for a first row that lists no tray
  const pads = pieces.find((p) => p.part === "armPads");
  expect(pads?.locations).toHaveLength(2 * old.locations.filter((l) => l.kind === "SEAT").length);
  expect(new Set(pads?.components)).toEqual(new Set([null]));
  expect(pieces.find((p) => p.part === "tray")?.locations.filter((l) => l.seat?.physicalRow === 1 && l.componentIds.includes("TRAY"))).toEqual([]);
  // so no empty panel is drawn ahead of the first row to block picks
  expect(pieces.panels).toEqual([]);
});

describe("the 3D view's pieces", () => {
  test("an Under seat layer, off by default, turns the life vests on", async () => {
    renderCabin(workspace);
    await ready();
    const under = within(screen.getByRole("group", { name: "Layers" })).getByRole("button", { name: "Under seat" });
    expect(under).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(calls("setLayers").at(-1)?.args[0]).toMatchObject({ underSeat: false }));
    fireEvent.click(under);
    expect(calls("setLayers").at(-1)?.args[0]).toMatchObject({ underSeat: true });
  });

  test("the hover label names the piece with the location", async () => {
    const defs = { HEADREST: { id: "HEADREST", name: "Headrest cover", locationKind: "SEAT", maxReplacementsPerLocation: 1, countNote: "" } };
    renderCabin({ ...workspace, componentDefs: defs } as Workspace);
    await ready();
    act(() => callbacks().onHover({ locationId: "SEAT:12A", componentId: "HEADREST", x: 10, y: 10 }));
    expect(document.querySelector(".hover-label")).toHaveTextContent("12A · Headrest cover");
    act(() => callbacks().onHover({ locationId: "ARMREST:12-AB", componentId: "ARMREST", x: 10, y: 10 }));
    expect(document.querySelector(".hover-label")).toHaveTextContent(/^Armrest between 12A and 12B$/);
    // a piece with no plain name shows the location alone, never a raw id
    act(() => callbacks().onHover({ locationId: "SEAT:12A", componentId: "LIFE_VEST", x: 10, y: 10 }));
    expect(document.querySelector(".hover-label")).toHaveTextContent(/^Seat 12A$/);
    act(() => callbacks().onHover(null));
    expect(document.querySelector(".hover-label")).toBeNull();
  });

  test("the blocked seats reach the scene", async () => {
    const blocked = new Set(["SEAT:3A"]);
    render(
      <Cabin3D
        workspace={workspace}
        states={buildStates(workspace).scene}
        blocked={blocked}
        selection={null}
        onSelect={vi.fn()}
        visualProfiles={[]}
        onFailed={vi.fn()}
      />,
    );
    await ready();
    await waitFor(() => expect(calls("setBlocked").at(-1)?.args[0]).toBe(blocked));
  });
});

describe("the overhead bins in 3D", () => {
  const materials = () => ({ door: () => new THREE.MeshBasicMaterial(), body: () => new THREE.MeshBasicMaterial(), interior: new THREE.MeshBasicMaterial() });
  const ALL_BIN_PIECES = [
    "BIN_DOOR",
    "BIN_LATCH",
    "BIN_STRIKER",
    "BIN_PIVOT",
    "BIN_ASSIST",
    "BIN_LINER",
    "BIN_SIDE_PANEL",
    "BIN_BUMPER",
    "BIN_SEAL",
    "BIN_PLACARD",
    "BIN_LABEL",
  ];
  /** The fixture layout with every bin of one type and that type's pieces, as a layout of that bin type is released. */
  const withBins = (binType: "CLASSIC" | "PIVOT" | "LARGE_PIVOT") => {
    const without: string[] = { CLASSIC: ["BIN_ASSIST", "BIN_BUMPER"], PIVOT: [], LARGE_PIVOT: ["BIN_ASSIST"] }[binType];
    const copy = structuredClone(layout);
    for (const l of copy.locations)
      if (l.bin) {
        l.bin.binType = binType;
        l.componentIds = ALL_BIN_PIECES.filter((p) => !without.includes(p));
      }
    return copy;
  };
  const bin = (l: typeof layout, id: string) => {
    const found = l.locations.find((x) => x.id === id);
    if (!found) throw new Error(`no ${id}`);
    return found;
  };
  const bounds = { length: layout.geometry.cabinLength, halfWidth: layout.geometry.cabinHalfWidth, height: 2.3 };
  /** Where the "focus" view of a bin puts the camera. */
  const focusCamera = (l: typeof layout, id: string) => poseToFrame(bin(l, id).placement, "BIN", bounds).position;
  /** A ray from where the "focus" view of the bin puts the camera, through a point. */
  const fromFocus = (l: typeof layout, id: string, point: THREE.Vector3) => {
    const camera = focusCamera(l, id);
    return new THREE.Raycaster(camera, point.clone().sub(camera).normalize());
  };
  /** A ray from the aisle at standing height at the middle of a closed bin's face. */
  const atFace = (l: typeof layout, id: string) => {
    const p = bin(l, id).placement;
    const sign = p.z > 0 ? 1 : -1;
    const face = new THREE.Vector3(p.x, 1.84, sign * 0.9);
    const from = new THREE.Vector3(p.x - 0.3, 1.6, -sign * 0.3);
    return new THREE.Raycaster(from, face.sub(from).normalize());
  };
  const pickWith = (run: BinRun, ray: THREE.Raycaster) => {
    const hit = run.pick(
      ray.intersectObjects(
        run.targets(() => true),
        false,
      ),
    );
    return hit && { location: hit.location.id, component: hit.component, closed: hit.closed };
  };
  /** A tap as the scene handles it: a closed bin opens, and the pick selects. */
  const tap = (run: BinRun, ray: THREE.Raycaster, instant = true) => {
    const hit = pickWith(run, ray);
    if (hit?.closed) run.openBin(hit.location, 0, instant);
    return hit && { location: hit.location, component: hit.component };
  };

  test("tapping BIN:L-04 opens it and selects BIN_DOOR; a second bin closes the first", () => {
    const run = new BinRun(layout, materials());
    expect(run.target).toBeNull();
    expect(tap(run, atFace(layout, "BIN:L-04"))).toEqual({ location: "BIN:L-04", component: "BIN_DOOR" });
    expect(run.target).toBe("BIN:L-04");
    expect(run.open?.location.id).toBe("BIN:L-04");
    expect(run.level).toBe(1);
    // the open door or bucket face still selects BIN_DOOR, and does not open anything else
    const face = run.pointOf("BIN_DOOR", focusCamera(layout, "BIN:L-04"));
    if (!face) throw new Error("no door point");
    expect(tap(run, fromFocus(layout, "BIN:L-04", face))).toEqual({ location: "BIN:L-04", component: "BIN_DOOR" });
    expect(run.target).toBe("BIN:L-04");
    // opening asks for nothing when the bin is already open
    expect(run.openBin("BIN:L-04", 0, true)).toBe(false);
    // a second bin: at most one is open
    expect(tap(run, atFace(layout, "BIN:L-05"))).toEqual({ location: "BIN:L-05", component: "BIN_DOOR" });
    expect(run.target).toBe("BIN:L-05");
    expect(run.open?.location.id).toBe("BIN:L-05");
    // L-04 is shut again: its door is back where the closed bin draws it, and its face opens it once more
    expect(tap(run, atFace(layout, "BIN:L-04"))).toEqual({ location: "BIN:L-04", component: "BIN_DOOR" });
    expect(run.target).toBe("BIN:L-04");
    expect(run.openBin(null, 0, true)).toBe(true);
    expect(run.target).toBeNull();
    expect(run.open).toBeNull();
    run.dispose();
  });

  test("the latch is pickable only while open, from the bin's focus view, for every bin type", () => {
    for (const binType of ["CLASSIC", "PIVOT", "LARGE_PIVOT"] as const) {
      const l = withBins(binType);
      const run = new BinRun(l, materials());
      run.openBin("BIN:L-04", 0, true);
      const latch = run.pointOf("BIN_LATCH", focusCamera(l, "BIN:L-04"));
      if (!latch) throw new Error(`${binType}: no latch that can be tapped`);
      const ray = fromFocus(l, "BIN:L-04", latch);
      expect(pickWith(run, ray), binType).toEqual({ location: "BIN:L-04", component: "BIN_LATCH", closed: false });
      run.openBin(null, 0, true);
      expect(pickWith(run, ray)?.component, binType).not.toBe("BIN_LATCH");
      expect(run.targets(() => true).length, `${binType}: only the closed meshes are targets`).toBe(4);
      run.dispose();
    }
  });

  test("every piece every bin type lists can be tapped from the bin's focus view, on both sides, and selects that piece", () => {
    for (const binType of ["CLASSIC", "PIVOT", "LARGE_PIVOT"] as const) {
      const l = withBins(binType);
      for (const id of ["BIN:L-04", "BIN:R-03"]) {
        const run = new BinRun(l, materials());
        run.openBin(id, 0, true);
        const camera = focusCamera(l, id);
        for (const piece of bin(l, id).componentIds) {
          const point = run.pointOf(piece, camera);
          expect(point, `${binType} ${id} ${piece}: a point the focus view reaches`).not.toBeNull();
          if (point) expect(pickWith(run, fromFocus(l, id, point)), `${binType} ${id} ${piece}`).toEqual({ location: id, component: piece, closed: false });
        }
        run.dispose();
      }
    }
  });

  test("each side's closed bins have their own materials, so one side ghosts while the other stays solid", () => {
    const run = new BinRun(layout, materials());
    const [left, right] = run.sides;
    if (!left || !right) throw new Error("two sides");
    expect(left.door.material).not.toBe(right.door.material);
    expect(left.body.material).not.toBe(right.body.material);
    // the scene ghosts a side by its materials (setGhosted), as an outside view does to the side nearest the camera
    for (const m of [left.door.material, left.body.material] as THREE.Material[]) setGhosted(m, true, 0.16);
    for (const m of [right.door.material, right.body.material] as THREE.Material[]) setGhosted(m, false, 0.16);
    const look = (m: THREE.Material | THREE.Material[]) => ({ transparent: (m as THREE.Material).transparent, opacity: (m as THREE.Material).opacity });
    expect([look(left.door.material), look(left.body.material)]).toEqual([
      { transparent: true, opacity: 0.16 },
      { transparent: true, opacity: 0.16 },
    ]);
    expect([look(right.door.material), look(right.body.material)]).toEqual([
      { transparent: false, opacity: 1 },
      { transparent: false, opacity: 1 },
    ]);
    run.dispose();
  });

  test("a classic door's lower panel swings up inside the housing: it never passes through the fixed shelf or what sits on it", () => {
    const g = buildBinGeometry(1, "CLASSIC", 2.4);
    if (!g.panel || !g.fascia) throw new Error("a classic bin's split door");
    const fixedBoxes = [g.openBody, g.interior.BIN_LATCH, g.interior.BIN_STRIKER, g.interior.BIN_SEAL, g.interior.BIN_LINER].map((part) => {
      if (!part) throw new Error("a fixed part");
      part.computeBoundingBox();
      return part.boundingBox as THREE.Box3;
    });
    // the shelf is the housing's floor: the open body's lowest slab
    const position = g.panel.getAttribute("position");
    for (let level = 0; level <= 1.0001; level += 0.05) {
      const m = binOpenMatrix(1, "CLASSIC", level);
      for (let v = 0; v < position.count; v++) {
        const p = new THREE.Vector3().fromBufferAttribute(position, v).applyMatrix4(m);
        // the floor slab (below 1.67) and every fixed piece on it
        const inShelf = p.y < BIN_FLOOR_TOP - 1e-4 && p.z > 1.38 - 1e-4;
        expect(inShelf, `level ${level.toFixed(2)}: (${p.z.toFixed(3)}, ${p.y.toFixed(3)})`).toBe(false);
        for (const box of fixedBoxes.slice(1)) expect(box.containsPoint(p), `level ${level.toFixed(2)} in a fixed piece`).toBe(false);
      }
    }
    // the open classic bin draws no door instance: its fascia and panel are in the interior, both BIN_DOOR
    const run = new BinRun(withBins("CLASSIC"), materials());
    run.openBin("BIN:L-04", 0, true);
    const faces = run.open?.ranges.filter((r) => r.face) ?? [];
    expect(faces.map((r) => [r.mesh === run.open?.fixed ? "fixed" : "moving", r.piece])).toEqual([
      ["fixed", "BIN_DOOR"],
      ["moving", "BIN_DOOR"],
    ]);
    run.dispose();
  });

  test("BIN_ASSIST is drawn for PIVOT and absent for LARGE_PIVOT", () => {
    const pivot = buildBinGeometry(1, "PIVOT", 2.4).interior;
    const large = buildBinGeometry(1, "LARGE_PIVOT", 2.4).interior;
    const classic = buildBinGeometry(-1, "CLASSIC", 2.4).interior;
    expect(pivot.BIN_ASSIST).toBeDefined();
    expect(large.BIN_ASSIST).toBeUndefined();
    expect(classic.BIN_ASSIST).toBeUndefined();
    // a classic bin has no stop bumper either; the pivot bins do
    expect(classic.BIN_BUMPER).toBeUndefined();
    expect(pivot.BIN_BUMPER).toBeDefined();
    expect(large.BIN_BUMPER).toBeDefined();
    // and an open PIVOT bin draws it, an open LARGE_PIVOT bin does not
    for (const [binType, drawn] of [
      ["PIVOT", true],
      ["LARGE_PIVOT", false],
    ] as const) {
      const run = new BinRun(withBins(binType), materials());
      run.openBin("BIN:L-04", 0, true);
      expect(run.pointOf("BIN_ASSIST") !== null, binType).toBe(drawn);
      run.dispose();
    }
  });

  test("each type opens the way it does: classic door up 75 degrees, pivot bucket down 35, large pivot 38 and 0.05 m lower", () => {
    expect(BIN_OPENING.CLASSIC.angleDeg).toBe(75);
    expect(BIN_OPENING.PIVOT.angleDeg).toBe(35);
    expect(BIN_OPENING.LARGE_PIVOT.angleDeg).toBe(38);
    const door = buildBinGeometry(1, "PIVOT").door;
    // the face that turns: a pivot bin's whole door, a classic bin's lower panel
    const lowest = (binType: "CLASSIC" | "PIVOT" | "LARGE_PIVOT", side: 1 | -1) => {
      const geometry = buildBinGeometry(side, binType);
      const g = (binType === "CLASSIC" ? (geometry.panel as THREE.BufferGeometry) : geometry.door).clone().applyMatrix4(binOpenMatrix(side, binType, 1));
      g.computeBoundingBox();
      return (g.boundingBox as THREE.Box3).min.y;
    };
    door.computeBoundingBox();
    const closedBottom = (door.boundingBox as THREE.Box3).min.y;
    for (const side of [1, -1] as const) {
      // the classic door lifts: its free edge goes up, nothing goes below the closed bin
      expect(lowest("CLASSIC", side)).toBeGreaterThanOrEqual(closedBottom - 1e-6);
      // the pivot bucket comes down
      expect(lowest("PIVOT", side)).toBeLessThan(closedBottom - 0.05);
      expect(lowest("LARGE_PIVOT", side)).toBeCloseTo(lowest("PIVOT", side) - 0.05, 4);
      expect(openBottomEdge("LARGE_PIVOT")).toBeCloseTo(openBottomEdge("PIVOT") - 0.05, 6);
    }
    // the hinge line stays put: the classic panel turns about its top edge, where it meets the fixed fascia (R29),
    // 38 degrees down the door's arc
    const split = (38 * Math.PI) / 180;
    const top = new THREE.Vector3(0, 2.2 - 0.55 * Math.sin(split), 1.31 - 0.55 * Math.cos(split));
    expect([BIN_OPENING.CLASSIC.pivot.z, BIN_OPENING.CLASSIC.pivot.y]).toEqual([expect.closeTo(0.87659, 5), expect.closeTo(1.86139, 5)]);
    expect(
      top
        .clone()
        .applyMatrix4(binOpenMatrix(1, "CLASSIC", 1))
        .distanceTo(top),
    ).toBeLessThan(0.002);
    // a closed bin is the same shape whatever its type
    for (const binType of ["CLASSIC", "PIVOT", "LARGE_PIVOT"] as const) {
      expect(binOpenMatrix(1, binType, 0).equals(new THREE.Matrix4())).toBe(true);
    }
  });

  test("reduced motion opens in one frame; otherwise the bin opens over 350 ms, easing out", () => {
    expect(BIN_OPEN_MS).toBe(350);
    const reduced = new BinRun(layout, materials());
    reduced.openBin("BIN:L-04", 1000, true);
    expect(reduced.level).toBe(1);
    expect(reduced.animating).toBe(false);
    reduced.openBin(null, 1000, true);
    expect(reduced.level).toBe(0);
    expect(reduced.open).toBeNull();
    reduced.dispose();

    const run = new BinRun(layout, materials());
    run.openBin("BIN:L-04", 1000, false);
    expect(run.level).toBe(0);
    expect(run.animating).toBe(true);
    run.step(1000 + BIN_OPEN_MS / 2);
    // easeOutCubic(0.5) = 1 - 0.5^3
    expect(run.level).toBeCloseTo(0.875, 6);
    run.step(1000 + BIN_OPEN_MS);
    expect(run.level).toBe(1);
    expect(run.animating).toBe(false);
    // closing eases back down, and the interior goes once it is shut
    run.openBin(null, 2000, false);
    expect(run.open?.location.id).toBe("BIN:L-04");
    run.step(2000 + BIN_OPEN_MS);
    expect(run.level).toBe(0);
    expect(run.open).toBeNull();
    // finishing (reduced motion turned on mid-way) jumps to the end
    run.openBin("BIN:L-05", 3000, false);
    run.finish();
    expect(run.level).toBe(1);
    expect(run.animating).toBe(false);
    run.dispose();
  });

  test("on a layout stored before the bin pieces, an open bin draws and picks only what the bin lists", () => {
    // as in a visit store from 5d6679d: a bin lists only its door and has no type (read as PIVOT)
    const old = structuredClone(layout);
    old.locations = old.locations.map((l) =>
      l.kind === "BIN" && l.bin
        ? { ...l, componentIds: ["BIN_DOOR"], bin: { side: l.bin.side, module: l.bin.module, rowFrom: l.bin.rowFrom, rowTo: l.bin.rowTo } as typeof l.bin }
        : l,
    );
    const run = new BinRun(old, materials());
    expect(tap(run, atFace(old, "BIN:L-04"))).toEqual({ location: "BIN:L-04", component: "BIN_DOOR" });
    for (const piece of ["BIN_LATCH", "BIN_LINER", "BIN_ASSIST", "BIN_PLACARD"]) expect(run.pointOf(piece), piece).toBeNull();
    for (const range of run.open?.ranges ?? []) if (range.piece !== null) expect(["BIN_DOOR"]).toContain(range.piece);
    run.dispose();
    // a classic bin listing its door alone opens too: its split door is all it draws inside
    const oldClassic = structuredClone(old);
    for (const l of oldClassic.locations) if (l.bin) l.bin.binType = "CLASSIC";
    const classic = new BinRun(oldClassic, materials());
    expect(classic.openBin("BIN:L-04", 0, true)).toBe(true);
    expect(new Set(classic.open?.ranges.map((r) => r.piece))).toEqual(new Set([null, "BIN_DOOR"]));
    classic.dispose();
    // and a bin with nothing at all that moves (no door listed, no type) still opens without failing
    const bare = structuredClone(old);
    for (const l of bare.locations) if (l.kind === "BIN") l.componentIds = [];
    const empty = new BinRun(bare, materials());
    expect(empty.openBin("BIN:L-04", 0, true)).toBe(true);
    empty.dispose();
  });

  test("a layout without a bin map draws illustrative modules that never open", () => {
    const bare = structuredClone(layout);
    bare.locations = bare.locations.filter((l) => l.kind === "SEAT");
    const run = new BinRun(bare, materials());
    expect(run.sides.every((s) => s.door.count > 0 && s.locations.length === 0)).toBe(true);
    expect(run.targets(() => true)).toEqual([]);
    expect(run.openBin("BIN:L-04", 0, true)).toBe(false);
    run.dispose();
  });
});

describe("opening a bin from the 3D view", () => {
  function renderBins(selection: string | null, focusComponent: string | null, paused = false) {
    const props = { workspace, states: buildStates(workspace).scene, onSelect: vi.fn(), visualProfiles: [], onFailed: vi.fn() };
    const view = render(<Cabin3D {...props} selection={selection} focusComponent={focusComponent} paused={paused} />);
    return {
      rerender: (s: string | null, c: string | null, p = paused) => view.rerender(<Cabin3D {...props} selection={s} focusComponent={c} paused={p} />),
    };
  }

  test("focusing a bin piece (Go to location or the piece list) opens that bin, also while the 3D view is hidden", async () => {
    const view = renderBins(null, null, true);
    await ready();
    view.rerender("BIN:L-04", "BIN_LATCH");
    await waitFor(() => expect(calls("openBin").at(-1)?.args).toEqual(["BIN:L-04"]));
    // selecting the bin as a whole does not open it
    scenes.calls = [];
    view.rerender("BIN:L-05", null);
    expect(calls("openBin").map((c) => c.args[0])).not.toContain("BIN:L-05");
  });

  test("Close bin and Escape close the open bin; selecting elsewhere closes it too", async () => {
    const view = renderBins("BIN:L-04", "BIN_DOOR");
    await ready();
    expect(screen.queryByRole("button", { name: "Close bin" })).toBeNull();
    act(() => callbacks().onBinOpenChange?.("BIN:L-04"));
    scenes.calls = [];
    fireEvent.click(screen.getByRole("button", { name: "Close bin" }));
    expect(calls("openBin").map((c) => c.args[0])).toEqual([null]);
    // focus does not drop to the page when the button goes
    act(() => callbacks().onBinOpenChange?.(null));
    expect(screen.queryByRole("button", { name: "Close bin" })).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("canvas"));

    act(() => callbacks().onBinOpenChange?.("BIN:L-04"));
    scenes.calls = [];
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    expect(fireEvent.keyDown(canvas, { key: "Escape" })).toBe(false);
    expect(calls("openBin").map((c) => c.args[0])).toEqual([null]);
    act(() => callbacks().onBinOpenChange?.(null));
    // with no bin open, Escape is left alone for whatever else wants it
    scenes.calls = [];
    expect(fireEvent.keyDown(canvas, { key: "Escape" })).toBe(true);
    expect(calls("openBin")).toEqual([]);

    act(() => callbacks().onBinOpenChange?.("BIN:L-04"));
    scenes.calls = [];
    view.rerender("SEAT:7C", null);
    expect(calls("openBin").map((c) => c.args[0])).toEqual([null]);
  });

  test("the Viewer passes the focused piece to the 3D view", async () => {
    const view = render(<Viewer workspace={workspace} selection={null} onSelect={vi.fn()} visualProfiles={[]} />);
    await ready();
    view.rerender(<Viewer workspace={workspace} selection="BIN:R-03" focusComponent="BIN_SEAL" onSelect={vi.fn()} visualProfiles={[]} />);
    await waitFor(() => expect(calls("openBin").at(-1)?.args).toEqual(["BIN:R-03"]));
  });
});
