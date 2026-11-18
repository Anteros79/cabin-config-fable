import { useEffect, useId, useRef, useState } from "react";
import { allowedOutcomes, dueDateFor, isOverdue } from "../../domain/observations.ts";
import { excludedOf, rulesNotUsedLine } from "../../domain/report.ts";
import type {
  CabinLocation,
  Condition,
  DeferReason,
  DeferUntil,
  MelClass,
  MelEntry,
  Observation,
  ObservationInput,
  RecordInput,
  SourceArtifact,
  VisitRecord,
} from "../../domain/types.ts";
import { conditionLabel, deferLabel, formatDate, formatDateTime, melLabel, outcomeLabel, reasonLabel } from "../format.ts";
import { canRetry, describeSaveStatus, observationTarget, recordTarget, type SaveStatus, saveStatusClass } from "../hooks/useMutations.ts";
import { type ComponentView, componentsAt, describeSeat, sourceText, type Workspace } from "../model.ts";

interface Props {
  workspace: Workspace;
  location: CabinLocation | null;
  focusComponent: string | null;
  /** The save status of one record target (`record:<locationId>|<componentId>`). */
  statusOf(target: string): SaveStatus;
  onRecord(input: RecordInput, expectedRecordVersion: number): void;
  /** Writes down a new problem on a piece (target `observation:<locationId>:<componentId>`). Resolves true once saved. */
  onObserve(input: ObservationInput): Promise<boolean>;
  /** Changes an open problem (target `observation:<id>`). The input never lowers the problem's class. Resolves true once saved. */
  onUpdateObservation(o: Observation, input: ObservationInput): Promise<boolean>;
  /** Closes an open problem: the piece was replaced, or fixed in place. */
  onCloseObservation(o: Observation, closedAs: "REPLACED" | "FIXED"): void;
  onRemove(record: VisitRecord): void;
  /** Re-sends the last write of a target with its idempotency key. May resolve true once saved. */
  onRetry(target: string): unknown;
  onSelect(locationId: string): void;
  /** A card holds typed input that is not saved (`dirty`), or no longer does: its record form or its problem form. The target is `record:<locationId>|<componentId>`. */
  onDirtyChange(target: string, dirty: boolean): void;
  /** A new value discards every card's unsaved input (the person agreed to). */
  resetKey?: number;
}

/** What the form holds. The quantity stays the text that was typed, so clearing the field and typing a new number works. */
interface Draft {
  selection: "PRIMARY" | "ALTERNATE";
  substituteId: string | null;
  quantityText: string;
  note: string;
}

const draftOf = (record: VisitRecord | null): Draft => ({
  selection: record?.selection ?? "PRIMARY",
  substituteId: record?.substituteId ?? null,
  quantityText: String(record?.quantity ?? 1),
  note: record?.note ?? "",
});
const sameDraft = (a: Draft, b: Draft): boolean =>
  a.selection === b.selection && a.substituteId === b.substituteId && a.quantityText.trim() === b.quantityText.trim() && a.note.trim() === b.note.trim();
const quantityValid = (text: string, limit: number): boolean => /^[1-9]\d*$/.test(text) && Number(text) <= limit;

type Outcome = ObservationInput["outcome"];
type Raise = "MEL" | "NO_GO";

const CONDITIONS: Condition[] = ["STAINED", "TORN", "WORN", "BROKEN", "MISSING", "WONT_LATCH", "OTHER"];
const DEFER_UNTIL: DeferUntil[] = ["NEXT_CHECK", "NEXT_STOP"];
const REASONS: DeferReason[] = ["NO_STOCK", "NO_TIME", "OTHER"];
const RAISES: Raise[] = ["MEL", "NO_GO"];
const RAISE_LABEL: Record<Raise, string> = { MEL: "MEL item", NO_GO: "No-go" };
const CLASS_RANK: Record<MelClass["class"], number> = { COSMETIC: 0, MEL: 1, NO_GO: 2 };

/** The conditions the MEL lists for a piece (its base entries, which name no variant), in the fixed order. */
export function conditionsFor(mel: MelEntry[], componentId: string): Condition[] {
  return CONDITIONS.filter((c) => mel.some((e) => e.componentId === componentId && e.condition === c && e.constraint?.variant === undefined));
}

/** The save line under a form: the status in words, and after a conflict that the saved state was reloaded. */
const statusText = (status: SaveStatus): string =>
  status.phase === "conflict" ? `${describeSaveStatus(status)} The current saved state has been reloaded.` : describeSaveStatus(status);

/** A save status line and, where it applies, its Retry safely button. */
function SaveLine({ status, text = statusText(status), onRetry }: { status: SaveStatus; text?: React.ReactNode; onRetry(): void }) {
  return (
    <>
      <p role="status" aria-live="polite" className={`save-state ${saveStatusClass(status)}`}>
        {text}
      </p>
      {canRetry(status) && (
        <button type="button" onClick={onRetry}>
          Retry safely
        </button>
      )}
    </>
  );
}

/** What the problem form is open for: a new problem (Defer presets the outcome), or a change to an open one. */
type ProblemPanel = { preset: "DEFERRED" | null; editing: Observation | null };

/**
 * The "Note a problem" form under the MEL. One class drives it: the piece's class for the chosen condition and raise,
 * never below the stored class of the problem being changed, and no-go once its MEL deferral has run out.
 */
function ProblemForm({
  view,
  locationId,
  conditions,
  checkDate,
  panel,
  status,
  onSave,
  onRetry,
  onDirty,
  onDone,
  onCancel,
}: {
  view: ComponentView;
  locationId: string;
  conditions: Condition[];
  checkDate: string;
  panel: ProblemPanel;
  /** The save status of this form's target. */
  status: SaveStatus;
  /** Resolves true once saved: the form closes only then, so a failed save keeps what was typed. */
  onSave(input: ObservationInput): Promise<boolean>;
  onRetry(): unknown;
  onDirty(dirty: boolean): void;
  onDone(): void;
  onCancel(): void;
}) {
  const id = useId();
  const { editing } = panel;
  const [condition, setCondition] = useState<Condition | null>(editing?.condition ?? null);
  const [outcome, setOutcome] = useState<Outcome | null>(editing?.outcome ?? panel.preset);
  const [deferUntil, setDeferUntil] = useState<DeferUntil | null>(editing?.deferUntil ?? null);
  const [reason, setReason] = useState<DeferReason | null>(editing?.reason ?? null);
  const [note, setNote] = useState(editing?.note ?? "");
  // A raise asked for in this form. The raise the problem already has is kept: it can never be lowered.
  const [raise, setRaise] = useState<Raise | null>(null);
  // What this form last sent, so a status left by an earlier problem on the same target is not shown as this one's,
  // and a late success closes the form only while it still holds that same draft.
  const [sent, setSent] = useState<string | null>(null);
  const dirty =
    condition !== (editing?.condition ?? null) ||
    outcome !== (editing?.outcome ?? panel.preset) ||
    deferUntil !== (editing?.deferUntil ?? null) ||
    reason !== (editing?.reason ?? null) ||
    note.trim() !== (editing?.note ?? "").trim() ||
    raise !== null;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    (fieldset.current?.querySelector<HTMLInputElement>("input:checked") ?? fieldset.current?.querySelector<HTMLInputElement>("input"))?.focus();
  }, []);

  const offered = editing && !conditions.includes(editing.condition) ? [...conditions, editing.condition] : conditions;
  const kept = editing?.raisedTo;
  const overdue = editing !== null && isOverdue(editing.dueDate, checkDate);
  const expired = (): MelClass => ({ class: "NO_GO", reason: `The MEL deferral ran out on ${formatDate(editing?.dueDate ?? "")}.` });
  const classFor = (c: Condition, raisedTo: Raise | undefined): MelClass => {
    const now = view.melClass(c, raisedTo);
    if (!editing) return now;
    if (now.class === "MEL" && overdue) return expired();
    if (CLASS_RANK[editing.melClass.class] > CLASS_RANK[now.class]) return overdue && editing.melClass.class === "NO_GO" ? expired() : editing.melClass;
    return now;
  };
  // The levels above the class the problem has without a new raise; a raise that no longer fits is dropped.
  const floor = condition ? classFor(condition, kept) : null;
  const stricter = floor ? RAISES.filter((r) => CLASS_RANK[r] > CLASS_RANK[floor.class]) : [];
  const chosenRaise = raise !== null && stricter.includes(raise) ? raise : null;
  const raisedTo = chosenRaise ?? kept;
  const cls = condition ? classFor(condition, raisedTo) : null;
  const allowed = cls ? allowedOutcomes(cls) : [];
  const chosen: Outcome | null = outcome !== null && allowed.includes(outcome) ? outcome : allowed.length === 1 ? (allowed[0] ?? null) : null;
  const due = cls?.class === "MEL" ? (editing?.dueDate ?? dueDateFor(cls, checkDate)) : null;
  const deferring = chosen === "DEFERRED";
  const valid = condition !== null && chosen !== null && (!deferring || (deferUntil !== null && reason !== null));
  // While the outcome of a save is unknown only Retry safely is offered: a changed request would get a new key and
  // could store the problem twice.
  const blocked = status.phase === "saving" || status.phase === "unknown";

  const input = (): ObservationInput | null =>
    condition === null || chosen === null
      ? null
      : {
          locationId: editing?.locationId ?? locationId,
          componentId: view.componentId,
          condition,
          note,
          outcome: chosen,
          ...(deferring && deferUntil !== null && reason !== null ? { deferUntil, reason } : {}),
          ...(raisedTo !== undefined ? { raisedTo } : {}),
        };
  // Read when an answer arrives, which may be after more typing: the draft on screen then, not at the click.
  const draftNow = useRef("");
  draftNow.current = JSON.stringify(input());
  const finish = (saved: unknown, draft: string | null) => {
    if (saved === true && draft !== null && draft === draftNow.current) onDone();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const request = input();
    if (!valid || blocked || request === null) return;
    const draft = JSON.stringify(request);
    setSent(draft);
    finish(await onSave(request), draft);
  };
  // A retry re-sends what this form sent; a form opened after it (sent is null) stays open with its own input.
  const retry = async () => finish(await onRetry(), sent);

  return (
    <form className="problem-form" onSubmit={submit}>
      <fieldset ref={fieldset}>
        <legend>{editing ? "Change this problem" : panel.preset === "DEFERRED" ? "Defer a problem" : "Note a problem"}</legend>
        <div className="choices" role="radiogroup" aria-label="Condition">
          <p className="group-label" aria-hidden="true">
            Condition
          </p>
          {offered.map((c) => (
            <label key={c} className="radio">
              <input type="radio" name={`${id}-condition`} value={c} checked={condition === c} onChange={() => setCondition(c)} />
              {conditionLabel(c)}
            </label>
          ))}
        </div>
        {cls && (
          <div className="meaning" role="status" aria-live="polite">
            <p className="group-label">What this means</p>
            <p className={cls.class === "NO_GO" ? "must-fix" : undefined}>{melLabel(cls)}</p>
            {due && <p>Fix by {formatDate(due)}</p>}
          </div>
        )}
        {cls && (
          <div className="choices" role="radiogroup" aria-label="Outcome">
            <p className="group-label" aria-hidden="true">
              Outcome
            </p>
            {allowed.map((o) => (
              <label key={o} className="radio">
                <input type="radio" name={`${id}-outcome`} value={o} checked={chosen === o} onChange={() => setOutcome(o)} />
                {outcomeLabel(o)}
              </label>
            ))}
          </div>
        )}
        {deferring && (
          <>
            <div className="choices" role="radiogroup" aria-label="Until">
              <p className="group-label" aria-hidden="true">
                Until
              </p>
              {DEFER_UNTIL.map((d) => (
                <label key={d} className="radio">
                  <input type="radio" name={`${id}-until`} value={d} checked={deferUntil === d} onChange={() => setDeferUntil(d)} />
                  {deferLabel(d)}
                </label>
              ))}
            </div>
            <div className="choices" role="radiogroup" aria-label="Reason">
              <p className="group-label" aria-hidden="true">
                Reason
              </p>
              {REASONS.map((r) => (
                <label key={r} className="radio">
                  <input type="radio" name={`${id}-reason`} value={r} checked={reason === r} onChange={() => setReason(r)} />
                  {reasonLabel(r)}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="field">
          <span>Note about the problem (optional)</span>
          <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
        </label>
        {stricter.length > 0 && (
          <label className="field inline">
            <span>Make this stricter</span>
            <select value={chosenRaise ?? ""} onChange={(e) => setRaise(e.target.value === "" ? null : (e.target.value as Raise))}>
              <option value="">No change</option>
              {stricter.map((r) => (
                <option key={r} value={r}>
                  {RAISE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={!valid || blocked}>
            Save problem
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
      {(sent !== null || status.phase === "unknown") && <SaveLine status={status} onRetry={() => void retry()} />}
    </form>
  );
}

/** One open problem on a piece, with what can be done about it. */
function ProblemItem({
  o,
  carried,
  record,
  actionable,
  status,
  onEdit,
  onClose,
  onRetry,
}: {
  o: Observation;
  carried: { overdue: boolean } | null;
  record: VisitRecord | null;
  actionable: boolean;
  /** The save status of this problem's own writes (`observation:<id>`). */
  status: SaveStatus;
  onEdit(button: HTMLButtonElement): void;
  onClose(closedAs: "REPLACED" | "FIXED"): void;
  onRetry(): void;
}) {
  const id = useId();
  const details = [
    o.outcome === "DEFERRED" && o.deferUntil && o.reason ? `${deferLabel(o.deferUntil)}, ${reasonLabel(o.reason)}.` : "",
    o.dueDate && !carried?.overdue ? `Fix by ${formatDate(o.dueDate)}.` : "",
  ].filter((d) => d !== "");
  return (
    <li className="problem">
      <p id={`${id}-what`}>
        <strong>{conditionLabel(o.condition)}</strong>: {[`${outcomeLabel(o.outcome)}.`, ...details].join(" ")}
      </p>
      {o.note !== "" && <p className="fine">“{o.note}”</p>}
      {carried && <p className="fine">Carried over from the check on {formatDate(o.createdAt.slice(0, 10))}</p>}
      {carried?.overdue && o.dueDate && <p className="must-fix">Overdue since {formatDate(o.dueDate)}</p>}
      {actionable && (
        <div className="actions">
          <button type="button" aria-describedby={`${id}-what`} onClick={(e) => onEdit(e.currentTarget)}>
            Edit
          </button>
          <button
            type="button"
            aria-describedby={record === null ? `${id}-what ${id}-why` : `${id}-what`}
            disabled={record === null || status.phase === "saving"}
            onClick={() => onClose("REPLACED")}
          >
            Mark replaced
          </button>
          <button type="button" aria-describedby={`${id}-what`} disabled={status.phase === "saving"} onClick={() => onClose("FIXED")}>
            Mark fixed
          </button>
          {record === null && (
            <span id={`${id}-why`} className="fine">
              Record the replacement first.
            </span>
          )}
        </div>
      )}
      {status.phase !== "idle" && <SaveLine status={status} onRetry={onRetry} />}
    </li>
  );
}

function ComponentCard({
  view,
  workspace,
  location,
  sources,
  highlighted,
  statusOf,
  onRecord,
  onRemove,
  onRetry,
  onDirtyChange,
  onObserve,
  onUpdateObservation,
  onCloseObservation,
}: {
  view: ComponentView;
  workspace: Workspace;
  location: CabinLocation;
  sources: Record<string, SourceArtifact> | undefined;
  highlighted: boolean;
  statusOf: Props["statusOf"];
  onRecord: Props["onRecord"];
  onRemove: Props["onRemove"];
  onRetry: Props["onRetry"];
  onDirtyChange: Props["onDirtyChange"];
  onObserve: Props["onObserve"];
  onUpdateObservation: Props["onUpdateObservation"];
  onCloseObservation: Props["onCloseObservation"];
}) {
  const id = useId();
  // Which form is open below the buttons: the record fieldset (the default), or the problem form.
  const [problemPanel, setProblemPanel] = useState<ProblemPanel | null>(null);
  const [problemDirty, setProblemDirty] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const recordForm = useRef<HTMLFormElement>(null);
  const [focusRecord, setFocusRecord] = useState(0);
  useEffect(() => {
    if (focusRecord > 0) (recordForm.current?.querySelector<HTMLInputElement>("input:checked") ?? recordForm.current?.querySelector("input"))?.focus();
  }, [focusRecord]);
  const { rule, record } = view;
  const alternates = (rule?.substitutes ?? []).filter((s) => s.locationIds === null || s.locationIds.includes(location.id));
  const saved = draftOf(record);
  const serverVersion = record?.version ?? 0;
  const [draft, setDraft] = useState<Draft>(saved);
  // The record the draft was loaded from, and the version it had (0 for none).
  const [base, setBase] = useState<{ record: VisitRecord | null; version: number }>({ record, version: serverVersion });
  // What the last save sent, so the answer to the person's own save is not taken for a change made elsewhere.
  const [sent, setSent] = useState<Draft | null>(null);
  // Set when the person pressed Remove on this card, so the record going away is their own doing.
  const [removing, setRemoving] = useState(false);
  if (base.version !== serverVersion && !(sent && sameDraft(sent, saved))) {
    // The saved record changed. A form with nothing unsaved follows it; one with typed input keeps it and says so below.
    if ((removing && record === null) || sameDraft(draft, draftOf(base.record))) {
      setDraft(saved);
      setBase({ record, version: serverVersion });
      setRemoving(false);
    }
  } else if (base.version !== serverVersion) {
    // The answer to the person's own save: the base moves, and the mark is spent.
    setBase({ record, version: serverVersion });
    setSent(null);
  }
  const dirty = !sameDraft(draft, saved);
  const changedElsewhere = dirty && base.version !== serverVersion;
  const removedElsewhere = changedElsewhere && record === null;
  const limit = view.maxReplacements;
  const quantityOk = quantityValid(draft.quantityText, limit);
  const quantityHelp = `${id}-quantity-help`;

  const target = recordTarget(location.id, view.componentId);
  useEffect(() => {
    onDirtyChange(target, dirty || problemDirty);
    return () => onDirtyChange(target, false);
  }, [target, dirty, problemDirty, onDirtyChange]);

  const status = statusOf(target);
  const writePhase = status.phase;
  useEffect(() => {
    if (writePhase === "failed" || writePhase === "conflict") setRemoving(false);
  }, [writePhase]);
  const busy = status.phase === "saving";
  const message = statusText(status);
  const savedText = `${saved.selection === "PRIMARY" ? "Primary" : `Alternate ${alternates.find((s) => s.id === saved.substituteId)?.altPartNo ?? saved.substituteId}`}, ${saved.quantityText}, note ${saved.note === "" ? "none" : `“${saved.note}”`}`;
  const choose = (substituteId: string | null) => setDraft((d) => ({ ...d, selection: substituteId === null ? "PRIMARY" : "ALTERNATE", substituteId }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quantityOk) return;
    setSent(draft);
    onRecord(
      {
        locationId: location.id,
        componentId: view.componentId,
        selection: draft.selection,
        substituteId: draft.substituteId,
        quantity: Number(draft.quantityText),
        note: draft.note,
      },
      // The version the person last agreed to build on, so a save over a change made elsewhere is refused until they choose.
      base.version,
    );
  };

  const editable = workspace.mode === "visit" && workspace.editable;
  const conditions = conditionsFor(workspace.mel, view.componentId);
  // Defer is offered only where some condition allows a deferral.
  const canDefer = conditions.some((c) => allowedOutcomes(view.melClass(c)).includes("DEFERRED"));
  const open: { o: Observation; carried: { overdue: boolean } | null }[] = [
    ...view.problems.map((o) => ({ o, carried: null })),
    ...(view.carried ? [{ o: view.carried.observation, carried: { overdue: view.carried.overdue } }] : []),
  ];
  const problemTarget = observationTarget(problemPanel?.editing ?? { locationId: location.id, componentId: view.componentId });
  const openProblem = (button: HTMLButtonElement, panel: ProblemPanel) => {
    opener.current = button;
    setProblemPanel(panel);
  };
  const recordLine = (
    <SaveLine
      status={status}
      text={
        message ||
        (record && !dirty ? (
          <>
            Saved. Record version {record.version}, last changed{" "}
            <time dateTime={record.updatedAt} title={record.updatedAt}>
              {formatDateTime(record.updatedAt)}
            </time>
            .
          </>
        ) : (
          ""
        ))
      }
      onRetry={() => onRetry(target)}
    />
  );
  const closeProblem = () => {
    setProblemPanel(null);
    // focus goes back to the button that opened the form
    if (opener.current?.isConnected) opener.current.focus();
  };

  return (
    <section className={`component-card${highlighted ? " highlighted" : ""}`} aria-labelledby={`${id}-h`} data-component={view.componentId}>
      <h4>
        {location.label} · <span id={`${id}-h`}>{view.name}</span>
        {record ? (
          <span className="pill recorded">Recorded</span>
        ) : view.status === "RESOLVED" ? (
          <span className="pill ok">Applicable part found</span>
        ) : (
          <span className="pill unresolved">Unresolved</span>
        )}
      </h4>

      {view.status === "NOT_SUPPLIED" && <p className="notice">{workspace.unresolvedReason ?? "No applicability is available for this component."}</p>}

      {view.resolution && view.resolution.status !== "RESOLVED" && (
        <div className="notice" role="note">
          <p>
            <strong>{view.resolution.status === "AMBIGUOUS" ? "Ambiguous" : "No match"}:</strong> {view.resolution.message}
          </p>
          {view.resolution.status === "AMBIGUOUS" && (
            <ul>
              {view.resolution.candidates.map((c) => (
                <li key={c.ruleId}>
                  {c.partNo} (rule {c.ruleId}, {sourceText(sources, c.sourceId)})
                </li>
              ))}
            </ul>
          )}
          {view.resolution.status === "AMBIGUOUS" && rulesNotUsedLine(view.resolution.excluded) && (
            <p className="fine excluded">{rulesNotUsedLine(view.resolution.excluded)}</p>
          )}
          {view.resolution.status === "NO_MATCH" && view.resolution.excluded.length > 0 && (
            <ul>
              {view.resolution.excluded.map((x) => (
                <li key={x.ruleId}>
                  {x.partNo}: {x.reasons.map((r) => r.message).join(" ")}
                </li>
              ))}
            </ul>
          )}
          <p className="fine">Unresolved components cannot be recorded and stay listed as gaps in the report.</p>
        </div>
      )}

      {rule && (
        <>
          <dl className="facts">
            <dt>Primary part</dt>
            <dd>
              <strong className="partno">{rule.partNo}</strong> {rule.partDescription}
            </dd>
            <dt>Per replacement</dt>
            <dd>
              {rule.qtyPerReplacement} {rule.unit}
              {rule.children.length > 0 && ` plus ${rule.children.map((c) => `${c.qty} ${c.unit} ${c.partNo}`).join(", ")}`}
            </dd>
            <dt>Rule validity</dt>
            <dd>
              {rule.effectiveFrom} to {rule.effectiveTo ?? "open"} (inclusive), rule {rule.id}
            </dd>
            <dt>Source</dt>
            <dd>{sourceText(sources, rule.sourceId)}</dd>
          </dl>
          {/* a snapshot frozen before report schema 2 has no exclusions on a resolved component */}
          {view.resolution && rulesNotUsedLine(excludedOf(view.resolution)) && (
            <p className="fine excluded" role="note">
              {rulesNotUsedLine(excludedOf(view.resolution))}
            </p>
          )}
          {rule.pendingChanges.map((p) => (
            <p key={p.id} className="advisory" role="note">
              <strong>Pending change (advisory):</strong> {p.note} {p.sourceId ? `Source ${sourceText(sources, p.sourceId)}.` : ""} The current rule stays in
              effect.
            </p>
          ))}

          <h5>Approved alternates {alternates.length === 0 && <span className="fine">(none on this check date)</span>}</h5>
          {alternates.map((s) => (
            <div key={s.id} className="alternate">
              <p>
                <strong className="partno">{s.altPartNo}</strong> {s.altDescription} — {s.qtyPerReplacement} {s.unit} per replacement. Replaces the primary when
                chosen.
              </p>
              <p className="fine">
                Approval {s.id}: {s.effectiveFrom} to {s.effectiveTo ?? "open"} (inclusive). {sourceText(sources, s.sourceId)}
              </p>
              {s.children.length > 0 && (
                <>
                  <p className="fine">Required supplements, added automatically:</p>
                  <ul className="supplements">
                    {s.children.map((c) => (
                      <li key={`${c.partNo}${c.unit}`}>
                        <span className="partno">{c.partNo}</span> × {c.qty} {c.unit} <span className="fine">{c.description}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))}
          {rule.excludedSubstitutes.map((x) => (
            <p key={x.id} className="fine excluded">
              Not available: {x.altPartNo} — {x.reasons.map((r) => r.message).join(" ")}
            </p>
          ))}

          {workspace.mode === "visit" && !workspace.editable && (
            <p className="fine">
              {record ? `Recorded: ${record.lines.map((l) => `${l.partNo} ${l.qty} ${l.unit}`).join(", ")}.` : "Not replaced on this visit."} This visit is
              completed and locked.
            </p>
          )}
          {workspace.mode === "preview" && <p className="fine">Start a visit to record replacements.</p>}
        </>
      )}

      {editable && (rule || conditions.length > 0) && (
        <div className="actions piece-actions">
          {rule && (
            <button
              type="button"
              aria-expanded={problemPanel === null}
              onClick={() => {
                setProblemPanel(null);
                setFocusRecord((n) => n + 1);
              }}
            >
              Replace now
            </button>
          )}
          {conditions.length > 0 && (
            <button
              type="button"
              aria-expanded={problemPanel !== null && problemPanel.preset === null && problemPanel.editing === null}
              onClick={(e) => openProblem(e.currentTarget, { preset: null, editing: null })}
            >
              Note a problem
            </button>
          )}
          {canDefer && (
            <button
              type="button"
              aria-expanded={problemPanel?.preset === "DEFERRED"}
              onClick={(e) => openProblem(e.currentTarget, { preset: "DEFERRED", editing: null })}
            >
              Defer
            </button>
          )}
        </div>
      )}
      {rule && editable && problemPanel === null && (
        <form className="record-form" onSubmit={submit} ref={recordForm}>
          <fieldset disabled={busy}>
            <legend>{record ? "Recorded replacement" : "Record a replacement"}</legend>
            <div className="choices" role="radiogroup" aria-label={`Part used for ${view.name}`}>
              <label className="radio">
                <input type="radio" name={`${id}-choice`} value="PRIMARY" checked={draft.selection === "PRIMARY"} onChange={() => choose(null)} />
                Primary <span className="partno">{rule.partNo}</span>
              </label>
              {alternates.map((s) => (
                <label key={s.id} className="radio">
                  <input type="radio" name={`${id}-choice`} value={s.id} checked={draft.substituteId === s.id} onChange={() => choose(s.id)} />
                  Alternate <span className="partno">{s.altPartNo}</span>
                  {s.children.length > 0 && <span className="fine"> + {s.children.length} required supplements</span>}
                </label>
              ))}
            </div>
            {view.maxReplacements > 1 ? (
              <>
                <label className="field inline">
                  <span>
                    Replacements{" "}
                    <span className="fine">
                      (1–{view.maxReplacements}; {view.countNote})
                    </span>
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={draft.quantityText}
                    aria-invalid={quantityOk ? undefined : true}
                    aria-describedby={quantityOk ? undefined : quantityHelp}
                    onChange={(e) => setDraft((d) => ({ ...d, quantityText: e.target.value }))}
                  />
                </label>
                {!quantityOk && (
                  <p id={quantityHelp} className="field-error">
                    Enter a whole number from 1 to {limit}.
                  </p>
                )}
              </>
            ) : (
              <p className="fine">Replacements: 1. {view.countNote}</p>
            )}
            <div role="status" aria-live="polite">
              {changedElsewhere && (
                <div className="notice">
                  <p>
                    {removedElsewhere
                      ? "This replacement was removed. Nothing is saved for it."
                      : `This replacement changed elsewhere. Saved value: ${savedText}.`}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(saved);
                        setBase({ record, version: serverVersion });
                      }}
                    >
                      {removedElsewhere ? "Discard mine" : "Use saved value"}
                    </button>
                    <button type="button" onClick={() => setBase({ record, version: serverVersion })}>
                      Keep mine
                    </button>
                  </div>
                </div>
              )}
            </div>
            <label className="field">
              <span>Note (optional)</span>
              <textarea value={draft.note} maxLength={1000} rows={2} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
            </label>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy || !quantityOk || (!!record && !dirty)}>
                {record ? "Update record" : "Record replacement"}
              </button>
              {record && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(true);
                    onRemove(record);
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </fieldset>
          {recordLine}
        </form>
      )}
      {/* the record's own save line stays in view while the problem form is open */}
      {rule && editable && problemPanel !== null && status.phase !== "idle" && recordLine}
      {editable && problemPanel !== null && (
        <ProblemForm
          key={`${problemPanel.preset ?? ""}|${problemPanel.editing?.id ?? ""}`}
          view={view}
          locationId={location.id}
          conditions={conditions}
          checkDate={workspace.checkDate}
          panel={problemPanel}
          status={statusOf(problemTarget)}
          onSave={(input) => {
            const { editing } = problemPanel;
            // the version on screen now: after a conflict reload the next save builds on what is stored
            return editing ? onUpdateObservation(open.find((p) => p.o.id === editing.id)?.o ?? editing, input) : onObserve(input);
          }}
          onRetry={() => onRetry(problemTarget)}
          onDirty={setProblemDirty}
          onDone={closeProblem}
          onCancel={closeProblem}
        />
      )}
      {open.length > 0 && (
        <>
          <h5>Open problems</h5>
          <ul className="problems">
            {open.map(({ o, carried }) => (
              <ProblemItem
                key={o.id}
                o={o}
                carried={carried}
                record={record}
                actionable={editable}
                status={statusOf(observationTarget(o))}
                onEdit={(button) => openProblem(button, { preset: null, editing: o })}
                onClose={(closedAs) => onCloseObservation(o, closedAs)}
                onRetry={() => void onRetry(observationTarget(o))}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Component-level parts for the selected location: primary part, separate alternates, record form. */
export function Inspector({
  workspace,
  location,
  focusComponent,
  statusOf,
  onRecord,
  onRemove,
  onRetry,
  onSelect,
  onDirtyChange,
  onObserve,
  onUpdateObservation,
  onCloseObservation,
  resetKey = 0,
}: Props) {
  // A control that selected the location can disappear with the old one (Whole-cabin carpet kit); focus then goes to the new heading, not to the page.
  const locationId = location?.id ?? null;
  useEffect(() => {
    if (!locationId) return;
    const active = document.activeElement;
    if (active === null || active === document.body) document.getElementById("inspector-heading")?.focus();
  }, [locationId]);
  if (!location) {
    return (
      <div className="inspector empty">
        <h3>Location</h3>
        <p>Select a seat, floor area or overhead bin in the 3D view or in the Map and list tab.</p>
      </div>
    );
  }
  const sources = workspace.resolution?.sources;
  const views = componentsAt(workspace, location);
  const fullCabin = workspace.layout.locations.find((l) => l.id === "FLOOR:FULL-CABIN");
  return (
    <div className="inspector">
      <h3 tabIndex={-1} id="inspector-heading">
        {location.label}
      </h3>
      <p className="fine">
        {workspace.layout.id} · {location.id}
      </p>
      {location.seat && (
        <ul className="attributes">
          {describeSeat(location).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {location.kind === "FLOOR" && location.floor?.areaType === "AREA" && fullCabin && (
        <p>
          <button type="button" className="link" onClick={() => onSelect(fullCabin.id)}>
            Whole-cabin carpet kit…
          </button>
        </p>
      )}
      {views.length === 0 && <p className="notice">{workspace.unresolvedReason ?? "No components are defined for this location."}</p>}
      {views.map((view) => (
        <ComponentCard
          key={`${location.id}|${view.componentId}|${resetKey}`}
          view={view}
          workspace={workspace}
          location={location}
          sources={sources}
          highlighted={focusComponent === view.componentId}
          statusOf={statusOf}
          onRecord={onRecord}
          onRemove={onRemove}
          onRetry={onRetry}
          onDirtyChange={onDirtyChange}
          onObserve={onObserve}
          onUpdateObservation={onUpdateObservation}
          onCloseObservation={onCloseObservation}
        />
      ))}
    </div>
  );
}
