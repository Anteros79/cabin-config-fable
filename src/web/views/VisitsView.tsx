import { useCallback, useEffect, useState } from "react";
import type { VisitSummary } from "../../domain/types.ts";
import { ApiError, api } from "../api.ts";
import { formatRoute, type Route } from "../routes.ts";

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
  navigate(hash: string): void;
}) {
  // The filter, search and page live in the URL; the form fields only hold what is being typed.
  const [status, setStatus] = useState(routeStatus ?? "");
  const [query, setQuery] = useState(routeQ);
  useEffect(() => {
    setStatus(routeStatus ?? "");
    setQuery(routeQ);
  }, [routeStatus, routeQ]);
  const offset = (page - 1) * PAGE;
  const [data, setData] = useState<{ items: VisitSummary[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (next: Partial<Extract<Route, { name: "visits" }>>) => navigate(formatRoute({ name: "visits", status: routeStatus, q: routeQ, page, ...next }));

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.visits({ status: routeStatus ?? undefined, q: routeQ || undefined, limit: PAGE, offset }));
    } catch (e) {
      setError(
        e instanceof ApiError && e.kind === "network"
          ? "The server could not be reached. Saved visits are still stored; retry when the connection is back."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }, [routeStatus, routeQ, offset]);
  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <section className="panel" aria-labelledby="visits-h">
      <h2 id="visits-h">Saved visits</h2>
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="submit">Apply</button>
      </form>
      {error && (
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      )}
      <p role="status" className="fine">
        {busy ? "Loading…" : `${total} visit${total === 1 ? "" : "s"}${total > 0 ? ` · page ${page} of ${pages}` : ""}`}
      </p>
      {data && data.items.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Saved visits table">
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
                <th scope="col">Last changed (UTC)</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((v) => (
                <tr key={v.id}>
                  <th scope="row">#{v.number}</th>
                  <td>{v.tail}</td>
                  <td>{v.checkDate}</td>
                  <td>
                    <span className={`pill ${v.status === "DRAFT" ? "draft" : "recorded"}`}>{v.status === "DRAFT" ? "Draft" : "Completed"}</span>
                  </td>
                  <td>{v.variantId}</td>
                  <td>{v.recordCount}</td>
                  <td>{v.technician || "—"}</td>
                  <td>{v.updatedAt.replace("T", " ").slice(0, 19)}</td>
                  <td>
                    <a href={`#/visit/${v.id}`}>{v.status === "DRAFT" ? "Resume" : "View"}</a> · <a href={`#/visit/${v.id}/report`}>Report</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.items.length === 0 && !busy && <p>No visits match.</p>}
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
    </section>
  );
}
