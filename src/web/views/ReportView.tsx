import { useEffect, useMemo, useState } from "react";
import { canonicalJson } from "../../domain/canonical.ts";
import { isOverdue } from "../../domain/observations.ts";
import { rulesNotUsedLine } from "../../domain/report.ts";
import { higherStatus } from "../../domain/status.ts";
import type { CarriedObservation, LookupState, Observation, Report, ReportPieceOutcome, VisitSnapshot, VisualProfile } from "../../domain/types.ts";
import { api } from "../api.ts";
// Cabin3D is already in the first download (the visit workspace's viewer); what is heavy is its scene chunk (three.js),
// which it loads only once mounted, so "View in 3D" fetches it on demand. A React.lazy() import here would make Rolldown
// split React and the model into extra shared chunks.
import { Cabin3D } from "../components/Cabin3D.tsx";
import { CabinMap } from "../components/CabinMap.tsx";
import { ScrollRegion } from "../components/ScrollRegion.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { conditionLabel, deferLabel, formatDate, formatDateTime, LOOKUP_STATE_LABEL, melLabel } from "../format.ts";
import { canRetry, describeSaveStatus, useMutations } from "../hooks/useMutations.ts";
import { useResource } from "../hooks/useResource.ts";
import { contentKeyed, type Workspace } from "../model.ts";
import type { LocationState } from "../scene/CabinScene.ts";

/** A timestamp in words, with the stored value kept on the element. */
const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={iso}>
    {formatDateTime(iso)}
  </time>
);

/** The report's piece outcomes plus its unresolved components (from the gaps), for the cabin picture and the 3D view. */
function pictureOutcomes(report: Report): ReportPieceOutcome[] {
  const unresolved = report.gaps.flatMap((g) =>
    g.locationIds.map((locationId): ReportPieceOutcome => ({ locationId, componentId: g.componentId, status: "unresolved" })),
  );
  return [...(report.pieceOutcomes ?? []), ...unresolved];
}

/** The scene's per-location states from the same outcomes: the higher status wins where a piece is named twice. */
function outcomeStates(outcomes: readonly ReportPieceOutcome[]): Map<string, LocationState> {
  const states = new Map<string, LocationState>();
  for (const o of outcomes) {
    const s = states.get(o.locationId) ?? { components: {} };
    s.components[o.componentId] = higherStatus(s.components[o.componentId] ?? "none", o.status);
    states.set(o.locationId, s);
  }
  return states;
}

/** A read-only workspace over the visit's frozen snapshot: the layout and piece names only. */
function pictureWorkspace(snapshot: VisitSnapshot, checkDate: string): Workspace {
  return {
    mode: "visit",
    layout: snapshot.context.layoutRevision,
    resolution: snapshot.resolution,
    componentDefs: snapshot.resolution.componentDefs,
    records: [],
    editable: false,
    unresolvedReason: null,
    observations: [],
    carried: [],
    checkDate,
    mel: [],
  };
}

/** One problem in an outcome list: where it is, then its condition, class, dates and note, in words. */
function ProblemLine({ o, checkDate, extra = "" }: { o: Observation; checkDate: string; extra?: string }) {
  // A closed problem's class and dates no longer apply: only what it was and how it was closed.
  const open = o.status === "OPEN";
  const due = open && o.dueDate ? `${isOverdue(o.dueDate, checkDate) ? "Overdue since" : "Fix by"} ${formatDate(o.dueDate)}` : "";
  const facts = [
    conditionLabel(o.condition),
    open && o.outcome !== "NOTED" ? melLabel(o.melClass) : "",
    open && o.outcome === "DEFERRED" && o.deferUntil ? deferLabel(o.deferUntil) : "",
    due,
    extra,
  ];
  return (
    <li>
      <strong>
        {o.locationLabel} · {o.componentName}
      </strong>{" "}
      · {facts.filter((f) => f !== "").join(" · ")}
      {o.note && <span className="fine"> · Note: {o.note}</span>}
    </li>
  );
}

const carriedExtra = (c: CarriedObservation) =>
  `opened in an earlier visit${c.placement === "ORPHANED" ? "; its position is not in this layout" : c.placement === "MAPPED" ? "; mapped to this layout" : ""}`;

/** A list section of the after-action report: a heading, then its problems or "None.". */
function OutcomeList({ id, title, items }: { id: string; title: string; items: React.ReactNode[] }) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {items.length === 0 ? <p>None.</p> : <ul className="plain">{items}</ul>}
    </section>
  );
}

const roleText = (role: string) => (role === "MANDATORY_CHILD" ? "Required supplement" : role === "ALTERNATE" ? "Alternate" : "Primary");

/** After-action report. Printable (browser print / save as PDF), server PDF, and structured JSON. */
export function ReportView({
  visitId,
  onVisit,
  visualProfiles = [],
}: {
  visitId: string;
  onVisit?: (meta: { id: string; number: number; tail: string }) => void;
  visualProfiles?: VisualProfile[];
}) {
  const [note, setNote] = useState("");
  const [show3d, setShow3d] = useState(false);
  const [failed3d, setFailed3d] = useState<string | null>(null);
  const [noteType, setNoteType] = useState("ADVISORY");
  const [author, setAuthor] = useState("");

  const res = useResource(`report:${visitId}`, (signal) => api.report(visitId, { signal }));
  const data = res.data ?? null;
  const error =
    res.state !== "error"
      ? null
      : res.error.kind === "network"
        ? "The server could not be reached. The saved report is unchanged; retry when the connection is back."
        : res.error.message;
  // The cabin picture (report schema 3) needs the frozen layout, which only the visit's snapshot carries.
  const v3 = data?.report.pieceOutcomes !== undefined;
  const visitRes = useResource(v3 ? `report-visit:${visitId}` : null, (signal) => api.visit(visitId, { signal }));
  const snapshot = visitRes.data?.visit?.snapshot;
  const checkDate = data?.report.visit.checkDate ?? "";
  const workspace = useMemo(() => (snapshot ? pictureWorkspace(snapshot, checkDate) : null), [snapshot, checkDate]);
  const report0 = data?.report;
  const outcomes = useMemo(() => (report0 ? pictureOutcomes(report0) : []), [report0]);
  const states = useMemo(() => outcomeStates(outcomes), [outcomes]);
  const pieceOutcomes = useMemo(() => ({ pieceOutcomes: outcomes }), [outcomes]);
  const number = data?.report.visit.number;
  const tail = data?.report.visit.tail;
  useEffect(() => {
    if (number !== undefined && tail !== undefined) onVisit?.({ id: visitId, number, tail });
  }, [visitId, number, tail, onVisit]);

  // One write at a time; after a dropped answer the same note is re-sent with the same key, so it is appended once.
  const notes = useMutations<Awaited<ReturnType<typeof api.addEvent>>>(() => {
    setNote("");
    res.reload();
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
        <h2 tabIndex={-1}>Report</h2>
        <div className="alert" role="alert">
          <p>{error}</p>
          <button type="button" onClick={res.reload}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel" aria-label="Report" aria-busy="true">
        <Skeleton thing="report" shape="report" />
      </section>
    );
  }
  const { report, linkedEvents, basisSha256 } = data;
  const { summary, timeline, observations } = report;
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
        <h2 id="report-h" tabIndex={-1}>
          Cabin Kit after-action report
        </h2>
        <p className={`report-kind ${final ? "final" : "draft"}`}>
          {final ? "FINAL — visit completed and locked" : "DRAFT PREVIEW — visit not completed; content may still change"}
        </p>
        <p className="authority">{report.authorityNotice}</p>
      </header>

      {summary && (
        <section aria-labelledby="r-summary">
          <h3 id="r-summary">Summary</h3>
          {!summary.releasable && <p className="must-fix">Not releasable: aircraft held</p>}
          <dl className="facts">
            <dt>Replaced</dt>
            <dd>{summary.replaced}</dd>
            <dt>Noted</dt>
            <dd>{summary.noted}</dd>
            <dt>Deferred, cosmetic</dt>
            <dd>{summary.deferredCosmetic}</dd>
            <dt>Deferred under the MEL</dt>
            <dd>{summary.deferredMel}</dd>
            <dt>Must be fixed</dt>
            <dd>{summary.mustFix}</dd>
            <dt>Carried over in</dt>
            <dd>{summary.carriedIn}</dd>
            <dt>Still open</dt>
            <dd>{summary.stillOpen}</dd>
            <dt>Releasable</dt>
            <dd>{summary.releasable ? "Yes" : "No"}</dd>
            <dt>Aircraft held</dt>
            <dd>{summary.aircraftHeld ? "Yes" : "No"}</dd>
          </dl>
        </section>
      )}

      {report.pieceOutcomes && (
        <section aria-labelledby="r-picture">
          <h3 id="r-picture">Cabin picture</h3>
          <p className="fine">Each location shows the highest status of its pieces at the end of this check.</p>
          {!workspace ? (
            visitRes.state === "error" ? (
              <p className="notice">The cabin picture could not be loaded. The report itself is complete.</p>
            ) : (
              <p className="fine">Loading the cabin picture</p>
            )
          ) : (
            <>
              <button type="button" className="no-print" aria-pressed={show3d} disabled={!!failed3d} onClick={() => setShow3d((on) => !on)}>
                View in 3D
              </button>
              {failed3d && <p className="notice">3D view unavailable. {failed3d} The map below shows the same picture.</p>}
              {show3d && !failed3d && (
                <div className="no-print">
                  <Cabin3D workspace={workspace} states={states} selection={null} onSelect={() => {}} visualProfiles={visualProfiles} onFailed={setFailed3d} />
                </div>
              )}
              <CabinMap workspace={workspace} readOnly={pieceOutcomes} />
            </>
          )}
        </section>
      )}

      {timeline && (
        <section aria-labelledby="r-timeline">
          <h3 id="r-timeline">What happened, in order</h3>
          {timeline.length === 0 ? (
            <p>Nothing was recorded in this visit.</p>
          ) : (
            <ol>
              {timeline.map((t) => (
                <li key={t.seq}>
                  <Time iso={t.at} /> {t.label}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {observations && (
        <>
          <OutcomeList id="r-deferred" title="Deferred" items={observations.deferred.map((o) => <ProblemLine key={o.id} o={o} checkDate={checkDate} />)} />
          <OutcomeList id="r-mustfix" title="Must be fixed" items={observations.mustFix.map((o) => <ProblemLine key={o.id} o={o} checkDate={checkDate} />)} />
          <OutcomeList id="r-noted" title="Noted" items={observations.noted.map((o) => <ProblemLine key={o.id} o={o} checkDate={checkDate} />)} />
          <OutcomeList
            id="r-closed"
            title="Closed this check"
            items={observations.closed.map((o) => (
              <ProblemLine key={o.id} o={o} checkDate={checkDate} extra={o.closedAs === "REPLACED" ? "Closed as replaced" : "Closed as fixed"} />
            ))}
          />
          <OutcomeList
            id="r-carried"
            title="Carried over in"
            items={observations.carriedIn.map((c) => <ProblemLine key={c.observation.id} o={c.observation} checkDate={checkDate} extra={carriedExtra(c)} />)}
          />
          <OutcomeList id="r-open" title="Still open" items={observations.stillOpen.map((o) => <ProblemLine key={o.id} o={o} checkDate={checkDate} />)} />
        </>
      )}

      <section aria-labelledby="r-visit">
        <h3 id="r-visit">Visit</h3>
        <dl className="facts wide">
          <dt>Visit number</dt>
          <dd>#{report.visit.number}</dd>
          <dt>Status</dt>
          <dd>{report.visit.status === "COMPLETED" ? "Completed" : "Draft"}</dd>
          <dt>Tail</dt>
          <dd>{report.visit.tail}</dd>
          <dt>Appearance-check date</dt>
          <dd>{formatDate(report.visit.checkDate)}</dd>
          <dt>Technician</dt>
          <dd>{report.visit.technician || "(not entered)"}</dd>
          <dt>Created</dt>
          <dd>
            <Time iso={report.visit.createdAt} />
          </dd>
          <dt>Completed</dt>
          <dd>{report.visit.completedAt ? <Time iso={report.visit.completedAt} /> : "not completed"}</dd>
          <dt>Report generated</dt>
          <dd>
            <Time iso={report.generatedAt} />
          </dd>
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
          <dd>{LOOKUP_STATE_LABEL[c.lookupState as LookupState] ?? c.lookupState}</dd>
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
            {formatDate(c.assignmentEffectiveFrom)} to {c.assignmentEffectiveTo ? formatDate(c.assignmentEffectiveTo) : "open"} (inclusive)
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
          <ScrollRegion label="Aggregate part totals table">
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
          </ScrollRegion>
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
          <ScrollRegion label="Work recorded by location table">
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
          </ScrollRegion>
        )}
      </section>

      <section aria-labelledby="r-gaps">
        <h3 id="r-gaps">Unresolved applicability gaps ({report.counts.unresolvedComponents} components)</h3>
        {report.gaps.length === 0 ? (
          <p>None. Every component in the frozen configuration had one applicable primary part.</p>
        ) : (
          <ScrollRegion label="Unresolved gaps table">
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
                {contentKeyed(report.gaps, (g) => `${g.componentId}|${g.status}|${g.locationSummary}|${g.message}`).map(([key, g]) => (
                  <tr key={key}>
                    <th scope="row">{g.componentId}</th>
                    <td>{g.status === "NO_MATCH" ? "No match" : "Ambiguous"}</td>
                    <td>{g.locationSummary}</td>
                    <td>{g.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </section>

      <section aria-labelledby="r-sources">
        <h3 id="r-sources">Sources, revisions and validity</h3>
        <ScrollRegion label="Sources table">
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
                    {s.effectiveFrom ? formatDate(s.effectiveFrom) : "not stated"} / {s.expiresOn ? formatDate(s.expiresOn) : "no expiry"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
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
                <strong>{e.type === "ADVISORY" ? "Advisory" : "Correction note"}</strong> <Time iso={e.at} />{" "}
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
