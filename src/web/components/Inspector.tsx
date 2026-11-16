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
}) {
  const id = useId();
  const { rule, record } = view;
  const alternates = (rule?.substitutes ?? []).filter((s) => s.locationIds === null || s.locationIds.includes(location.id));
  const [choice, setChoice] = useState<string>(record?.substituteId ?? "PRIMARY");
  const [quantity, setQuantity] = useState<number>(record?.quantity ?? 1);
  const [note, setNote] = useState<string>(record?.note ?? "");
  // Re-sync the form when the saved record changes (saved, removed, or reloaded after a conflict).
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as authored to preserve behaviour; fixed in Task 4.5
  useEffect(() => {
    setChoice(record?.substituteId ?? "PRIMARY");
    setQuantity(record?.quantity ?? 1);
    setNote(record?.note ?? "");
  }, [record?.version, record?.substituteId, record?.quantity, record?.note, location.id]);

  const target = recordTarget(location.id, view.componentId);
  const status = statusOf(target);
  const busy = status.phase === "saving";
  const message = status.phase === "conflict" ? `${describeSaveStatus(status)} The current saved state has been reloaded.` : describeSaveStatus(status);
  const dirty = record ? (record.substituteId ?? "PRIMARY") !== choice || record.quantity !== quantity || record.note !== note.trim() : true;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onRecord(
      {
        locationId: location.id,
        componentId: view.componentId,
        selection: choice === "PRIMARY" ? "PRIMARY" : "ALTERNATE",
        substituteId: choice === "PRIMARY" ? null : choice,
        quantity,
        note,
      },
      record?.version ?? 0,
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
                    <input type="radio" name={`${id}-choice`} value="PRIMARY" checked={choice === "PRIMARY"} onChange={() => setChoice("PRIMARY")} />
                    Primary <span className="partno">{rule.partNo}</span>
                  </label>
                  {alternates.map((s) => (
                    <label key={s.id} className="radio">
                      <input type="radio" name={`${id}-choice`} value={s.id} checked={choice === s.id} onChange={() => setChoice(s.id)} />
                      Alternate <span className="partno">{s.altPartNo}</span>
                      {s.children.length > 0 && <span className="fine"> + {s.children.length} required supplements</span>}
                    </label>
                  ))}
                </div>
                {view.maxReplacements > 1 ? (
                  <label className="field inline">
                    <span>
                      Replacements{" "}
                      <span className="fine">
                        (1–{view.maxReplacements}; {view.countNote})
                      </span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={view.maxReplacements}
                      step={1}
                      value={quantity}
                      onChange={(e) => setQuantity(Math.trunc(Number(e.target.value)) || 1)}
                    />
                  </label>
                ) : (
                  <p className="fine">Replacements: 1. {view.countNote}</p>
                )}
                <label className="field">
                  <span>Note (optional)</span>
                  <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
                </label>
                <div className="actions">
                  <button type="submit" className="primary" disabled={busy || (!!record && !dirty)}>
                    {record ? "Update record" : "Record replacement"}
                  </button>
                  {record && (
                    <button type="button" className="danger" disabled={busy} onClick={() => onRemove(record)}>
                      Remove
                    </button>
                  )}
                </div>
              </fieldset>
              <p role="status" aria-live="polite" className={`save-state ${saveStatusClass(status)}`}>
                {message || (record ? `Saved. Record version ${record.version}, last changed ${record.updatedAt}.` : "")}
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
export function Inspector({ workspace, location, focusComponent, statusOf, onRecord, onRemove, onRetry, onSelect }: Props) {
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
          key={`${location.id}|${view.componentId}`}
          view={view}
          workspace={workspace}
          location={location}
          sources={sources}
          highlighted={focusComponent === view.componentId}
          statusOf={statusOf}
          onRecord={onRecord}
          onRemove={onRemove}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
