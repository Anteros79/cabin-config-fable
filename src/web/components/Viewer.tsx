import { useMemo, useState } from "react";
import type { VisualProfile } from "../../domain/types.ts";
import { buildStates, type Workspace } from "../model.ts";
import { Cabin3D } from "./Cabin3D.tsx";
import { CabinMap } from "./CabinMap.tsx";

interface Props {
  workspace: Workspace;
  selection: string | null;
  onSelect(locationId: string, componentId: string | null): void;
  visualProfiles: VisualProfile[];
}

/** 3D cutaway with a complete map-and-list alternative. A 3D failure never loses selection or work. */
export function Viewer({ workspace, selection, onSelect, visualProfiles }: Props) {
  const [tab, setTab] = useState<"3d" | "map">("3d");
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { scene, flags } = useMemo(() => buildStates(workspace), [workspace]);
  const showing = failure ? "map" : tab;
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
          <button type="button" role="tab" id="tab-3d" aria-selected={showing === "3d"} aria-controls="panel-3d" disabled={!!failure} onClick={() => setTab("3d")}>
            3D cutaway
          </button>
          <button type="button" role="tab" id="tab-map" aria-selected={showing === "map"} aria-controls="panel-map" onClick={() => setTab("map")}>
            Map and list
          </button>
        </div>
        <span className="viewer-counts" role="status">
          {workspace.layout.locations.filter((l) => l.kind === "SEAT").length} seats · {counts.recorded} recorded · {counts.unresolved} unresolved
        </span>
      </div>
      {failure && (
        <div className="alert" role="alert">
          <p>
            <strong>3D view unavailable.</strong> {failure} Every seat, floor area and bin stays selectable in the map and list below; your selection and saved work are unchanged.
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
      {showing === "3d" && (
        <div role="tabpanel" id="panel-3d" aria-labelledby="tab-3d">
          <Cabin3D key={attempt} workspace={workspace} states={scene} selection={selection} onSelect={onSelect} visualProfiles={visualProfiles} onFailed={setFailure} />
        </div>
      )}
      {showing === "map" && (
        <div role="tabpanel" id="panel-map" aria-labelledby="tab-map">
          <CabinMap workspace={workspace} flags={flags} selection={selection} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}
