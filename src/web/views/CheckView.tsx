import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalJson } from "../../domain/canonical.ts";
import type { RecordInput, VisitRecord, VisualProfile } from "../../domain/types.ts";
import { ApiError, api, type VisitEnvelope, type VisitStateEnvelope } from "../api.ts";
import { Inspector } from "../components/Inspector.tsx";
import { Viewer } from "../components/Viewer.tsx";
import { canRetry, describeSaveStatus, recordTarget, type SaveStatus, saveStatusClass, useMutations } from "../hooks/useMutations.ts";
import { useResource } from "../hooks/useResource.ts";
import type { Workspace } from "../model.ts";
import { formatRoute } from "../routes.ts";

interface Props {
  visitId: string | null;
  /** The lookup the route asks for (check view only). A change runs the lookup. */
  tail?: string | null;
  date?: string | null;
  /** Called when a visit has loaded, so the page title can name it. */
  onVisit?: (meta: { id: string; number: number; tail: string }) => void;
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

/** What a write on an open visit answers: the visit without its snapshot, plus write-specific fields. */
type WriteResult = VisitStateEnvelope | Awaited<ReturnType<typeof api.complete>>;

/** The banner line for the visit-level writes (create, complete). */
function bannerText(target: "create" | "complete", status: SaveStatus): string {
  if (status.phase === "saving") return target === "create" ? "Creating visit…" : "Completing visit…";
  if (target === "complete" && status.phase === "unknown")
    return "Outcome unknown: the server did not answer, so the visit may or may not be completed. Retrying is safe: completing twice returns the same report.";
  const refused = target === "complete" && (status.phase === "failed" || status.phase === "conflict") ? `Not completed: ${status.message}` : null;
  if (status.phase === "conflict") return `${refused ?? describeSaveStatus(status)} The current saved work has been reloaded.`;
  return refused ?? describeSaveStatus(status);
}

/** A visit answer older than the copy on screen (a write answer overtook the read) is not applied. */
const olderVisit = (incoming: VisitEnvelope, shown: VisitEnvelope): boolean =>
  incoming.visit.id === shown.visit.id && incoming.visit.version < shown.visit.version;

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
const TECHNICIAN_KEY = "cabin-kit.technician";
function savedTechnician(): string {
  try {
    return sessionStorage.getItem(TECHNICIAN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveTechnician(name: string): void {
  try {
    sessionStorage.setItem(TECHNICIAN_KEY, name);
  } catch {
    /* the name is only a convenience between lookups */
  }
}
function recall(): string | null {
  try {
    return localStorage.getItem("cabin-kit:last-visit");
  } catch {
    return null;
  }
}

export function CheckView({ visitId, tail: routeTail = null, date: routeDate = null, onVisit, navigate, visualProfiles }: Props) {
  const [tails, setTails] = useState<{ tail: string; note: string }[]>([]);
  const [tail, setTail] = useState("");
  const [date, setDate] = useState(today());
  const [technician, setTechnician] = useState(savedTechnician);
  const [lookupSeq, setLookupSeq] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [focusComponent, setFocusComponent] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLHeadingElement | null>(null);
  const [lastDraft, setLastDraft] = useState<string | null>(recall);
  // A lookup the route cannot hold (an empty tail, which the server reports as invalid input), tied to the route it was made on.
  const [unrouted, setUnrouted] = useState<{ tail: string; date: string; route: string } | null>(null);

  // The pointer to the last draft is only offered while that draft still exists and is still a draft.
  useEffect(() => {
    const id = recall();
    if (!id || visitId) return;
    let stopped = false;
    api
      .visit(id)
      .then((res) => {
        if (stopped || res.visit.status === "DRAFT") return;
        remember(null);
        setLastDraft(null);
      })
      .catch((e) => {
        if (stopped || !(e instanceof ApiError) || e.status !== 404) return;
        remember(null);
        setLastDraft(null);
      });
    return () => {
      stopped = true;
    };
  }, [visitId]);

  useEffect(() => {
    api
      .tails()
      .then((r) => setTails(r.tails))
      .catch(() => setTails([]));
  }, []);

  // App keys this view by visit, so a new visit is a new component; the key still keeps an answer for one visit off another.
  const visitRes = useResource(visitId ? `visit:${visitId}` : null, (signal) => api.visit(visitId ?? "", { signal }), { isOlder: olderVisit });
  const visit = visitRes.data?.visit ?? null;
  const referenceChanged = visitRes.data?.referenceNow?.changedSinceVisit ?? false;
  const visitLoading = visitRes.state === "loading";
  const visitError =
    visitRes.state !== "error"
      ? null
      : visitRes.error.kind === "network"
        ? "The server could not be reached. Your saved work is still on the server; retry when the connection is back."
        : visitRes.error.message;
  const reloadVisit = visitRes.reload;
  const setVisit = visitRes.set;
  const loadedId = visit?.id;
  const loadedStatus = visit?.status;
  const loadedNumber = visit?.number;
  const loadedTail = visit?.tail;
  useEffect(() => {
    if (!loadedId || loadedNumber === undefined || loadedTail === undefined) return;
    if (loadedStatus === "DRAFT") remember(loadedId);
    else if (recall() === loadedId) remember(null);
    onVisit?.({ id: loadedId, number: loadedNumber, tail: loadedTail });
  }, [loadedId, loadedStatus, loadedNumber, loadedTail, onVisit]);
  const visitMissing = visitRes.state === "error" && visitRes.error.status === 404;
  useEffect(() => {
    if (visitMissing && visitId && recall() === visitId) remember(null);
  }, [visitMissing, visitId]);

  // Creating a visit has no visit on screen yet, so its answer navigates instead of merging (PF-18).
  const creation = useMutations<VisitEnvelope>((res) => {
    remember(res.visit.id);
    navigate(`#/visit/${res.visit.id}`);
  });
  // Answers apply in call order; one older than the copy on screen (another tab wrote since) is not applied.
  // A replayed answer may be the response stored when the write first ran, older than the visit is now, so the
  // visit is read again instead of trusting it.
  const writes = useMutations<WriteResult>((res) => {
    if (res.replayed) {
      reloadVisit();
      return;
    }
    setVisit((cur) =>
      cur && cur.visit.id === res.visit.id && res.visit.version >= cur.visit.version ? { ...cur, visit: { ...res.visit, snapshot: cur.visit.snapshot } } : cur,
    );
  });

  // The route holds the lookup: Back, Forward and reload bring it back. A route without a tail has none.
  const routeString = formatRoute({ name: "check", tail: routeTail, date: routeDate });
  const unroutedHere = !visitId && unrouted?.route === routeString ? unrouted : null;
  // Leaving the route drops it, so coming back with Back shows what the route holds, not the earlier unrouted lookup.
  useEffect(() => {
    setUnrouted((u) => (u && u.route !== routeString ? null : u));
  }, [routeString]);
  const lookupFor = unroutedHere ?? (!visitId && routeTail ? { tail: routeTail, date: routeDate ?? today() } : null);
  const lookupKey = lookupFor ? `lookup:${lookupFor.tail}:${lookupFor.date}` : null;
  const lookupRes = useResource(lookupKey, (signal) => api.lookup(lookupFor?.tail ?? "", lookupFor?.date ?? "", { signal }));
  // An error clears the result, as before: a stale result must not invite starting a visit from it.
  const lookup = lookupRes.state === "error" ? null : (lookupRes.data ?? null);
  const lookupBusy = lookupRes.state === "loading";
  const lookupError =
    lookupRes.state !== "error"
      ? null
      : lookupRes.error.kind === "network"
        ? "The server could not be reached. Nothing was looked up; retry when the connection is back."
        : lookupRes.error.message;
  const lookupAnswer = lookupRes.state === "ready" ? lookupRes.data : null;
  useEffect(() => {
    if (!lookupAnswer) return;
    setLookupSeq((n) => n + 1);
    setSelection(null);
  }, [lookupAnswer]);

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

  // Cards report typed input that is not saved. Leaving the location or completing the visit asks first.
  const [dirtyTargets, setDirtyTargets] = useState<ReadonlySet<string>>(new Set());
  const onDirtyChange = useCallback((target: string, dirty: boolean) => {
    setDirtyTargets((cur) => {
      if (cur.has(target) === dirty) return cur;
      const next = new Set(cur);
      if (dirty) next.add(target);
      else next.delete(target);
      return next;
    });
  }, []);
  /** True when nothing unrecorded is lost, or the person agreed to lose it. */
  const [resetKey, setResetKey] = useState(0);
  const mayDiscard = (): boolean => {
    if (dirtyTargets.size === 0 || !workspace) return true;
    const names = [...dirtyTargets].map((target) => {
      const [locationId = "", componentId = ""] = target.slice("record:".length).split("|");
      return `${workspace.layout.locations.find((l) => l.id === locationId)?.label ?? locationId} / ${workspace.componentDefs[componentId]?.name ?? componentId}`;
    });
    // Task 4.6 replaces this with the confirm dialog ("Discard" / "Go back").
    const text = names.length === 1 ? `an unrecorded change for ${names[0]}. Discard it?` : `unrecorded changes for ${names.join("; ")}. Discard them?`;
    return window.confirm(`You have ${text}`);
  };
  /** Agreeing to discard really resets the forms, so the draft does not outlive the answer. */
  const discardAll = (): boolean => {
    if (!mayDiscard()) return false;
    if (dirtyTargets.size > 0) setResetKey((k) => k + 1);
    return true;
  };
  const select = (locationId: string, componentId: string | null) => {
    if (locationId !== selection && !mayDiscard()) return;
    window.__cabinKit?.scene?.markInteraction();
    setSelection(locationId);
    setFocusComponent(componentId);
  };

  // A reload or close would lose typed input, or leave a save whose outcome is not known.
  const guardUnload = dirtyTargets.size > 0 || writes.anyUnknown || creation.anyUnknown;
  useEffect(() => {
    if (!guardUnload) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guardUnload]);

  // The form follows the route, so a lookup restored by Back or reload shows what it looked up.
  useEffect(() => {
    if (visitId || !routeTail) return;
    setTail(routeTail);
    setDate(routeDate ?? today());
  }, [visitId, routeTail, routeDate]);

  /** Submitting writes the lookup into the URL, which runs it. The same lookup again reloads it, as the URL does not change. */
  const doLookup = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = tail.trim();
    if (trimmed) {
      const wanted = formatRoute({ name: "check", tail: trimmed, date: date || null });
      setUnrouted(null);
      if (wanted !== routeString) navigate(wanted);
      else if (!unroutedHere) lookupRes.reload();
      return;
    }
    const next = { tail, date, route: routeString };
    if (unroutedHere && unroutedHere.tail === tail && unroutedHere.date === date) lookupRes.reload();
    else setUnrouted(next);
  };

  /** After a conflict the saved state changed elsewhere: reload it so the person sees what is stored now. */
  const reloadOnConflict = (target: string) => {
    if (visitId && writes.statusOf(target).phase === "conflict") reloadVisit();
  };
  const startVisit = () => {
    if (!lookup) return;
    const request = { tail: lookup.tail, date: lookup.checkDate, technician };
    void creation.run("create", (key) => api.createVisit(request.tail, request.date, request.technician, key), canonicalJson(request));
  };
  const record = async (input: RecordInput, expectedRecordVersion: number) => {
    if (!visit) return;
    const id = visit.id;
    const target = recordTarget(input.locationId, input.componentId);
    await writes.run(target, (key) => api.upsertRecord(id, input, expectedRecordVersion, key), canonicalJson({ record: input, expectedRecordVersion }));
    reloadOnConflict(target);
  };
  const remove = async (r: VisitRecord) => {
    if (!visit) return;
    const id = visit.id;
    const target = recordTarget(r.locationId, r.componentId);
    const request = { locationId: r.locationId, componentId: r.componentId, expectedRecordVersion: r.version };
    await writes.run(
      target,
      (key) => api.removeRecord(id, request.locationId, request.componentId, request.expectedRecordVersion, key),
      canonicalJson(request),
    );
    reloadOnConflict(target);
  };
  const finishCompletion = (res: WriteResult) => {
    remember(null);
    navigate(`#/visit/${res.visit.id}/report`);
  };
  const retry = async (target: string) => {
    const res = await writes.retry(target);
    if (target === "complete" && res) finishCompletion(res);
    reloadOnConflict(target);
  };
  const complete = async () => {
    if (!visit) return;
    const id = visit.id;
    const expectedVisitVersion = visit.version;
    const res = await writes.run("complete", (key) => api.complete(id, expectedVisitVersion, key), canonicalJson({ confirm: true, expectedVisitVersion }));
    if (res) finishCompletion(res);
    else {
      setConfirming(false);
      reloadOnConflict("complete");
    }
  };

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const location = workspace?.layout.locations.find((l) => l.id === selection) ?? null;
  const info = lookup ? (STATE_TEXT[lookup.state] ?? { title: lookup.state, tone: "bad" as const }) : null;
  const ctx = visitId ? visit?.snapshot.context : lookup?.context;
  const counts = (visitId ? visit?.snapshot.resolution : lookup?.resolution)?.counts;
  const bannerTarget = visitId ? "complete" : "create";
  const bannerWrites = visitId ? writes : creation;
  const bannerStatus = bannerWrites.statusOf(bannerTarget);
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
              <input
                name="technician"
                value={technician}
                maxLength={80}
                onChange={(e) => {
                  setTechnician(e.target.value);
                  saveTechnician(e.target.value);
                }}
                autoComplete="off"
              />
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
                          <td>
                            {a.status}
                            {a.reason ? ` (${a.reason})` : ""}
                          </td>
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
                    <button type="button" className="primary" onClick={startVisit} disabled={creation.isBusy("create")}>
                      Start visit (saves a draft)
                    </button>
                    <a className="button" href={formatRoute({ name: "prep", visitId: null, tail: lookup.tail, date: lookup.checkDate })}>
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
              <button type="button" onClick={reloadVisit}>
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

      {bannerStatus.phase !== "idle" && (
        <div
          className={`save-banner ${saveStatusClass(bannerStatus)}`}
          role={bannerStatus.phase === "saving" || bannerStatus.phase === "saved" ? "status" : "alert"}
        >
          <p>{bannerText(bannerTarget, bannerStatus)}</p>
          {canRetry(bannerStatus) && (
            <button type="button" onClick={() => (visitId ? void retry("complete") : void creation.retry("create"))}>
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
                statusOf={writes.statusOf}
                onRecord={record}
                onRemove={remove}
                onRetry={retry}
                onDirtyChange={onDirtyChange}
                resetKey={resetKey}
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
                              <button
                                type="button"
                                className="danger"
                                disabled={writes.isBusy(recordTarget(r.locationId, r.componentId))}
                                onClick={() => void remove(r)}
                                aria-label={`Remove ${r.locationLabel} ${r.componentName}`}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {visit.status === "DRAFT" && !confirming && (
                    <button type="button" className="primary" disabled={visit.records.length === 0} onClick={() => discardAll() && setConfirming(true)}>
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
                      {writes.anyBusy && <p className="fine">Waiting for saves in progress to finish before completing.</p>}
                      {!writes.anyBusy && writes.anyUnknown && (
                        <p className="fine">A save has an unknown outcome. Retry it safely before completing, so the report includes it.</p>
                      )}
                      <div className="actions">
                        {/* the expected visit version is taken at the click: a queued or unresolved save would make it stale */}
                        <button type="button" className="primary" onClick={() => void complete()} disabled={writes.anyBusy || writes.anyUnknown}>
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
