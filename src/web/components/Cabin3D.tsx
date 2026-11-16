import { useEffect, useRef, useState } from "react";
import type { VisualProfile } from "../../domain/types.ts";
import type { Workspace } from "../model.ts";
import type { CabinScene, CameraView, ColourMode, Layers, LightMode, LocationState } from "../scene/CabinScene.ts";

interface Props {
  workspace: Workspace;
  states: Map<string, LocationState>;
  selection: string | null;
  onSelect(locationId: string, componentId: string | null): void;
  visualProfiles: VisualProfile[];
  onFailed(reason: string): void;
}

declare global {
  interface Window {
    __cabinKit?: { scene: CabinScene | null };
  }
}

const CAMERA_BUTTONS: { view: CameraView; label: string; hint: string }[] = [
  { view: "cutaway", label: "Cutaway", hint: "Whole cabin from outside; the near bins are ghosted" },
  { view: "overhead", label: "Overhead", hint: "Whole cabin from above" },
  { view: "aisle", label: "Aisle", hint: "Standing in the aisle looking aft" },
];

/**
 * The interactive 3D cutaway. The renderer is loaded on demand; any failure (module, WebGL,
 * lost context) is reported upward so the complete map-and-list fallback takes over.
 */
export function Cabin3D({ workspace, states, selection, onSelect, visualProfiles, onFailed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CabinScene | null>(null);
  const onSelectRef = useRef(onSelect);
  const onFailedRef = useRef(onFailed);
  onSelectRef.current = onSelect;
  onFailedRef.current = onFailed;
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({ seats: true, floor: true, bins: true, context: false });
  const [light, setLight] = useState<LightMode>("neutral");
  const [profile, setProfile] = useState("photo-navy-band");
  const [colourMode, setColourMode] = useState<ColourMode>(workspace.mode === "explore" ? "tier" : "status");
  const hasMaps = workspace.layout.locations.some((l) => l.kind !== "SEAT");

  useEffect(() => {
    let cancelled = false;
    let scene: CabinScene | null = null;
    (async () => {
      try {
        const mod = await import("../scene/CabinScene.ts");
        if (cancelled || !canvasRef.current) return;
        scene = new mod.CabinScene(canvasRef.current, {
          onPick: (locationId, componentId) => onSelectRef.current(locationId, componentId),
          onHover: setHover,
          onContextLost: () => onFailedRef.current("The graphics context was lost."),
        });
        sceneRef.current = scene;
        window.__cabinKit = { scene };
        setReady(true);
      } catch (e) {
        if (!cancelled) onFailedRef.current(e instanceof Error ? e.message : "3D could not start.");
      }
    })();
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
      if (window.__cabinKit) window.__cabinKit.scene = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !sceneRef.current) return;
    try {
      sceneRef.current.setLayout(workspace.layout, hasMaps);
    } catch (e) {
      onFailedRef.current(e instanceof Error ? e.message : "The 3D scene could not be built.");
    }
  }, [ready, workspace.layout, hasMaps]);
  useEffect(() => {
    if (ready) sceneRef.current?.setStates(states);
  }, [ready, states, workspace.layout]);
  useEffect(() => {
    if (ready) sceneRef.current?.setSelection(selection);
  }, [ready, selection, workspace.layout]);
  useEffect(() => {
    if (ready) sceneRef.current?.setLayers(layers);
  }, [ready, layers]);
  useEffect(() => {
    if (ready) sceneRef.current?.setLight(light);
  }, [ready, light]);
  useEffect(() => {
    if (ready) sceneRef.current?.setProfile(profile);
  }, [ready, profile]);
  useEffect(() => {
    if (ready) sceneRef.current?.setColourMode(colourMode);
  }, [ready, colourMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sceneRef.current?.resize());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const scene = sceneRef.current;
    if (!scene) return;
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
    }
  };
  const camera = (view: CameraView) => sceneRef.current?.setCamera(view, selection);
  const toggle = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const activeProfile = visualProfiles.find((p) => p.id === profile);

  return (
    <div className="viewer3d">
      <div className="toolbar" role="group" aria-label="3D view controls">
        <div className="tool-group" role="group" aria-label="Camera">
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
        </div>
        <div className="tool-group" role="group" aria-label="Move camera">
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
        </div>
        <div className="tool-group" role="group" aria-label="Layers">
          <span className="group-label" aria-hidden="true">
            Layers
          </span>
          {(["seats", "floor", "bins", "context"] as const).map((key) => (
            <label key={key} className="check">
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
              {key === "context" ? "Context (walls)" : key[0].toUpperCase() + key.slice(1)}
            </label>
          ))}
        </div>
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
      </div>
      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`3D cabin view of ${workspace.layout.name}. Drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom, arrow keys to orbit, plus and minus to zoom, Home to reset. Use the Map and list tab to select locations by keyboard.`}
          onKeyDown={onKeyDown}
          data-ready={ready ? "true" : "false"}
        />
        {!ready && <p className="canvas-note">Starting 3D…</p>}
        {hover && (
          <p className="hover-label" aria-hidden="true">
            {hover}
          </p>
        )}
        <ul className="legend" aria-label="Legend">
          {colourMode === "status" && (
            <>
              <li>
                <span className="swatch recorded" /> Recorded
              </li>
              <li>
                <span className="swatch unresolved" /> Unresolved
              </li>
            </>
          )}
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
