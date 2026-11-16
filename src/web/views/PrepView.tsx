import { useMemo, useState } from "react";
import { rulesNotUsedLine } from "../../domain/report.ts";
import { api } from "../api.ts";
import { useResource } from "../hooks/useResource.ts";

interface Props {
  visitId: string | null;
  tail: string | null;
  date: string | null;
}

/**
 * Pre-work applicable-parts overview. Searchable, filterable, printable and exportable.
 * Coverage is where a part would apply; it is never replacements made.
 */
export function PrepView({ visitId, tail, date }: Props) {
  const [text, setText] = useState("");
  const [component, setComponent] = useState("");
  const [only, setOnly] = useState("");

  const key = visitId ? `prep:${visitId}` : tail && date ? `prep:${tail}:${date}` : null;
  const res = useResource(key, (signal) => (visitId ? api.visitPreparation(visitId, { signal }) : api.preparation(tail ?? "", date ?? "", { signal })));
  const prep = res.data ?? null;
  const error =
    res.state === "idle"
      ? "Look up a tail and date first, then open the preparation list from the result."
      : res.state !== "error"
        ? null
        : res.error.kind === "network"
          ? "The server could not be reached. Retry when the connection is back."
          : res.error.message;

  const components = useMemo(() => [...new Map((prep?.lines ?? []).map((l) => [l.componentId, l.componentName])).entries()], [prep]);
  const lines = useMemo(() => {
    if (!prep) return [];
    const needle = text.trim().toLowerCase();
    return prep.lines.filter((l) => {
      if (component && l.componentId !== component) return false;
      if (only === "alternates" && l.alternates.length === 0) return false;
      if (only === "pending" && l.pendingChanges.length === 0) return false;
      if (!needle) return true;
      const hay = [
        l.partNo,
        l.description,
        l.componentName,
        l.coverageSummary,
        l.source?.id ?? "",
        l.coverageLocationIds.join(" "),
        ...l.alternates.flatMap((a) => [a.altPartNo, a.altDescription, ...a.requiredSupplements.map((s) => s.partNo)]),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [prep, text, component, only]);

  const csvHref = visitId
    ? `/api/visits/${visitId}/preparation?format=csv`
    : `/api/preparation?tail=${encodeURIComponent(tail ?? "")}&date=${encodeURIComponent(date ?? "")}&format=csv`;

  return (
    <section className="panel prep" aria-labelledby="prep-h">
      <h2 id="prep-h">Preparation: applicable parts{prep ? ` · ${prep.tail} · ${prep.checkDate}` : ""}</h2>
      {error && (
        <div className="alert" role="alert">
          <p>{error}</p>
          {res.state === "error" && (
            <>
              <button type="button" onClick={res.reload}>
                Retry
              </button>{" "}
            </>
          )}
          <a href="#/check">Go to the appearance check</a>
        </div>
      )}
      {!prep && !error && <p role="status">Loading…</p>}
      {prep && (
        <>
          <p>
            Variant {prep.variantId}, layout {prep.layoutRevisionId}, reference release {prep.referenceReleaseId}.
            {visitId ? " Frozen with the visit." : " Live lookup."}
          </p>
          <p className="advisory" role="note">
            {prep.note}
          </p>
          <form className="filters no-print" onSubmit={(e) => e.preventDefault()}>
            <label className="field grow">
              <span>Search part, description, location or source</span>
              <input type="search" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <label className="field">
              <span>Component</span>
              <select value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">All components</option>
                {components.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Show</span>
              <select value={only} onChange={(e) => setOnly(e.target.value)}>
                <option value="">All parts</option>
                <option value="alternates">With approved alternates</option>
                <option value="pending">With pending changes</option>
              </select>
            </label>
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
            <a className="button" href={csvHref} download>
              Export CSV
            </a>
          </form>
          <p role="status" className="fine">
            Showing {lines.length} of {prep.lines.length} lines · {prep.counts.parts} distinct primary parts · {prep.counts.resolvedComponents} resolved
            components · {prep.counts.unresolvedComponents} unresolved · {prep.counts.alternates} alternates · {prep.counts.pendingChanges} pending changes
          </p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Applicable parts table">
            <table id="prep-table">
              <thead>
                <tr>
                  <th scope="col">Primary part</th>
                  <th scope="col">Component</th>
                  <th scope="col">Per replacement</th>
                  <th scope="col">Applies at (coverage)</th>
                  <th scope="col">Source and validity</th>
                  <th scope="col">Alternates and required supplements</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.ruleId} data-part={l.partNo}>
                    <th scope="row">
                      <span className="partno">{l.partNo}</span>
                      <br />
                      <span className="fine">{l.description}</span>
                    </th>
                    <td>{l.componentName}</td>
                    <td>
                      {l.qtyPerReplacement} {l.unit}
                      {l.requiredSupplements.map((s) => (
                        <span key={s.partNo}>
                          <br />+ {s.qty} {s.unit} {s.partNo}
                        </span>
                      ))}
                    </td>
                    <td>{l.coverageSummary}</td>
                    <td>
                      {l.source ? `${l.source.id} rev ${l.source.revision}` : "—"}
                      <br />
                      <span className="fine">
                        Rule {l.ruleEffectiveFrom} to {l.ruleEffectiveTo ?? "open"}
                        {l.source?.expiresOn ? `; source expires ${l.source.expiresOn}` : ""}
                      </span>
                      {l.pendingChanges.map((p) => (
                        <span key={p.id} className="advisory-inline">
                          <br />
                          Pending change: {p.note}
                        </span>
                      ))}
                      {l.excludedRules.map((x) => (
                        <span key={x.ruleId} className="fine excluded">
                          <br />
                          {rulesNotUsedLine([x])} ({x.locationSummary})
                        </span>
                      ))}
                    </td>
                    <td>
                      {l.alternates.length === 0 && l.excludedAlternates.length === 0 && "—"}
                      {l.alternates.map((a) => (
                        <div key={a.substituteId} className="alt-block">
                          Alternate <span className="partno">{a.altPartNo}</span> {a.qtyPerReplacement} {a.unit}
                          <br />
                          <span className="fine">
                            Approval {a.approvalSource ? `${a.approvalSource.id} rev ${a.approvalSource.revision}` : a.substituteId}, {a.effectiveFrom} to{" "}
                            {a.effectiveTo ?? "open"}
                          </span>
                          {a.requiredSupplements.length > 0 && (
                            <ul className="plain">
                              {a.requiredSupplements.map((s) => (
                                <li key={s.partNo}>
                                  Required: <span className="partno">{s.partNo}</span> × {s.qty} {s.unit}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {l.excludedAlternates.map((x) => (
                        <div key={x.id} className="fine excluded">
                          Not available: {x.altPartNo} — {x.reasons.map((r) => r.message).join(" ")}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Unresolved gaps ({prep.counts.unresolvedComponents} components)</h3>
          {prep.gaps.length === 0 ? (
            <p>None.</p>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Unresolved gaps table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col">Status</th>
                    <th scope="col">Locations</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {prep.gaps.map((g, i) => (
                    <tr key={i}>
                      <th scope="row">{g.componentId}</th>
                      <td>{g.status === "NO_MATCH" ? "No match" : "Ambiguous"}</td>
                      <td>{g.locationSummary}</td>
                      <td>{g.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
