import { useMemo, useState } from "react";
import type { VisualProfile } from "../../domain/types.ts";
import { api, type LayoutSummary } from "../api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { ScrollRegion } from "../components/ScrollRegion.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Viewer } from "../components/Viewer.tsx";
import { useResource } from "../hooks/useResource.ts";
import type { Workspace } from "../model.ts";

const STATUS_TEXT: Record<string, string> = {
  released: "Fixture, released",
  planned: "Planned only",
  candidate: "Candidate, unassigned",
};

/** Explore layouts without a tail. Candidate layouts are shown with their unverified status. */
export function LayoutsView({ layoutId, visualProfiles }: { layoutId: string | null; visualProfiles: VisualProfile[] }) {
  const listRes = useResource(layoutId ? null : "layouts", (signal) => api.layouts({ signal }));
  const detailRes = useResource(layoutId ? `layout:${layoutId}` : null, (signal) => api.layout(layoutId ?? "", { signal }));
  const list = listRes.data;
  const detail = detailRes.data;
  const failed = layoutId ? detailRes : listRes;
  const error =
    failed.state !== "error"
      ? null
      : failed.error.kind === "network"
        ? "The server could not be reached. Retry when the connection is back."
        : failed.error.message;
  // The selection belongs to the layout it was made on; another layout starts with none.
  const [picked, setPicked] = useState<{ layoutId: string | null; locationId: string } | null>(null);
  const selection = picked && picked.layoutId === layoutId ? picked.locationId : null;
  const setSelection = (locationId: string) => setPicked({ layoutId, locationId });

  const workspace: Workspace | null = useMemo(() => {
    if (!detail) return null;
    const candidate = detail.layoutRevision.namespace === "candidate";
    return {
      mode: "explore",
      layout: detail.layoutRevision,
      resolution: null,
      componentDefs: Object.fromEntries(detail.components.map((c) => [c.id, c])),
      records: [],
      editable: false,
      observations: [],
      carried: [],
      checkDate: "",
      mel: [],
      unresolvedReason: candidate
        ? "Unresolved: no approved parts, applicability or substitute catalogue was supplied for this candidate layout, and it is not assigned to any tail."
        : "Open an appearance check for a tail and date to resolve parts. Applicability depends on the dated tail configuration.",
    };
  }, [detail]);

  if (error) {
    return (
      <section className="panel">
        <h2 tabIndex={-1}>Layouts</h2>
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={failed.reload}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (layoutId) {
    if (!detail || !workspace) {
      return (
        <section className="panel" aria-label="Layout" aria-busy="true">
          <Skeleton thing="layout" shape="workspace" />
        </section>
      );
    }
    const rev = detail.layoutRevision;
    if (rev.seatSetStatus !== "complete") {
      return (
        <section className="panel" aria-labelledby="layout-h">
          <h2 id="layout-h" tabIndex={-1}>
            {rev.name}
          </h2>
          <EmptyState title="This layout has no seat set." action={{ label: "All layouts", href: "#/layouts" }}>
            <p>The supplied registry names this layout ({rev.id}) but gives no seat positions, so there is nothing to show in 3D or on a map.</p>
          </EmptyState>
        </section>
      );
    }
    const location = rev.locations.find((l) => l.id === selection) ?? null;
    return (
      <div className="check-view">
        <section className="panel" aria-labelledby="layout-h">
          <p>
            <a href="#/layouts">← All layouts</a>
          </p>
          <h2 id="layout-h" tabIndex={-1}>
            {rev.name}
          </h2>
          <p>
            <span className={`pill ${rev.namespace === "candidate" ? "candidate" : rev.status === "planned" ? "unresolved" : "ok"}`}>
              {STATUS_TEXT[rev.status] ?? rev.status}
            </span>{" "}
            {rev.id} · namespace {rev.namespace} · {rev.locations.filter((l) => l.kind === "SEAT").length} seats · floor map {rev.floorMapStatus} · bin map{" "}
            {rev.binMapStatus}
          </p>
          <ul className="notes">
            {rev.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {detail.source && (
              <li>
                Source: {detail.source.title} ({detail.source.kind}; {detail.source.authority}; revision {detail.source.revision}
                {detail.source.file ? `; file "${detail.source.file.path}", SHA-256 ${detail.source.file.sha256.slice(0, 16)}…` : ""})
              </li>
            )}
            {detail.categories.map((c) => (
              <li key={c.id}>
                Document category "{c.name}" maps here by inference. {c.note}
              </li>
            ))}
          </ul>
          <p className="fine">{rev.geometry.note}</p>
        </section>
        <div className="workspace">
          <Viewer workspace={workspace} selection={selection} onSelect={(id) => setSelection(id)} visualProfiles={visualProfiles} />
          <aside className="side" aria-label="Selected location">
            <Inspector
              workspace={workspace}
              location={location}
              focusComponent={null}
              statusOf={() => ({ phase: "idle" })}
              onRecord={() => undefined}
              onRemove={() => undefined}
              onRetry={() => undefined}
              onDirtyChange={() => undefined}
              onObserve={() => undefined}
              onUpdateObservation={() => undefined}
              onCloseObservation={() => undefined}
              onSelect={(id) => setSelection(id)}
            />
          </aside>
        </div>
      </div>
    );
  }

  if (!list) {
    return (
      <section className="panel" aria-label="Layouts" aria-busy="true">
        <Skeleton thing="layouts" shape="table" />
      </section>
    );
  }
  const groups: [string, string, LayoutSummary[]][] = [
    [
      "Candidate layouts from the supplied registry",
      "Unverified and unassigned. Explorable in 3D; no tails, parts or floor/bin maps.",
      list.layouts.filter((l) => l.namespace === "candidate"),
    ],
    ["Fictional fixture layouts", "Used by the demonstration tails. Not aircraft data.", list.layouts.filter((l) => l.namespace === "fixture")],
  ];
  return (
    <section className="panel" aria-labelledby="layouts-h">
      <h2 id="layouts-h" tabIndex={-1}>
        Layouts
      </h2>
      {groups.map(([title, blurb, items]) => (
        <section key={title} aria-label={title}>
          <h3>{title}</h3>
          <p className="fine">{blurb}</p>
          <ScrollRegion label={`${title} table`}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Layout revision</th>
                  <th scope="col">Status</th>
                  <th scope="col">Seats</th>
                  <th scope="col">Tier / zone counts</th>
                  <th scope="col">Floor / bin map</th>
                  <th scope="col">Variants</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">
                      {l.seatSetStatus === "complete" ? <a href={`#/layouts/${encodeURIComponent(l.id)}`}>{l.name}</a> : l.name}
                      <br />
                      <span className="fine">{l.id}</span>
                    </th>
                    <td>{STATUS_TEXT[l.status] ?? l.status}</td>
                    <td>{l.seatSetStatus === "complete" ? l.seatCount : "seat set not supplied"}</td>
                    <td>
                      {Object.entries(l.tierCounts)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(" · ") || "—"}
                    </td>
                    <td>
                      {l.floorMapStatus} / {l.binMapStatus}
                    </td>
                    <td>{l.variants.join(", ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </section>
      ))}
      <section aria-labelledby="cats-h">
        <h3 id="cats-h">Layout categories described in the supplied DOCX</h3>
        <p className="fine">
          Four document categories versus five registry identifiers is a difference of grain. No record is merged or dropped, and crosswalks are inferred, not
          stated.
        </p>
        <ul className="category-list">
          {list.layoutCategories.map((c) => (
            <li key={c.id} data-category={c.id}>
              <strong>{c.name}</strong> — claimed {c.claimedSeatCount ?? "?"} seats.{" "}
              {c.seatSetStatus === "not-supplied" ? (
                <span className="pill unresolved">Unresolved: seat set not supplied</span>
              ) : (
                <span className="pill candidate">Inferred: {c.crosswalk.map((x) => x.layoutRevisionId).join(", ")}</span>
              )}
              <br />
              <span className="fine">{c.note}</span>
              <ul className="plain fine">
                {c.claims.map((claim) => (
                  <li key={claim.locator + claim.text.slice(0, 20)}>
                    “{claim.text}” <span className="mono">[{claim.locator}]</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
