import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalJson } from "../../domain/canonical.ts";
import type { Observation, ObservationInput, RecordInput, VisitRecord, VisualProfile } from "../../domain/types.ts";
import { ApiError, api, type VisitEnvelope, type VisitStateEnvelope } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { loadSceneModule } from "../components/sceneModule.ts";
import { type ToastOptions, useToast } from "../components/Toasts.tsx";
import { Viewer } from "../components/Viewer.tsx";
import { conditionLabel, formatDate, formatDateTime, outcomeLabel } from "../format.ts";
import {
  canRetry,
  describeSaveStatus,
  observationTarget,
  recordTarget,
  type SaveStatus,
  saveStatusClass,
  UNKNOWN_OUTCOME,
  useMutations,
} from "../hooks/useMutations.ts";
import { useResource } from "../hooks/useResource.ts";
import { openMustFix, type Workspace } from "../model.ts";
import { formatRoute } from "../routes.ts";
import { forgetSuggestionKeys, submitOnEnter } from "../submitOnEnter.ts";

/** Only the e2e build (`npm run build:e2e`) sets this; see Cabin3D.tsx. */
const TEST_HOOKS = import.meta.env.VITE_TEST_HOOKS === "1";

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
  // A refused retry after an unknown outcome keeps its own message: the server did answer, but only for the retry.
  if (target === "complete" && status.phase === "unknown" && status.message === UNKNOWN_OUTCOME)
    return "Outcome unknown: the server did not answer, so the visit may or may not be completed. Retrying is safe: completing twice returns the same report.";
  const refused = target === "complete" && (status.phase === "failed" || status.phase === "conflict") ? `Not completed: ${status.message}` : null;
  if (status.phase === "conflict") return `${refused ?? describeSaveStatus(status)} The current saved work has been reloaded.`;
  return refused ?? describeSaveStatus(status);
}

/** A visit answer older than the copy on screen (a write answer overtook the read) is not applied. */
const olderVisit = (incoming: VisitEnvelope, shown: VisitEnvelope): boolean =>
  incoming.visit.id === shown.visit.id && incoming.visit.version < shown.visit.version;

/** "Seat 3A / Seat cushion": how a record is named in a toast. */
const recordName = (r: VisitRecord): string => `${r.locationLabel} / ${r.componentName}`;

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
  // Completion: the "Aircraft held" answer, and the problems the server still named as must-fix (a race with another tab).
  const [held, setHeld] = useState(false);
  const [serverMustFix, setServerMustFix] = useState<string[] | null>(null);
  const [lastDraft, setLastDraft] = useState<string | null>(recall);
  // A lookup the route cannot hold (an empty tail, which the server reports as invalid input), tied to the route it was made on.
  const [unrouted, setUnrouted] = useState<{ tail: string; date: string; route: string } | null>(null);
  const { show } = useToast();
  // This view's toasts (Undo above all) belong to it: they are withdrawn when the view goes, so an Undo can never act
  // on a visit that is no longer on screen.
  const ownToasts = useRef(new Set<() => void>());
  useEffect(() => {
    const owned = ownToasts.current;
    return () => {
      for (const withdraw of owned) withdraw();
      owned.clear();
    };
  }, []);
  const toast = useMemo(
    () => ({
      show: (message: string, options?: ToastOptions) => {
        const withdraw = show(message, options);
        ownToasts.current.add(withdraw);
      },
    }),
    [show],
  );
  // After Undo, focus goes to the parts of the restored location (WEB-21).
  const [focusInspector, setFocusInspector] = useState(0);
  useEffect(() => {
    if (focusInspector > 0) document.getElementById("inspector-heading")?.focus();
  }, [focusInspector]);

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
  // the scene chunk downloads while the visit is fetched, not after it (Task 6.5); a failure shows when Cabin3D loads it
  useEffect(() => {
    if (visitId) loadSceneModule().catch(() => {});
  }, [visitId]);
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
        observations: visit.observations,
        carried: visit.carried,
        checkDate: visit.checkDate,
        mel: visit.snapshot.mel ?? [],
        variantId: visit.snapshot.context.variant.id,
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
        observations: [],
        carried: [],
        checkDate: lookup.checkDate,
        mel: [],
        variantId: lookup.context.variant.id,
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
  /** "Seat 3A / Seat cushion": a location and component named as the record list and toasts name them. */
  const nameOf = (locationId: string, componentId: string): string =>
    `${workspace?.layout.locations.find((l) => l.id === locationId)?.label ?? locationId} / ${workspace?.componentDefs[componentId]?.name ?? componentId}`;
  const [resetKey, setResetKey] = useState(0);
  /** What waits for the person to discard their unrecorded input, and whose input it is. */
  const [pendingDiscard, setPendingDiscard] = useState<{ names: string[]; proceed: () => void } | null>(null);
  /** Runs `proceed` at once when nothing unrecorded would be lost; otherwise asks first, and Discard really resets the forms. */
  const afterDiscard = (proceed: () => void) => {
    if (dirtyTargets.size === 0 || !workspace) {
      proceed();
      return;
    }
    const names = [...dirtyTargets].map((target) => {
      const [locationId = "", componentId = ""] = target.slice("record:".length).split("|");
      return nameOf(locationId, componentId);
    });
    setPendingDiscard({
      names,
      proceed: () => {
        setResetKey((k) => k + 1);
        proceed();
      },
    });
  };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const dirtyRef = useRef(dirtyTargets);
  dirtyRef.current = dirtyTargets;
  const select = (locationId: string, componentId: string | null) => {
    const apply = () => {
      if (TEST_HOOKS) window.__cabinKit?.scene?.markInteraction();
      setSelection(locationId);
      setFocusComponent(componentId);
    };
    if (locationId === selection) apply();
    else afterDiscard(apply);
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
  /**
   * A change refused because the visit was completed elsewhere: the reload shows the locked visit, which drops the form
   * and its own "Not saved" line, so the person is told in a toast that stays until they dismiss it.
   */
  const reportLocked = (target: string, name: string) => {
    const status = writes.statusOf(target);
    if (status.phase === "conflict" && status.code === "VISIT_LOCKED") {
      toast.show(`Not saved: ${name}. The visit was completed elsewhere; this change is not in the report.`, { durationMs: null });
    }
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
    reportLocked(target, nameOf(input.locationId, input.componentId));
    reloadOnConflict(target);
  };
  const remove = async (r: VisitRecord) => {
    if (!visit) return;
    const id = visit.id;
    const target = recordTarget(r.locationId, r.componentId);
    const request = { locationId: r.locationId, componentId: r.componentId, expectedRecordVersion: r.version };
    const removed = await writes.run(
      target,
      (key) => api.removeRecord(id, request.locationId, request.componentId, request.expectedRecordVersion, key),
      canonicalJson(request),
    );
    reportLocked(target, recordName(r));
    reloadOnConflict(target);
    // Undo is offered only for a removal the server confirmed; an unknown outcome keeps its own "Retry safely".
    if (removed) toast.show(`Removed ${recordName(r)}.`, { action: { label: "Undo", run: () => void undoRemove(id, r) } });
  };
  /** A problem write: through the write queue, so an unknown outcome is retried with the same key. True once saved. */
  const writeObservation = async (target: string, name: string, send: (id: string, key: string) => Promise<WriteResult>, request: unknown) => {
    if (!visit) return false;
    const id = visit.id;
    const saved = await writes.run(target, (key) => send(id, key), canonicalJson(request));
    reportLocked(target, name);
    reloadOnConflict(target);
    return saved !== undefined;
  };
  const observe = (input: ObservationInput) =>
    writeObservation(observationTarget(input), nameOf(input.locationId, input.componentId), (id, key) => api.addObservation(id, input, key), {
      observation: input,
    });
  const updateObservation = (o: Observation, input: ObservationInput) =>
    writeObservation(observationTarget(o), `${o.locationLabel} / ${o.componentName}`, (id, key) => api.updateObservation(id, o.id, input, o.version, key), {
      observation: input,
      expectedVersion: o.version,
    });
  const closeObservation = (o: Observation, closedAs: "REPLACED" | "FIXED") =>
    void writeObservation(
      observationTarget(o),
      `${o.locationLabel} / ${o.componentName}`,
      (id, key) => api.closeObservation(id, o.id, closedAs, o.version, key),
      { closedAs, expectedVersion: o.version },
    );

  /**
   * Puts a removed record back: the same record sent again through the write queue, as a new record (version 0), so it
   * gets its own idempotency key. Nothing is sent while that record has a save in flight or an outcome that is not known.
   */
  const undoRemove = async (id: string, r: VisitRecord) => {
    const target = recordTarget(r.locationId, r.componentId);
    const phase = writes.statusOf(target).phase;
    if (phase === "saving" || phase === "unknown") return;
    const input: RecordInput = {
      locationId: r.locationId,
      componentId: r.componentId,
      selection: r.selection,
      substituteId: r.substituteId,
      quantity: r.quantity,
      note: r.note,
    };
    const restored = await writes.run(target, (key) => api.upsertRecord(id, input, 0, key), canonicalJson({ record: input, expectedRecordVersion: 0 }));
    const status = writes.statusOf(target);
    reloadOnConflict(target);
    if (restored) {
      toast.show(`Restored ${recordName(r)}.`);
      // Shown at once unless leaving the selected location would drop unrecorded input elsewhere.
      if (r.locationId === selectionRef.current || dirtyRef.current.size === 0) {
        setSelection(r.locationId);
        setFocusComponent(r.componentId);
        setFocusInspector((n) => n + 1);
      }
    } else if (status.phase === "conflict") toast.show(`${describeSaveStatus(status)} The current saved work has been reloaded.`);
    else if (canRetry(status)) toast.show(describeSaveStatus(status), { action: { label: "Retry safely", run: () => void retry(target) } });
    else if (status.phase !== "idle") toast.show(describeSaveStatus(status));
  };
  const finishCompletion = (res: WriteResult) => {
    remember(null);
    navigate(`#/visit/${res.visit.id}/report`);
  };
  const retry = async (target: string) => {
    const res = await writes.retry(target);
    if (target === "complete" && res) finishCompletion(res);
    reloadOnConflict(target);
    return res !== undefined;
  };
  const mustFix = workspace?.mode === "visit" ? openMustFix(workspace) : [];
  const needsHold = mustFix.length > 0 || serverMustFix !== null;
  const complete = async () => {
    if (!visit || (needsHold && !held)) return;
    const id = visit.id;
    const expectedVisitVersion = visit.version;
    // sent only as true, and part of the request, so a retry of an unknown outcome repeats exactly this request
    const aircraftHeld = needsHold ? true : undefined;
    let mustFixOpen = false;
    const res = await writes.run(
      "complete",
      async (key) => {
        try {
          return await api.complete(id, expectedVisitVersion, key, aircraftHeld);
        } catch (e) {
          if (e instanceof ApiError && e.code === "MUST_FIX_OPEN") {
            mustFixOpen = true;
            setServerMustFix((e.details as { observationIds?: string[] } | null)?.observationIds ?? []);
          }
          throw e;
        }
      },
      canonicalJson({ confirm: true, expectedVisitVersion, ...(aircraftHeld ? { aircraftHeld } : {}) }),
    );
    if (res) finishCompletion(res);
    else if (mustFixOpen) reloadVisit();
    else {
      setConfirming(false);
      reloadOnConflict("complete");
    }
  };
  const unlisted = (serverMustFix ?? []).filter((id) => !mustFix.some((m) => m.observation.id === id)).length;
  /** "Seat 3A / Seat belt": a problem named where it sits on this layout, or where it was when it no longer fits. */
  const problemName = (o: Observation, locationId: string | null) =>
    locationId ? nameOf(locationId, o.componentId) : `${o.locationLabel} / ${o.componentName}`;
  /** Condition, outcome and fix-by date (or since when it is overdue), in words. */
  const problemFacts = (o: Observation, overdue: boolean) =>
    [conditionLabel(o.condition), outcomeLabel(o.outcome), o.dueDate ? `${overdue ? "Overdue since" : "Fix by"} ${formatDate(o.dueDate)}` : ""]
      .filter((t) => t !== "")
      .join(" · ");

  const location = workspace?.layout.locations.find((l) => l.id === selection) ?? null;
  const info = lookup ? (STATE_TEXT[lookup.state] ?? { title: "The lookup could not be completed", tone: "bad" as const }) : null;
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
          <h2 id="lookup-h" tabIndex={-1}>
            Appearance check
          </h2>
          <form onSubmit={doLookup} className="lookup-form" noValidate>
            <label className="field">
              <span>Tail number</span>
              <input
                name="tail"
                list="tail-options"
                value={tail}
                onChange={(e) => setTail(e.target.value)}
                onKeyDown={submitOnEnter}
                onInput={forgetSuggestionKeys}
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
                <h3>{info.title}</h3>
                <p>{lookup.message}</p>
                {lookup.assignmentsConsidered && lookup.assignmentsConsidered.length > 0 && !lookup.context && (
                  <table className="compact">
                    <caption>Configurations on record for {lookup.tail}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Variant</th>
                        <th scope="col">Status</th>
                        <th scope="col">Effective (inclusive)</th>
                        <th scope="col">Covers {formatDate(lookup.checkDate)}</th>
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
                            {formatDate(a.effectiveFrom)} to {a.effectiveTo ? formatDate(a.effectiveTo) : "open"}
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
        <section className="panel visit-head" aria-labelledby="visit-h" aria-busy={visitLoading && !visit}>
          <h2 id="visit-h" tabIndex={-1}>
            {visit ? `Visit #${visit.number} · ${visit.tail} · ${formatDate(visit.checkDate)}` : "Visit"}
          </h2>
          {visitLoading && !visit && <Skeleton thing="visit" shape="workspace" />}
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
                  Technician: {visit.technician || "not entered"} · Configuration frozen{" "}
                  <time dateTime={visit.snapshot.capturedAt} title={visit.snapshot.capturedAt}>
                    {formatDateTime(visit.snapshot.capturedAt)}
                  </time>{" "}
                  from release {visit.referenceReleaseId}.
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
                {formatDate(ctx.assignment.effectiveFrom)} to {ctx.assignment.effectiveTo ? formatDate(ctx.assignment.effectiveTo) : "open"}
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
                onObserve={observe}
                onUpdateObservation={updateObservation}
                onCloseObservation={closeObservation}
                resetKey={resetKey}
                onSelect={(id) => select(id, null)}
              />
              {visit && visitId && visit.carried.length > 0 && (
                <section className="worklist" aria-labelledby="carried-h">
                  <h3 id="carried-h">
                    Carried over <span className="count">({visit.carried.length})</span>
                  </h3>
                  {[false, true].map((orphaned) => {
                    const items = visit.carried.filter((c) => (c.locationId === null) === orphaned);
                    if (items.length === 0) return null;
                    return (
                      <div key={String(orphaned)}>
                        {orphaned && <h4>No longer at this position</h4>}
                        <ul className="records">
                          {items.map(({ observation: o, locationId, overdue }) => {
                            const name = problemName(o, locationId);
                            const saving = writes.statusOf(observationTarget(o));
                            return (
                              <li key={o.id}>
                                <div>
                                  <strong>{name}</strong>
                                  <br />
                                  <span className={overdue ? "must-fix" : "fine"}>{problemFacts(o, overdue)}</span>
                                  {/* a placed item shows its saves on its piece; one no longer at its position shows them here */}
                                  {!locationId && saving.phase !== "idle" && (
                                    <p role="status" className={`save-state ${saveStatusClass(saving)}`}>
                                      {describeSaveStatus(saving)}{" "}
                                      {canRetry(saving) && (
                                        <button type="button" onClick={() => void retry(observationTarget(o))}>
                                          Retry safely
                                        </button>
                                      )}
                                    </p>
                                  )}
                                </div>
                                <div className="row-actions">
                                  {locationId ? (
                                    <button type="button" onClick={() => select(locationId, o.componentId)} aria-label={`Show ${name.replace(" / ", " ")}`}>
                                      Show
                                    </button>
                                  ) : (
                                    visit.status === "DRAFT" && (
                                      <button
                                        type="button"
                                        disabled={writes.isBusy(observationTarget(o))}
                                        onClick={() => closeObservation(o, "FIXED")}
                                        aria-label={`Mark fixed ${name.replace(" / ", " ")}`}
                                      >
                                        Mark fixed
                                      </button>
                                    )
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </section>
              )}
              {visit && visitId && (
                <section className="worklist" aria-labelledby="work-h">
                  <h3 id="work-h">
                    Recorded work <span className="count">({visit.records.length})</span>
                  </h3>
                  {visit.records.length === 0 ? (
                    <p>Nothing recorded yet. A visit can only be completed with at least one replacement or one problem written down.</p>
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
                  {visit.status === "DRAFT" && (
                    <button
                      type="button"
                      className="primary"
                      disabled={visit.records.length === 0 && !visit.events.some((e) => e.type.startsWith("OBSERVATION_"))}
                      onClick={() =>
                        afterDiscard(() => {
                          setHeld(false);
                          setServerMustFix(null);
                          setConfirming(true);
                        })
                      }
                    >
                      Complete visit…
                    </button>
                  )}
                  <ConfirmDialog
                    open={confirming && visit.status === "DRAFT"}
                    title="Complete and lock this visit?"
                    confirmLabel={needsHold ? "Complete check" : "Confirm completion"}
                    cancelLabel="Cancel"
                    busy={writes.anyBusy || writes.anyUnknown || (needsHold && !held)}
                    onConfirm={() => void complete()}
                    onCancel={() => setConfirming(false)}
                  >
                    <p>
                      {visit.records.length} record{visit.records.length === 1 ? "" : "s"} will be locked into the after-action report for {visit.tail} on{" "}
                      {formatDate(visit.checkDate)}. Completed visits cannot be edited.
                      {unresolvedCount > 0 ? ` ${unresolvedCount} unresolved components will be listed as gaps.` : ""}
                    </p>
                    {needsHold && (
                      <>
                        <p className="must-fix">Must be fixed before flight:</p>
                        <ul>
                          {mustFix.map(({ observation: o, locationId, overdue }) => (
                            <li key={o.id}>
                              <strong>{problemName(o, locationId)}</strong> · {problemFacts(o, overdue)}
                            </li>
                          ))}
                          {unlisted > 0 && <li>{unlisted === 1 ? "1 more problem" : `${unlisted} more problems`} on this aircraft, being reloaded.</li>}
                        </ul>
                        <label className="radio">
                          <input type="checkbox" required checked={held} onChange={(e) => setHeld(e.target.checked)} />
                          Aircraft held, reported to maintenance
                        </label>
                      </>
                    )}
                    {/* the expected visit version is taken at the click: a queued or unresolved save would make it stale */}
                    {writes.anyBusy && <p className="fine">Waiting for saves in progress to finish before completing.</p>}
                    {!writes.anyBusy && writes.anyUnknown && (
                      <p className="fine">A save has an unknown outcome. Retry it safely before completing, so the report includes it.</p>
                    )}
                  </ConfirmDialog>
                </section>
              )}
            </aside>
          </div>
        </>
      )}
      <ConfirmDialog
        open={pendingDiscard !== null}
        title={pendingDiscard && pendingDiscard.names.length > 1 ? "Discard unrecorded changes?" : "Discard the unrecorded change?"}
        confirmLabel="Discard"
        cancelLabel="Go back"
        destructive
        onConfirm={() => {
          const proceed = pendingDiscard?.proceed;
          setPendingDiscard(null);
          proceed?.();
        }}
        onCancel={() => setPendingDiscard(null)}
      >
        <p>{pendingDiscard?.names.length === 1 ? "This change has not been recorded:" : "These changes have not been recorded:"}</p>
        <ul>
          {pendingDiscard?.names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
