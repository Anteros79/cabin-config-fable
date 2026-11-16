import { useEffect, useId, useState } from "react";
import { excludedOf, rulesNotUsedLine } from "../../domain/report.ts";
import type { CabinLocation, RecordInput, SourceArtifact, VisitRecord } from "../../domain/types.ts";
import { canRetry, describeSaveStatus, recordTarget, type SaveStatus, saveStatusClass } from "../hooks/useMutations.ts";
import { type ComponentView, componentsAt, describeSeat, sourceText, type Workspace } from "../model.ts";

interface Props {
  workspace: Workspace;
  location: CabinLocation | null;
  focusComponent: string | null;
  /** The save status of one record target (`record:<locationId>|<componentId>`). */
  statusOf(target: string): SaveStatus;
  onRecord(input: RecordInput, expectedRecordVersion: number): void;
  onRemove(record: VisitRecord): void;
  /** Re-sends the last write of a target with its idempotency key. */
  onRetry(target: string): void;
  onSelect(locationId: string): void;
  /** A card holds typed input that is not saved (`dirty`), or no longer does. The target is `record:<locationId>|<componentId>`. */
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
}) {
  const id = useId();
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
    onDirtyChange(target, dirty);
    return () => onDirtyChange(target, false);
  }, [target, dirty, onDirtyChange]);

  const status = statusOf(target);
  const writePhase = status.phase;
  useEffect(() => {
    if (writePhase === "failed" || writePhase === "conflict") setRemoving(false);
  }, [writePhase]);
  const busy = status.phase === "saving";
  const message = status.phase === "conflict" ? `${describeSaveStatus(status)} The current saved state has been reloaded.` : describeSaveStatus(status);
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

  return (
    <section className={`component-card${highlighted ? " highlighted" : ""}`} aria-labelledby={`${id}-h`} data-component={view.componentId}>
      <h4 id={`${id}-h`}>
        {view.name}
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

          {workspace.mode === "visit" && workspace.editable && (
            <form className="record-form" onSubmit={submit}>
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
              <p role="status" aria-live="polite" className={`save-state ${saveStatusClass(status)}`}>
                {message || (record && !dirty ? `Saved. Record version ${record.version}, last changed ${record.updatedAt}.` : "")}
              </p>
              {canRetry(status) && (
                <button type="button" onClick={() => onRetry(target)}>
                  Retry safely
                </button>
              )}
            </form>
          )}
          {workspace.mode === "visit" && !workspace.editable && (
            <p className="fine">
              {record ? `Recorded: ${record.lines.map((l) => `${l.partNo} ${l.qty} ${l.unit}`).join(", ")}.` : "Not replaced on this visit."} This visit is
              completed and locked.
            </p>
          )}
          {workspace.mode === "preview" && <p className="fine">Start a visit to record replacements.</p>}
        </>
      )}
    </section>
  );
}

/** Component-level parts for the selected location: primary part, separate alternates, record form. */
export function Inspector({ workspace, location, focusComponent, statusOf, onRecord, onRemove, onRetry, onSelect, onDirtyChange, resetKey = 0 }: Props) {
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
        />
      ))}
    </div>
  );
}
