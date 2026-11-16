import { useCallback, useEffect, useState } from "react";
import { canonicalJson } from "../../domain/canonical.ts";
import { rulesNotUsedLine } from "../../domain/report.ts";
import { ApiError, api, type ReportEnvelope } from "../api.ts";
import { canRetry, describeSaveStatus, useMutations } from "../hooks/useMutations.ts";

const roleText = (role: string) => (role === "MANDATORY_CHILD" ? "Required supplement" : role === "ALTERNATE" ? "Alternate" : "Primary");

/** After-action report. Printable (browser print / save as PDF), server PDF, and structured JSON. */
export function ReportView({ visitId }: { visitId: string }) {
  const [data, setData] = useState<ReportEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteType, setNoteType] = useState("ADVISORY");
  const [author, setAuthor] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.report(visitId));
    } catch (e) {
      setError(
        e instanceof ApiError && e.kind === "network"
          ? "The server could not be reached. The saved report is unchanged; retry when the connection is back."
          : (e as Error).message,
      );
    }
  }, [visitId]);
  useEffect(() => {
    void load();
  }, [load]);

  // One write at a time; after a dropped answer the same note is re-sent with the same key, so it is appended once.
  const notes = useMutations<Awaited<ReturnType<typeof api.addEvent>>>(() => {
    setNote("");
    void load();
  });
  const noteStatus = notes.statusOf("note");
  const noteState =
    noteStatus.phase === "saved"
      ? `Linked note added.${noteStatus.replayed ? " The earlier attempt had already been stored; nothing was duplicated." : ""} The locked report content is unchanged.`
      : describeSaveStatus(noteStatus);
  const addNote = (e: React.FormEvent) => {
    e.preventDefault();
    const request = { type: noteType, note, author };
    void notes.run("note", (key) => api.addEvent(visitId, request.type, request.note, request.author, key), canonicalJson(request));
  };

  if (error) {
    return (
      <section className="panel">
        <h2>Report</h2>
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!data) return <p role="status">Loading report…</p>;
  const { report, linkedEvents, basisSha256 } = data;
  const c = report.configuration;
  const final = report.reportKind === "FINAL";
  const source = (id: string) => {
    const s = report.sources.find((x) => x.id === id);
    return s ? `${s.id} rev ${s.revision}` : id;
  };

  return (
    <article className="report" aria-labelledby="report-h">
      <div className="report-actions no-print">
        <button type="button" className="primary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
        <a className="button" href={`/api/visits/${visitId}/report.pdf`} target="_blank" rel="noreferrer">
          Open PDF
        </a>
        <a className="button" href={`/api/visits/${visitId}/report?download=1`} download>
          Download JSON
        </a>
        <a className="button" href={`#/visit/${visitId}`}>
          {final ? "View visit" : "Back to visit"}
        </a>
      </div>
      <header>
        <h2 id="report-h">Cabin Kit after-action report</h2>
        <p className={`report-kind ${final ? "final" : "draft"}`}>
          {final ? "FINAL — visit completed and locked" : "DRAFT PREVIEW — visit not completed; content may still change"}
        </p>
        <p className="authority">{report.authorityNotice}</p>
      </header>

      <section aria-labelledby="r-visit">
        <h3 id="r-visit">Visit</h3>
        <dl className="facts wide">
          <dt>Visit number</dt>
          <dd>#{report.visit.number}</dd>
          <dt>Status</dt>
          <dd>{report.visit.status}</dd>
          <dt>Tail</dt>
          <dd>{report.visit.tail}</dd>
          <dt>Appearance-check date</dt>
          <dd>{report.visit.checkDate}</dd>
          <dt>Technician</dt>
          <dd>{report.visit.technician || "(not entered)"}</dd>
          <dt>Created (UTC)</dt>
          <dd>{report.visit.createdAt}</dd>
          <dt>Completed (UTC)</dt>
          <dd>{report.visit.completedAt ?? "not completed"}</dd>
          <dt>Report generated (UTC)</dt>
          <dd>{report.generatedAt}</dd>
          <dt>Visit id</dt>
          <dd className="mono">{report.visit.id}</dd>
        </dl>
      </section>

      <section aria-labelledby="r-config">
        <h3 id="r-config">Frozen configuration at visit creation</h3>
        <dl className="facts wide">
          <dt>Data namespace</dt>
          <dd>{c.namespace} (fictional fixture)</dd>
          <dt>Lookup state</dt>
          <dd>{c.lookupState}</dd>
          <dt>Subtype</dt>
          <dd>{c.subtype}</dd>
          <dt>Maintenance variant</dt>
          <dd>
            {c.variantId} — {c.variantName}
          </dd>
          <dt>Seat hardware</dt>
          <dd>{c.hardware ?? "not stated"}</dd>
          <dt>Layout revision</dt>
          <dd>
            {c.layoutRevisionId} ({c.seatCount} seats)
          </dd>
          <dt>Carpet / seam</dt>
          <dd>
            {c.carpet ?? "not stated"} / {c.seam ?? "not stated"}
          </dd>
          <dt>Upholstery profile</dt>
          <dd>{c.upholstery ?? "not stated"}</dd>
          <dt>Assignment effective</dt>
          <dd>
            {c.assignmentEffectiveFrom} to {c.assignmentEffectiveTo ?? "open"} (inclusive)
          </dd>
          <dt>Configuration source</dt>
          <dd>{source(c.configurationSourceId)}</dd>
          <dt>Reference release</dt>
          <dd>{c.referenceReleaseId}</dd>
          <dt>Geometry reference</dt>
          <dd>{c.geometryVersion}</dd>
        </dl>
        <p className="fine mono">
          Snapshot SHA-256 {c.snapshotSha256}
          {basisSha256 ? ` · report basis SHA-256 ${basisSha256}` : ""}
        </p>
      </section>

      <section aria-labelledby="r-totals">
        <h3 id="r-totals">Aggregate part totals ({report.totals.length} part/unit lines)</h3>
        {report.totals.length === 0 ? (
          <p>No replacements recorded.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Aggregate part totals table">
            <table id="totals-table">
              <thead>
                <tr>
                  <th scope="col">Part number</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col">Unit</th>
                  <th scope="col">Role</th>
                  <th scope="col">Locations (quantity)</th>
                </tr>
              </thead>
              <tbody>
                {report.totals.map((t) => (
                  <tr key={`${t.partNo}|${t.unit}`} data-part={t.partNo} data-unit={t.unit} data-qty={t.quantity}>
                    <th scope="row" className="partno">
                      {t.partNo}
                    </th>
                    <td>{t.description}</td>
                    <td className="num">{t.quantity}</td>
                    <td>{t.unit}</td>
                    <td>{t.roles.map(roleText).join(", ")}</td>
                    <td>{t.locations.map((l) => `${l.locationLabel} / ${l.componentId} (${l.quantity})`).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fine">Totals are grouped by part number and unit. {report.replacementCountSemantics}</p>
      </section>

      <section aria-labelledby="r-work">
        <h3 id="r-work">
          Work recorded by location ({report.work.length} records, {report.counts.replacements} replacements)
        </h3>
        {report.work.length === 0 ? (
          <p>No replacements recorded.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Work recorded by location table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Component</th>
                  <th scope="col">Selection</th>
                  <th scope="col" className="num">
                    Repl.
                  </th>
                  <th scope="col">Parts used</th>
                  <th scope="col">Sources, notes and advisories</th>
                </tr>
              </thead>
              <tbody>
                {report.work.map((w) => (
                  <tr key={`${w.locationId}|${w.componentId}`}>
                    <th scope="row">{w.locationLabel}</th>
                    <td>{w.componentName}</td>
                    <td>
                      {w.selection === "ALTERNATE" ? (
                        <>
                          Alternate <span className="partno">{w.selectedPartNo}</span>
                          <br />
                          <span className="fine">replaces primary {w.primaryPartNo}</span>
                        </>
                      ) : (
                        <>
                          Primary <span className="partno">{w.selectedPartNo}</span>
                        </>
                      )}
                    </td>
                    <td className="num">{w.replacements}</td>
                    <td>
                      <ul className="plain">
                        {w.lines.map((l) => (
                          <li key={`${l.partNo}|${l.unit}`}>
                            <span className="partno">{l.partNo}</span> {l.qty} {l.unit}
                            {l.role === "MANDATORY_CHILD" ? " (required)" : ""}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      {[...new Set([source(w.ruleSourceId), source(w.selectionSourceId)])].join("; ")}
                      {w.note && (
                        <>
                          <br />
                          Note: {w.note}
                        </>
                      )}
                      {w.pendingChanges.map((p) => (
                        <span key={p.id}>
                          <br />
                          Pending change: {p.note}
                        </span>
                      ))}
                      {/* excludedRules is absent from stored /1 reports; nothing is shown then */}
                      {rulesNotUsedLine(w.excludedRules) && (
                        <span className="fine excluded">
                          <br />
                          {rulesNotUsedLine(w.excludedRules)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="r-gaps">
        <h3 id="r-gaps">Unresolved applicability gaps ({report.counts.unresolvedComponents} components)</h3>
        {report.gaps.length === 0 ? (
          <p>None. Every component in the frozen configuration had one applicable primary part.</p>
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
                {report.gaps.map((g, i) => (
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
      </section>

      <section aria-labelledby="r-sources">
        <h3 id="r-sources">Sources, revisions and validity</h3>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Sources table">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Rev</th>
                <th scope="col">Type</th>
                <th scope="col">Title</th>
                <th scope="col">Released</th>
                <th scope="col">Effective / expires (inclusive)</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.id}</th>
                  <td>{s.revision}</td>
                  <td>{s.kind}</td>
                  <td>{s.title}</td>
                  <td>{s.released ? "yes" : "NO"}</td>
                  <td>
                    {s.effectiveFrom ?? "not stated"} / {s.expiresOn ?? "no expiry"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">{report.dateRule}</p>
      </section>

      <section aria-labelledby="r-linked">
        <h3 id="r-linked">Linked advisories and corrections</h3>
        {linkedEvents.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {linkedEvents.map((e) => (
              <li key={e.seq}>
                <strong>{e.type === "ADVISORY" ? "Advisory" : "Correction note"}</strong> {e.at}{" "}
                {String(e.payload.author ?? "") && `by ${String(e.payload.author)}`}: {String(e.payload.note ?? "")}
              </li>
            ))}
          </ul>
        )}
        <p className="fine">Linked notes are separate events. They never alter the locked report content above.</p>
        <form className="note-form no-print" onSubmit={addNote}>
          <label className="field">
            <span>Type</span>
            <select value={noteType} onChange={(e) => setNoteType(e.target.value)}>
              <option value="ADVISORY">Advisory</option>
              <option value="CORRECTION_NOTE">Correction note</option>
            </select>
          </label>
          <label className="field">
            <span>Your name (optional)</span>
            <input value={author} maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label className="field grow">
            <span>Note</span>
            <input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} required />
          </label>
          <button type="submit" disabled={notes.isBusy("note")}>
            Add linked note
          </button>
          <span role="status" className="fine">
            {noteState}
          </span>
          {canRetry(noteStatus) && (
            <button type="button" onClick={() => void notes.retry("note")}>
              Retry safely
            </button>
          )}
        </form>
      </section>
    </article>
  );
}
