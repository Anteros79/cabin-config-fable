import { useMemo, useState } from "react";
import type { VisualProfile } from "../../domain/types.ts";
import { buildStates, type Workspace } from "../model.ts";
import { Cabin3D } from "./Cabin3D.tsx";
import { CabinMap } from "./CabinMap.tsx";

type TabId = "3d" | "map";
const TABS: { id: TabId; label: string }[] = [
  { id: "3d", label: "3D cutaway" },
  { id: "map", label: "Map and list" },
];

interface Props {
  workspace: Workspace;
  selection: string | null;
  /** the piece focused at the selection: a bin piece opens that bin in 3D */
  focusComponent?: string | null;
  onSelect(locationId: string, componentId: string | null): void;
  visualProfiles: VisualProfile[];
}

/** 3D cutaway with a complete map-and-list alternative. A 3D failure never loses selection or work. */
export function Viewer({ workspace, selection, focusComponent = null, onSelect, visualProfiles }: Props) {
  const [tab, setTab] = useState<TabId>("3d");
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { scene, flags } = useMemo(() => buildStates(workspace), [workspace]);
  const showing = failure ? "map" : tab;
  /** WAI-ARIA tabs: Left and Right move between the tabs (wrapping), Home and End go to the ends; moving also activates. */
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const enabled = TABS.filter((t) => !(t.id === "3d" && failure));
    const at = enabled.findIndex((t) => t.id === showing);
    const index: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: enabled.length - 1 };
    const wanted = index[e.key];
    if (wanted === undefined) return;
    e.preventDefault();
    const next = enabled[(wanted + enabled.length) % enabled.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  const counts = useMemo(() => {
    let recorded = 0;
    let unresolved = 0;
    for (const f of flags.values()) {
      recorded += f.recorded;
      unresolved += f.unresolved;
    }
    return { recorded, unresolved };
  }, [flags]);

  return (
    <div className="viewer">
      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Cabin view">
          {TABS.map((t) => {
            const disabled = t.id === "3d" && !!failure;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={showing === t.id}
                aria-controls={`panel-${t.id}`}
                tabIndex={showing === t.id ? 0 : -1}
                disabled={disabled}
                onClick={() => setTab(t.id)}
                onKeyDown={onTabKey}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <span className="viewer-counts" role="status">
          {workspace.layout.locations.filter((l) => l.kind === "SEAT").length} seats · {counts.recorded} recorded · {counts.unresolved} unresolved
        </span>
      </div>
      {failure && (
        <div className="alert" role="alert">
          <p>
            <strong>3D view unavailable.</strong> {failure} Every seat, floor area and bin stays selectable in the map and list below; your selection and saved
            work are unchanged.
          </p>
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              setAttempt((n) => n + 1);
              setTab("3d");
            }}
          >
            Retry 3D
          </button>
        </div>
      )}
      {/* Both panels stay mounted, so each tab's aria-controls names a panel that exists; the inactive one is hidden. */}
      <div role="tabpanel" id="panel-3d" aria-labelledby="tab-3d" hidden={showing !== "3d"}>
        {/* The scene stays mounted while the map is shown, paused, so camera, layers, light, family and colours survive a tab switch
            (WEB-08). A failed scene is unmounted, so it is disposed and no later selection reaches it; Retry mounts a new one. */}
        {!failure && (
          <Cabin3D
            key={attempt}
            workspace={workspace}
            states={scene}
            blocked={flags.blocked}
            selection={selection}
            focusComponent={focusComponent}
            onSelect={onSelect}
            visualProfiles={visualProfiles}
            onFailed={setFailure}
            paused={showing !== "3d"}
          />
        )}
      </div>
      <div role="tabpanel" id="panel-map" aria-labelledby="tab-map" hidden={showing !== "map"}>
        <CabinMap workspace={workspace} flags={flags} selection={selection} onSelect={onSelect} />
      </div>
    </div>
  );
}
