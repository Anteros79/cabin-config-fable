import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LookupResult, RecordInput, Visit, VisitRecord, VisualProfile } from "../../domain/types.ts";
import { ApiError, api, newKey, type VisitEnvelope } from "../api.ts";
import { Inspector, type SaveState } from "../components/Inspector.tsx";
import { Viewer } from "../components/Viewer.tsx";
import type { Workspace } from "../model.ts";

interface Props {
  visitId: string | null;
  navigate(hash: string): void;
  visualProfiles: VisualProfile[];
}

const STATE_TEXT: Record<string, { title: string; tone: "ok" | "warn" | "bad" }> = {
  RESOLVED: { title: "Configuration resolved", tone: "ok" },
  PARTIAL: { title: "Configuration resolved with unresolved components", tone: "warn" },
  INVALID_INPUT: { title: "Check the input", tone: "bad" },
  UNKNOWN_TAIL: { title: "Unknown tail", tone: "bad" },
  UNCONFIGURED: { title: "No configuration on this date", tone: "bad" },
  OVERLAP: { title: "Overlapping configurations", tone: "bad" },
  PLANNED: { title: "Planned configuration only", tone: "bad" },
  SOURCE_INVALID: { title: "Configuration source not valid", tone: "bad" },
  SERVICE_UNAVAILABLE: { title: "Reference data unavailable", tone: "bad" },
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem("cabin-kit:last-visit", id);
    else localStorage.removeItem("cabin-kit:last-visit");
  } catch {
    /* storage may be blocked; history is on the server anyway */
  }
}
function recall(): string | null {
  try {
    return localStorage.getItem("cabin-kit:last-visit");
  } catch {
    return null;
  }
}

export function CheckView({ visitId, navigate, visualProfiles }: Props) {
  const [tails, setTails] = useState<{ tail: string; note: string }[]>([]);
  const [tail, setTail] = useState("");
  const [date, setDate] = useState(today());
  const [technician, setTechnician] = useState("");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupSeq, setLookupSeq] = useState(0);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [referenceChanged, setReferenceChanged] = useState(false);
  const [visitError, setVisitError] = useState<string | null>(null);
  const [visitLoading, setVisitLoading] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [focusComponent, setFocusComponent] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle", message: "" });
  const [confirming, setConfirming] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const confirmRef = useRef<HTMLHeadingElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as authored to preserve behaviour; fixed in Task 4.5
  const lastDraft = useMemo(recall, [visitId]);

  useEffect(() => {
    api
      .tails()
      .then((r) => setTails(r.tails))
      .catch(() => setTails([]));
  }, []);

  const loadVisit = useCallback(async (id: string) => {
    setVisitLoading(true);
    setVisitError(null);
    try {
      const res = await api.visit(id);
      setVisit(res.visit);
      setReferenceChanged(res.referenceNow?.changedSinceVisit ?? false);
      if (res.visit.status === "DRAFT") remember(id);
    } catch (e) {
      setVisitError(
        e instanceof ApiError && e.kind === "network"
          ? "The server could not be reached. Your saved work is still on the server; retry when the connection is back."
          : (e as Error).message,
      );
    } finally {
      setVisitLoading(false);
    }
  }, []);

  useEffect(() => {
    setSaveState({ status: "idle", message: "" });
    setConfirming(false);
    pending.current = null;
    if (visitId) {
      // Keep an already loaded copy of the same visit on screen while refreshing it.
      setVisit((v) => (v && v.id === visitId ? v : null));
      void loadVisit(visitId);
    } else {
      setVisit(null);
      setVisitError(null);
    }
  }, [visitId, loadVisit]);

  const workspace: Workspace | null = useMemo(() => {
    if (visitId) {
      if (!visit) return null;
      return {
        mode: "visit",
        layout: visit.snapshot.context.layoutRevision,
        resolution: visit.snapshot.resolution,
        componentDefs: visit.snapshot.resolution.componentDefs,
        records: visit.records,
        editable: visit.status === "DRAFT",
        unresolvedReason: null,
      };
    }
    if (lookup?.context && lookup.resolution) {
      return {
        mode: "preview",
        layout: lookup.context.layoutRevision,
        resolution: lookup.resolution,
        componentDefs: lookup.resolution.componentDefs,
        records: [],
        editable: false,
        unresolvedReason: null,
      };
    }
    return null;
  }, [visitId, visit, lookup]);

  useEffect(() => {
    if (selection && workspace && !workspace.layout.locations.some((l) => l.id === selection)) setSelection(null);
  }, [workspace, selection]);

  const select = useCallback((locationId: string, componentId: string | null) => {
    window.__cabinKit?.scene?.markInteraction();
    setSelection(locationId);
    setFocusComponent(componentId);
  }, []);

  const doLookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setLookupBusy(true);
    setLookupError(null);
    try {
      const result = await api.lookup(tail, date);
      setLookup(result);
      setLookupSeq((n) => n + 1);
      setSelection(null);
    } catch (err) {
      setLookup(null);
      setLookupError(
        err instanceof ApiError && err.kind === "network"
          ? "The server could not be reached. Nothing was looked up; retry when the connection is back."
          : (err as Error).message,
      );
    } finally {
      setLookupBusy(false);
    }
  };

  /** Runs a write with one idempotency key that is reused on retry, and reports the outcome honestly. */
  const mutate = (target: string, label: string, op: (key: string) => Promise<VisitEnvelope>, after?: (res: VisitEnvelope) => void) => {
    const key = newKey();
    const attempt = async () => {
      setSaveState({ status: "saving", message: `${label}…`, target });
      try {
        const res = await op(key);
        pending.current = null;
        setVisit(res.visit);
        setSaveState({
          status: "saved",
          message: res.replayed ? "Saved. The earlier attempt had already been stored; nothing was duplicated." : "Saved.",
          target,
        });
        after?.(res);
      } catch (e) {
        if (e instanceof ApiError && e.kind === "network") {
          pending.current = attempt;
          setSaveState({
            status: "unknown",
            message: "Outcome unknown: the server did not answer, so this may or may not have been saved. Retrying is safe and cannot duplicate it.",
            target,
          });
        } else if (
          e instanceof ApiError &&
          (e.code === "STALE_RECORD" || e.code === "STALE_VISIT" || e.code === "VISIT_LOCKED" || e.code === "RECORD_NOT_FOUND")
        ) {
          pending.current = null;
          setSaveState({ status: "conflict", message: `Not saved: ${e.message} The current saved state has been reloaded.`, target });
          if (visitId) void loadVisit(visitId);
        } else if (e instanceof ApiError && e.status >= 500) {
          pending.current = attempt;
          setSaveState({ status: "error", message: `Not saved: ${e.message}`, target });
        } else {
          pending.current = null;
          setSaveState({ status: "error", message: `Not saved: ${(e as Error).message}`, target });
        }
      }
    };
    void attempt();
  };

  const startVisit = () => {
    if (!lookup) return;
    mutate(
      "visit",
      "Creating visit",
      (key) => api.createVisit(lookup.tail, lookup.checkDate, technician, key),
      (res) => {
        remember(res.visit.id);
        navigate(`#/visit/${res.visit.id}`);
      },
    );
  };
  const record = (input: RecordInput, expectedRecordVersion: number) => {
    if (!visit) return;
    mutate(`${input.locationId}|${input.componentId}`, "Saving", (key) => api.upsertRecord(visit.id, input, expectedRecordVersion, key));
  };
  const remove = (r: VisitRecord) => {
    if (!visit) return;
    mutate(`${r.locationId}|${r.componentId}`, "Removing", (key) => api.removeRecord(visit.id, r.locationId, r.componentId, r.version, key));
  };
  const complete = () => {
    if (!visit) return;
    const key = newKey();
    const attempt = async () => {
      setSaveState({ status: "saving", message: "Completing visit…", target: "complete" });
      try {
        await api.complete(visit.id, visit.version, key);
        pending.current = null;
        remember(null);
        navigate(`#/visit/${visit.id}/report`);
      } catch (e) {
        setConfirming(false);
        if (e instanceof ApiError && e.kind === "network") {
          pending.current = attempt;
          setSaveState({
            status: "unknown",
            message:
              "Outcome unknown: the server did not answer, so the visit may or may not be completed. Retrying is safe: completing twice returns the same report.",
            target: "complete",
          });
        } else if (e instanceof ApiError && e.code === "STALE_VISIT") {
          setSaveState({ status: "conflict", message: `Not completed: ${e.message} The current saved work has been reloaded.`, target: "complete" });
          void loadVisit(visit.id);
        } else {
          pending.current = e instanceof ApiError && e.status >= 500 ? attempt : null;
          setSaveState({ status: "error", message: `Not completed: ${(e as Error).message}`, target: "complete" });
        }
      }
    };
    void attempt();
  };

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const location = workspace?.layout.locations.find((l) => l.id === selection) ?? null;
  const info = lookup ? (STATE_TEXT[lookup.state] ?? { title: lookup.state, tone: "bad" as const }) : null;
  const ctx = visitId ? visit?.snapshot.context : lookup?.context;
  const counts = (visitId ? visit?.snapshot.resolution : lookup?.resolution)?.counts;
  const visitSave = saveState.target === "visit" || saveState.target === "complete" ? saveState : null;
  const unresolvedCount = counts ? counts.noMatch + counts.ambiguous : 0;

  return (
    <div className="check-view">
      {!visitId && (
        <section className="panel lookup" aria-labelledby="lookup-h">
          <h2 id="lookup-h">Appearance check</h2>
          <form onSubmit={doLookup} className="lookup-form" noValidate>
            <label className="field">
              <span>Tail number</span>
              <input
                name="tail"
                list="tail-options"
                value={tail}
                onChange={(e) => setTail(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="e.g. N100TL"
              />
              <datalist id="tail-options">
                {tails.map((t) => (
                  <option key={t.tail} value={t.tail}>
                    {t.note}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Appearance-check date</span>
              <input name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Technician (optional)</span>
              <input name="technician" value={technician} maxLength={80} onChange={(e) => setTechnician(e.target.value)} autoComplete="off" />
            </label>
            <button type="submit" className="primary" disabled={lookupBusy}>
              {lookupBusy ? "Looking up…" : "Look up configuration"}
            </button>
          </form>
          <p className="fine">Tails here are fictional fixtures. Effective and expiry dates are inclusive.</p>
          {lastDraft && (
            <p>
              <a href={`#/visit/${lastDraft}`}>Resume the last draft visit</a> · <a href="#/visits">All saved visits</a>
            </p>
          )}
          <div aria-live="polite">
            {lookupError && (
              <div className="alert" role="alert">
                <p>{lookupError}</p>
                <button type="button" onClick={() => doLookup()}>
                  Retry
                </button>
              </div>
            )}
            {lookup && info && (
              <div className={`status-card ${info.tone}`} data-state={lookup.state} data-seq={lookupSeq}>
                <h3>
                  {info.title} <span className="code">{lookup.state}</span>
                </h3>
                <p>{lookup.message}</p>
                {lookup.assignmentsConsidered && lookup.assignmentsConsidered.length > 0 && !lookup.context && (
                  <table className="compact">
                    <caption>Configurations on record for {lookup.tail}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Variant</th>
                        <th scope="col">Status</th>
                        <th scope="col">Effective (inclusive)</th>
                        <th scope="col">Covers {lookup.checkDate}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lookup.assignmentsConsidered.map((a) => (
                        <tr key={a.id}>
                          <td>{a.variantId}</td>
                          <td>{a.status}</td>
                          <td>
                            {a.effectiveFrom} to {a.effectiveTo ?? "open"}
                          </td>
                          <td>{a.coversDate ? "yes" : "no"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {lookup.context && (
                  <div className="actions">
                    <button type="button" className="primary" onClick={startVisit} disabled={saveState.status === "saving"}>
                      Start visit (saves a draft)
                    </button>
                    <a className="button" href={`#/prep?tail=${encodeURIComponent(lookup.tail)}&date=${lookup.checkDate}`}>
                      Preparation parts list
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {visitId && (
        <section className="panel visit-head" aria-labelledby="visit-h">
          <h2 id="visit-h">{visit ? `Visit #${visit.number} · ${visit.tail} · ${visit.checkDate}` : "Visit"}</h2>
          {visitLoading && !visit && <p role="status">Loading visit…</p>}
          {visitError && (
            <div className="alert" role="alert">
              <p>{visitError}</p>
              <button type="button" onClick={() => loadVisit(visitId)}>
                Retry
              </button>
            </div>
          )}
          {visit && (
            <div className="head-row">
              <div className="head-main">
                <p>
                  <span className={`pill ${visit.status === "DRAFT" ? "draft" : "recorded"}`}>
                    {visit.status === "DRAFT" ? "Draft" : "Completed and locked"}
                  </span>{" "}
                  Technician: {visit.technician || "not entered"} · Configuration frozen {visit.snapshot.capturedAt.slice(0, 19).replace("T", " ")} UTC from
                  release {visit.referenceReleaseId}.
                </p>
                <p className="fine">
                  This visit keeps its own frozen configuration and parts rules. Looking up another tail or date never changes it.
                  {referenceChanged && (
                    <strong className="advisory-inline" role="note">
                      {" "}
                      Reference data has been updated since this visit was created. This visit is not rebased: it still uses its frozen snapshot.
                    </strong>
                  )}
                </p>
              </div>
              <div className="actions">
                <a className="button" href={`#/visit/${visit.id}/prep`}>
                  Preparation parts list
                </a>
                <a className="button" href={`#/visit/${visit.id}/report`}>
                  {visit.status === "DRAFT" ? "Preview report" : "Open report"}
                </a>
                <a className="button" href="#/check">
                  New check
                </a>
              </div>
            </div>
          )}
        </section>
      )}

      {visitSave && visitSave.status !== "idle" && (
        <div className={`save-banner ${visitSave.status}`} role={visitSave.status === "saving" || visitSave.status === "saved" ? "status" : "alert"}>
          <p>{visitSave.message}</p>
          {pending.current && visitSave.status !== "saving" && (
            <button type="button" onClick={() => pending.current?.()}>
              Retry safely
            </button>
          )}
        </div>
      )}

      {workspace && ctx && (
        <>
          <section className="panel config" aria-label="Effective configuration">
            <dl className="facts wide">
              <dt>Variant</dt>
              <dd>
                {ctx.variant.id} · {ctx.variant.name}
              </dd>
              <dt>Layout</dt>
              <dd>
                {ctx.layoutRevision.id} · {workspace.layout.locations.filter((l) => l.kind === "SEAT").length} seats
              </dd>
              <dt>Carpet / seam</dt>
              <dd>
                {ctx.assignment.carpet ?? "not stated"} / {ctx.assignment.seam ?? "not stated"}
              </dd>
              <dt>Effective</dt>
              <dd>
                {ctx.assignment.effectiveFrom} to {ctx.assignment.effectiveTo ?? "open"}
              </dd>
              <dt>Source</dt>
              <dd>
                {ctx.configurationSource.id} rev {ctx.configurationSource.revision}
              </dd>
              <dt>Components</dt>
              <dd>
                {counts?.resolved ?? 0} with a part{unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ""}
              </dd>
              <dt>Data</dt>
              <dd>Fictional fixture ({ctx.layoutRevision.namespace} namespace)</dd>
            </dl>
          </section>

          <div className="workspace">
            <Viewer workspace={workspace} selection={selection} onSelect={select} visualProfiles={visualProfiles} />
            <aside className="side" aria-label="Selected location and recorded work">
              <Inspector
                workspace={workspace}
                location={location}
                focusComponent={focusComponent}
                saveState={saveState}
                onRecord={record}
                onRemove={remove}
                onRetry={() => pending.current?.()}
                onSelect={(id) => select(id, null)}
              />
              {visit && visitId && (
                <section className="worklist" aria-labelledby="work-h">
                  <h3 id="work-h">
                    Recorded work <span className="count">({visit.records.length})</span>
                  </h3>
                  {visit.records.length === 0 ? (
                    <p>Nothing recorded yet. A visit can only be completed with at least one replacement.</p>
                  ) : (
                    <ul className="records">
                      {visit.records.map((r) => (
                        <li key={`${r.locationId}|${r.componentId}`}>
                          <div>
                            <strong>{r.locationLabel}</strong> · {r.componentName}
                            <br />
                            <span className="fine">
                              {r.selection === "ALTERNATE" ? "Alternate" : "Primary"}: {r.lines.map((l) => `${l.partNo} ${l.qty} ${l.unit}`).join(", ")}
                              {r.note ? ` — ${r.note}` : ""}
                            </span>
                          </div>
                          <div className="row-actions">
                            <button type="button" onClick={() => select(r.locationId, r.componentId)} aria-label={`Show ${r.locationLabel} ${r.componentName}`}>
                              Show
                            </button>
                            {visit.status === "DRAFT" && (
                              <button type="button" className="danger" onClick={() => remove(r)} aria-label={`Remove ${r.locationLabel} ${r.componentName}`}>
                                Remove
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {visit.status === "DRAFT" && !confirming && (
                    <button type="button" className="primary" disabled={visit.records.length === 0} onClick={() => setConfirming(true)}>
                      Complete visit…
                    </button>
                  )}
                  {confirming && (
                    <div className="confirm" role="alertdialog" aria-labelledby="confirm-h" aria-describedby="confirm-d">
                      <h4 id="confirm-h" tabIndex={-1} ref={confirmRef}>
                        Complete and lock this visit?
                      </h4>
                      <p id="confirm-d">
                        {visit.records.length} record{visit.records.length === 1 ? "" : "s"} will be locked into the after-action report for {visit.tail} on{" "}
                        {visit.checkDate}. Completed visits cannot be edited.
                        {unresolvedCount > 0 ? ` ${unresolvedCount} unresolved components will be listed as gaps.` : ""}
                      </p>
                      <div className="actions">
                        <button type="button" className="primary" onClick={complete} disabled={saveState.status === "saving"}>
                          Confirm completion
                        </button>
                        <button type="button" onClick={() => setConfirming(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
