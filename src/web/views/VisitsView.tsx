import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { ScrollRegion } from "../components/ScrollRegion.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { formatDate, relativeTime } from "../format.ts";
import { useResource } from "../hooks/useResource.ts";
import { formatRoute, type NavigateOptions, type Route } from "../routes.ts";

const PAGE = 25;

/** Saved history: every draft and completed visit is reachable by paging, filtering or search. */
export function VisitsView({
  status: routeStatus,
  q: routeQ,
  page,
  navigate,
}: {
  status: "DRAFT" | "COMPLETED" | null;
  q: string;
  page: number;
  navigate(hash: string, options?: NavigateOptions): void;
}) {
  // The filter, search and page live in the URL; the form fields only hold what is being typed.
  const [status, setStatus] = useState(routeStatus ?? "");
  const [query, setQuery] = useState(routeQ);
  useEffect(() => {
    setStatus(routeStatus ?? "");
    setQuery(routeQ);
  }, [routeStatus, routeQ]);
  const offset = (page - 1) * PAGE;
  const list = useResource(`visits:${routeStatus ?? ""}:${routeQ}:${page}`, (signal) =>
    api.visits({ status: routeStatus ?? undefined, q: routeQ || undefined, limit: PAGE, offset }, { signal }),
  );
  const data = list.data;
  const busy = list.state === "loading";
  const error =
    list.state !== "error"
      ? null
      : list.error.kind === "network"
        ? "The server could not be reached. Saved visits are still stored; retry when the connection is back."
        : list.error.message;
  const filtered = routeStatus !== null || routeQ !== "";
  // "5 min ago" is worked out when the list is drawn; it is not a clock
  const now = new Date();
  const go = (next: Partial<Extract<Route, { name: "visits" }>>) => navigate(formatRoute({ name: "visits", status: routeStatus, q: routeQ, page, ...next }));

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // A page past the end (an old link, or visits removed since) is replaced by the last page.
  const outOfRange = list.state === "ready" && page > pages;
  useEffect(() => {
    // A redirect, not a step: replacing the entry keeps Back from returning to the out-of-range page.
    if (outOfRange) navigate(formatRoute({ name: "visits", status: routeStatus, q: routeQ, page: pages }), { replace: true });
  }, [outOfRange, navigate, routeStatus, routeQ, pages]);

  return (
    <section className="panel" aria-labelledby="visits-h" aria-busy={busy}>
      <h2 id="visits-h" tabIndex={-1}>
        Saved visits
      </h2>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          go({ status: status === "DRAFT" || status === "COMPLETED" ? status : null, q: query.trim(), page: 1 });
        }}
      >
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="DRAFT">Drafts</option>
            <option value="COMPLETED">Completed</option>
          </select>
        </label>
        <label className="field">
          <span>Search tail, technician, date, variant or visit number</span>
          <input value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Apply
        </button>
      </form>
      {error && (
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={list.reload}>
            Retry
          </button>
        </div>
      )}
      <p role="status" className="fine">
        {busy ? "" : `${total} visit${total === 1 ? "" : "s"}${pages > 1 ? ` · page ${page} of ${pages}` : ""}`}
      </p>
      {busy && <Skeleton thing="saved visits" shape="table" />}
      {!busy && data && data.items.length > 0 && (
        <ScrollRegion label="Saved visits table">
          <table>
            <caption className="sr-only">Saved visits, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Visit</th>
                <th scope="col">Tail</th>
                <th scope="col">Check date</th>
                <th scope="col">Status</th>
                <th scope="col">Variant</th>
                <th scope="col">Records</th>
                <th scope="col">Technician</th>
                <th scope="col">Last changed</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((v) => (
                <tr key={v.id}>
                  <th scope="row">#{v.number}</th>
                  <td>{v.tail}</td>
                  <td>{formatDate(v.checkDate)}</td>
                  <td>
                    <span className={`pill ${v.status === "DRAFT" ? "draft" : "recorded"}`}>{v.status === "DRAFT" ? "Draft" : "Completed"}</span>
                  </td>
                  <td>{v.variantId}</td>
                  <td>{v.recordCount}</td>
                  <td>{v.technician || "—"}</td>
                  <td>
                    <time dateTime={v.updatedAt} title={v.updatedAt}>
                      {relativeTime(v.updatedAt, now)}
                    </time>
                  </td>
                  <td>
                    <a href={`#/visit/${v.id}`}>{v.status === "DRAFT" ? "Resume" : "View"}</a> · <a href={`#/visit/${v.id}/report`}>Report</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {data &&
        data.items.length === 0 &&
        !busy &&
        !outOfRange &&
        (filtered ? (
          <EmptyState title="No visits match this filter." action={{ label: "Clear filter", href: "#/visits" }}>
            <p>Saved visits are searched by tail, technician, check date, variant and visit number.</p>
          </EmptyState>
        ) : (
          <EmptyState title="No visits yet." action={{ label: "Start a check", href: "#/check" }}>
            <p>A visit is saved as a draft when you start it from an appearance check.</p>
          </EmptyState>
        ))}
      {pages > 1 && (
        <nav className="pager" aria-label="Visit pages">
          <button type="button" disabled={page === 1 || busy} onClick={() => go({ page: 1 })}>
            First
          </button>
          <button type="button" disabled={page === 1 || busy} onClick={() => go({ page: Math.max(1, page - 1) })}>
            Previous
          </button>
          <button type="button" disabled={offset + PAGE >= total || busy} onClick={() => go({ page: page + 1 })}>
            Next
          </button>
          <button type="button" disabled={offset + PAGE >= total || busy} onClick={() => go({ page: pages })}>
            Last
          </button>
        </nav>
      )}
    </section>
  );
}
