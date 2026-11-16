import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { VisualProfile } from "../../domain/types.ts";
import { STATUS_ENCODING, type Workspace } from "../model.ts";
import type { CabinScene, ColourMode, Layers, LightMode, LocationState, PresetView, SceneTestHooks } from "../scene/CabinScene.ts";
import { onThemeChange, sceneThemeTokens } from "../theme.ts";
import { KEYED_STATUSES, StatusGlyph } from "./StatusGlyph.tsx";

/** Only the e2e build (`npm run build:e2e`) exposes the scene on window; the shipped bundle never contains the hook. */
const TEST_HOOKS = import.meta.env.VITE_TEST_HOOKS === "1";

interface Props {
  workspace: Workspace;
  states: Map<string, LocationState>;
  selection: string | null;
  onSelect(locationId: string, componentId: string | null): void;
  visualProfiles: VisualProfile[];
  onFailed(reason: string): void;
  /** True while the 3D panel is hidden: the scene stays alive (camera, layers, light, family, colours) but stops drawing and listening. */
  paused?: boolean;
}

declare global {
  interface Window {
    __cabinKit?: { scene: (CabinScene & SceneTestHooks) | null };
  }
}

const CAMERA_BUTTONS: { view: PresetView; label: string; hint: string }[] = [
  { view: "cutaway", label: "Cutaway", hint: "Whole cabin from outside; the near bins are ghosted" },
  { view: "overhead", label: "Overhead", hint: "Whole cabin from above" },
  { view: "aisle", label: "Aisle", hint: "Standing in the aisle looking aft" },
];

/** The wheel hint shows for this long, at most once per browser session. */
export const WHEEL_HINT_MS = 2000;
export const WHEEL_HINT = "Click the view, then scroll to zoom";
const WHEEL_HINT_KEY = "cabin-kit.wheel-hint-shown";
/** used when session storage is blocked */
let wheelHintShown = false;

/** True the first time in this browser session, false after: the wheel hint is shown at most once. */
function firstWheelHint(): boolean {
  try {
    if (sessionStorage.getItem(WHEEL_HINT_KEY) !== null) return false;
    sessionStorage.setItem(WHEEL_HINT_KEY, "1");
    return true;
  } catch {
    if (wheelHintShown) return false;
    wheelHintShown = true;
    return true;
  }
}

/** The hover label sits this far right of and below the pointer, and flips to the other side near an edge. */
const HOVER_OFFSET = 14;
/** The gap the hover label keeps from the edges of the canvas. */
const HOVER_MARGIN = 4;

/** Where the hover label goes: beside the pointer, inside the canvas wrap. */
export function hoverLabelPosition(
  pointer: { x: number; y: number },
  label: { width: number; height: number },
  wrap: { width: number; height: number },
): { left: number; top: number } {
  const place = (at: number, size: number, room: number) => {
    const after = at + HOVER_OFFSET;
    const before = at - HOVER_OFFSET - size;
    const wanted = after + size <= room - HOVER_MARGIN || before < HOVER_MARGIN ? after : before;
    return Math.max(HOVER_MARGIN, Math.min(wanted, room - size - HOVER_MARGIN));
  };
  return { left: place(pointer.x, label.width, wrap.width), top: place(pointer.y, label.height, wrap.height) };
}

/**
 * The interactive 3D cutaway. The renderer is loaded on demand; any failure (module, WebGL,
 * lost context) is reported upward so the complete map-and-list fallback takes over.
 */
export function Cabin3D({ workspace, states, selection, onSelect, visualProfiles, onFailed, paused = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CabinScene | null>(null);
  const onSelectRef = useRef(onSelect);
  const onFailedRef = useRef(onFailed);
  onSelectRef.current = onSelect;
  onFailedRef.current = onFailed;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** the location last picked in the canvas: selecting it moves no camera */
  const pickedRef = useRef<string | null>(null);
  /** the selection the scene last showed; undefined before the first */
  const shownSelectionRef = useRef<string | null | undefined>(undefined);
  const [wheelHint, setWheelHint] = useState(false);
  const wheelHintTimer = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  const hoverRef = useRef<HTMLParagraphElement | null>(null);
  const [layers, setLayers] = useState<Layers>({ seats: true, floor: true, bins: true, context: false });
  const [light, setLight] = useState<LightMode>("neutral");
  const [profile, setProfile] = useState("photo-navy-band");
  const [colourMode, setColourMode] = useState<ColourMode>(workspace.mode === "explore" ? "tier" : "status");
  const hasMaps = workspace.layout.locations.some((l) => l.kind !== "SEAT");
  // Every save answers with a new layout object for the same revision. The scene follows the revision id, not the object,
  // so a save never rebuilds the scene or moves the camera (WEB-01): the object changes here only when the id does.
  const layoutRef = useRef(workspace.layout);
  if (layoutRef.current.id !== workspace.layout.id) layoutRef.current = workspace.layout;
  const layout = layoutRef.current;

  useEffect(() => {
    let cancelled = false;
    let scene: CabinScene | null = null;
    (async () => {
      try {
        const mod = await import("../scene/CabinScene.ts");
        if (cancelled || !canvasRef.current) return;
        scene = new mod.CabinScene(canvasRef.current, {
          onPick: (locationId, componentId) => {
            pickedRef.current = locationId;
            onSelectRef.current(locationId, componentId);
          },
          onHover: setHover,
          onContextLost: () => onFailedRef.current("The graphics context was lost."),
          onWheelPassedThrough: () => {
            if (!firstWheelHint()) return;
            setWheelHint(true);
            wheelHintTimer.current = window.setTimeout(() => setWheelHint(false), WHEEL_HINT_MS);
          },
        });
        sceneRef.current = scene;
        if (TEST_HOOKS) window.__cabinKit = { scene: scene as CabinScene & SceneTestHooks };
        setReady(true);
      } catch (e) {
        if (!cancelled) onFailedRef.current(e instanceof Error ? e.message : "3D could not start.");
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(wheelHintTimer.current);
      scene?.dispose();
      sceneRef.current = null;
      if (TEST_HOOKS && window.__cabinKit) window.__cabinKit.scene = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !sceneRef.current) return;
    try {
      sceneRef.current.setLayout(layout, hasMaps);
    } catch (e) {
      onFailedRef.current(e instanceof Error ? e.message : "The 3D scene could not be built.");
    }
  }, [ready, layout, hasMaps]);
  useEffect(() => {
    if (ready) sceneRef.current?.setStates(states);
  }, [ready, states]);
  // A location selected outside the canvas (map, list, work list, go-to) while the 3D view shows is brought into view if
  // it is off to the side or behind a bin. A pick in the canvas never moves the camera.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    scene.setSelection(selection);
    const previous = shownSelectionRef.current;
    shownSelectionRef.current = selection;
    const picked = pickedRef.current === selection;
    pickedRef.current = null;
    if (previous === undefined || selection === null || selection === previous || picked || pausedRef.current) return;
    scene.revealLocation(selection);
  }, [ready, selection]);
  useEffect(() => {
    if (ready) sceneRef.current?.setPaused(paused);
  }, [ready, paused]);
  useEffect(() => {
    if (ready) sceneRef.current?.setLayers(layers);
  }, [ready, layers]);
  useEffect(() => {
    if (ready) sceneRef.current?.setLight(light);
  }, [ready, light]);
  useEffect(() => {
    if (ready) sceneRef.current?.setProfile(profile);
  }, [ready, profile]);
  // the background and hover outline follow the page theme (WEB-16)
  useEffect(() => {
    if (!ready) return;
    const apply = () => {
      const tokens = sceneThemeTokens();
      if (tokens) sceneRef.current?.setTheme(tokens);
    };
    apply();
    return onThemeChange(apply);
  }, [ready]);
  useEffect(() => {
    if (ready) sceneRef.current?.setColourMode(colourMode);
  }, [ready, colourMode]);

  // The hover label follows the pointer (offset 14 px, kept inside the canvas wrap). Placed before paint, so it never
  // shows in the wrong place for a frame.
  useLayoutEffect(() => {
    const label = hoverRef.current;
    const wrap = label?.parentElement;
    if (!hover || !label || !wrap) return;
    const { left, top } = hoverLabelPosition(
      hover,
      { width: label.offsetWidth, height: label.offsetHeight },
      { width: wrap.clientWidth, height: wrap.clientHeight },
    );
    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
  }, [hover]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    // A hidden panel has no size; resizing to it would refit the camera for nothing.
    const observer = new ResizeObserver(() => {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) sceneRef.current?.resize();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const scene = sceneRef.current;
    // Browser and system shortcuts (zoom with Cmd/Ctrl and plus, history with Alt and an arrow) pass straight through (WEB-12).
    if (!scene || e.ctrlKey || e.metaKey || e.altKey) return;
    const map: Record<string, Parameters<CabinScene["nudge"]>[0]> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      "+": "in",
      "=": "in",
      "-": "out",
      _: "out",
    };
    const action = map[e.key];
    if (action) {
      e.preventDefault();
      scene.nudge(action);
    } else if (e.key === "Home") {
      e.preventDefault();
      scene.setCamera("cutaway");
    } else if (e.key === "Enter" && selection) {
      e.preventDefault();
      document.getElementById("inspector-heading")?.focus();
    }
  };
  const camera = (view: PresetView) => sceneRef.current?.setCamera(view, selection);
  const toggle = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const activeProfile = visualProfiles.find((p) => p.id === profile);
  const keysId = useId();

  return (
    <div className="viewer3d">
      <fieldset className="toolbar" aria-label="3D view controls">
        <fieldset className="tool-group" aria-label="Camera">
          {CAMERA_BUTTONS.map((b) => (
            <button key={b.view} type="button" title={b.hint} onClick={() => camera(b.view)} disabled={!ready}>
              {b.label}
            </button>
          ))}
          <button type="button" onClick={() => camera("focus")} disabled={!ready || !selection} title="Zoom to the selected location">
            Focus
          </button>
          <button type="button" onClick={() => camera("focus-rear")} disabled={!ready || !selection} title="Zoom to the rear of the selected seat">
            Focus rear
          </button>
          <button type="button" onClick={() => camera("cutaway")} disabled={!ready} title="Back to the default view">
            Reset
          </button>
        </fieldset>
        <fieldset className="tool-group" aria-label="Move camera">
          {(
            [
              ["left", "Rotate left", "⟲"],
              ["right", "Rotate right", "⟳"],
              ["up", "Tilt up", "↑"],
              ["down", "Tilt down", "↓"],
              ["in", "Zoom in", "+"],
              ["out", "Zoom out", "−"],
            ] as const
          ).map(([action, label, glyph]) => (
            <button
              key={action}
              type="button"
              className="icon"
              aria-label={label}
              title={label}
              onClick={() => sceneRef.current?.nudge(action)}
              disabled={!ready}
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          ))}
        </fieldset>
        <fieldset className="tool-group" aria-label="Layers">
          <span className="group-label" aria-hidden="true">
            Layers
          </span>
          {(["seats", "floor", "bins", "context"] as const).map((key) => (
            <label key={key} className="check">
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
              {key === "context" ? "Context (walls)" : key.charAt(0).toUpperCase() + key.slice(1)}
            </label>
          ))}
        </fieldset>
        <label className="tool-group select">
          <span>Colours</span>
          <select value={colourMode} onChange={(e) => setColourMode(e.target.value as ColourMode)}>
            <option value="status">Work status</option>
            <option value="tier">Tier / zone</option>
            <option value="none">Appearance only</option>
          </select>
        </label>
        <label className="tool-group select">
          <span>Light</span>
          <select value={light} onChange={(e) => setLight(e.target.value as LightMode)}>
            <option value="neutral">Neutral</option>
            <option value="blue">Blue cabin light</option>
          </select>
        </label>
        <label className="tool-group select">
          <span>Visual family</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {visualProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <div className="canvas-wrap">
        {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: role="application" makes screen readers pass the camera keys to the focusable canvas (WEB-14) */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="application"
          aria-roledescription="3D cabin view"
          aria-label={workspace.layout.name}
          aria-describedby={keysId}
          onKeyDown={onKeyDown}
          data-ready={ready ? "true" : "false"}
        />
        <ul id={keysId} className="sr-only">
          <li>Arrow keys orbit the camera.</li>
          <li>Plus and minus zoom in and out.</li>
          <li>Home resets the view.</li>
          <li>Enter goes to the parts for the selected location.</li>
          <li>Drag to orbit, right-drag or two fingers to pan, pinch to zoom. The wheel zooms once the view has focus; until then it scrolls the page.</li>
          <li>On a touch screen, drag up or down to scroll the page and sideways to orbit.</li>
          <li>Use the Map and list tab to select locations by keyboard.</li>
        </ul>
        {!ready && <p className="canvas-note">Starting 3D…</p>}
        {/* always present, so setting its text is announced */}
        <p className="canvas-hint" role="status">
          {wheelHint ? WHEEL_HINT : ""}
        </p>
        {/* The live region announces selection; this label only follows the pointer. */}
        {hover && (
          <p className="hover-label" aria-hidden="true" ref={hoverRef}>
            {hover.label}
          </p>
        )}
        <ul className="legend" aria-label="Legend">
          {/* status badges show in both colour modes; "Work status" also tints headrests, floor areas and bins */}
          {colourMode !== "none" &&
            KEYED_STATUSES.map((s) => (
              <li key={s} data-status={s}>
                <StatusGlyph status={s} /> {STATUS_ENCODING[s].label}
              </li>
            ))}
          {colourMode === "tier" && (
            <>
              <li>
                <span className="swatch tier-elr" /> Extra Legroom / ELR
              </li>
              <li>
                <span className="swatch tier-pref" /> Preferred
              </li>
              <li>
                <span className="swatch tier-exit" /> Fixture exit zone
              </li>
            </>
          )}
          <li>
            <span className="swatch selected" /> Selected
          </li>
        </ul>
      </div>
      <p className="fine">
        Visual family: <strong>{activeProfile?.name ?? profile}</strong>, unassigned and illustrative ({activeProfile?.basis ?? "images"}). Geometry is an
        approximation for display and picking, not aircraft dimensions.
        {!hasMaps && " Floor and bins are illustrative only: no floor or bin map was supplied for this layout."}
      </p>
    </div>
  );
}
