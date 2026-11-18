import { useMemo, useRef, useState } from "react";
import type { CabinLocation, ComponentDef, LayoutRevision } from "../../domain/types.ts";
import { alternateText, type LocationFlags, STATUS_ENCODING, seatLabelFor, type Workspace } from "../model.ts";
import { forgetSuggestionKeys, submitOnEnter } from "../submitOnEnter.ts";
import { KEYED_STATUSES, StatusGlyph } from "./StatusGlyph.tsx";

interface Props {
  workspace: Workspace;
  flags: Map<string, LocationFlags>;
  selection: string | null;
  onSelect(locationId: string, componentId: string | null): void;
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** Words that name no piece: they say what kind of place it is, or join the other words. */
const FILLER = new Set(["THE", "A", "AN", "OF", "AT", "ON", "IN", "AND", "TO", "SEAT", "ROW", "BIN", "OVERHEAD", "ARMREST"]);
const wordsOf = (text: string): string[] =>
  text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w !== "");

/**
 * "Go to location" with a piece: "12A headrest", "l-04 latch", "12AB", "armrest 12A 12B". Words are split on spaces and
 * commas, in any case. A seat code ("12A") names a seat; two seats of one row ("12AB", or "12A 12B") name the armrest
 * between them; one seat with the word "armrest" names its window or aisle armrest ("armrest 12A" is ARMREST:12-A); a
 * bin code ("L-04", "L4") names a bin; any other location id ending ("FWD", "12-AB") names that location. The other
 * words pick the piece: each must start a word of the piece's name or id (punctuation dropped, "seat", "bin", "row",
 * "armrest", "overhead" and joining words ignored), and a tie goes to the location's first such piece. Null when no
 * single location is named.
 */
function parseGoTo(text: string, layout: LayoutRevision, defs: Record<string, ComponentDef>) {
  const byId = (id: string) => layout.locations.find((l) => l.id === id);
  const found = new Set<CabinLocation | undefined>();
  const rest: string[] = [];
  const seats: [string, string][] = [];
  for (const token of text.trim().split(/[\s,]+/)) {
    const t = token.toUpperCase();
    const seat = /^(\d+)([A-F])([A-F])?$/.exec(t);
    const bin = /^([LR])-?(\d{1,2})$/.exec(t);
    if (seat) seats.push(...[seat[2], seat[3]].filter((l) => l !== undefined).map((l): [string, string] => [seat[1] as string, l as string]));
    else if (bin) found.add(byId(`BIN:${bin[1]}-${bin[2]?.padStart(2, "0")}`));
    else if (layout.locations.some((l) => l.id.endsWith(`:${t}`))) found.add(layout.locations.find((l) => l.id.endsWith(`:${t}`)));
    else rest.push(token);
  }
  if (seats.length > 0) {
    const row = seats[0]?.[0];
    const letters = [...new Set(seats.map(([, l]) => l))].sort().join("");
    const armrest = letters.length > 1 || rest.some((w) => wordsOf(w).includes("ARMREST"));
    found.add(
      seats.some(([r]) => r !== row) || letters.length > 2
        ? undefined
        : armrest
          ? byId(`ARMREST:${row}-${letters}`)
          : layout.locations.find((l) => l.seat?.code === `${row}${letters}`),
    );
  }
  const [location, ...others] = found;
  if (!location || others.length > 0) return null;
  const wanted = rest.flatMap(wordsOf).filter((w) => !FILLER.has(w));
  const componentId =
    location.componentIds.find((c) => {
      const names = wordsOf(`${defs[c]?.name ?? ""} ${c}`);
      return wanted.every((w) => names.some((n) => n.startsWith(w)));
    }) ?? null;
  return { location, componentId: wanted.length > 0 ? componentId : null, unmatched: wanted.length > 0 && componentId === null ? rest.join(" ") : "" };
}

function stateClass(flags: LocationFlags | undefined, selected: boolean): string {
  const c = ["loc"];
  if (selected) c.push("selected");
  if (flags?.recorded) c.push("recorded");
  if (flags && flags.unresolved > 0 && flags.resolved === 0) c.push("unresolved");
  else if (flags?.unresolved) c.push("partial");
  if (flags?.status === "alternate") c.push("alternate");
  return c.join(" ");
}

/**
 * Complete keyboard-operable alternative to the 3D view: every seat, floor area and bin module
 * is a real button with a text label and state. It needs no WebGL and is always available.
 */
export function CabinMap({ workspace, flags, selection, onSelect }: Props) {
  const { layout } = workspace;
  const seats = useMemo(() => new Map(layout.locations.filter((l) => l.kind === "SEAT").map((l) => [l.seat!.code, l])), [layout]);
  const floors = layout.locations.filter((l) => l.kind === "FLOOR");
  const bins = layout.locations.filter((l) => l.kind === "BIN");
  const rows = layout.rows;
  const gridRef = useRef<HTMLFieldSetElement | null>(null);
  const firstSeat = layout.locations.find((l) => l.kind === "SEAT");
  const [focusCode, setFocusCode] = useState<string | null>(null);
  const selected = selection ? layout.locations.find((l) => l.id === selection) : undefined;
  const selectedSeat = selected?.kind === "SEAT" ? selected : undefined;
  const tabStop = (focusCode && seats.has(focusCode) ? focusCode : null) ?? selectedSeat?.seat?.code ?? firstSeat?.seat?.code ?? null;
  const [goTo, setGoTo] = useState("");
  const [goToMessage, setGoToMessage] = useState("");

  const existing = rows.filter((r) => r.exists);
  const moveFocus = (code: string, dRow: number, dCol: number) => {
    const seat = seats.get(code)?.seat;
    if (!seat) return;
    let rowIndex = existing.findIndex((r) => r.printedLabel === seat.printedRow);
    let col = LETTERS.indexOf(seat.letter);
    for (let step = 0; step < 80; step++) {
      if (dCol !== 0) col += dCol;
      if (dRow !== 0) rowIndex += dRow;
      const row = existing[rowIndex];
      const letter = LETTERS[col];
      if (row === undefined || letter === undefined) return;
      const next = `${row.printedLabel}${letter}`;
      if (seats.has(next)) {
        setFocusCode(next);
        gridRef.current?.querySelector<HTMLButtonElement>(`[data-seat="${next}"]`)?.focus();
        return;
      }
    }
  };
  const onGridKey = (e: React.KeyboardEvent, code: string) => {
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      moveFocus(code, m[0], m[1]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const row = e.key === "Home" ? existing[0] : existing[existing.length - 1];
      const next = LETTERS.map((l) => `${row?.printedLabel}${l}`).find((c) => seats.has(c));
      if (next) {
        setFocusCode(next);
        gridRef.current?.querySelector<HTMLButtonElement>(`[data-seat="${next}"]`)?.focus();
      }
    }
  };

  const submitGoTo = (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = goTo.trim().toUpperCase();
    if (!wanted) return;
    // A location's own code, id or label first, as before; then a location with a piece ("12A headrest").
    const match =
      layout.locations.find((l) => l.seat?.code === wanted) ??
      layout.locations.find((l) => l.id.toUpperCase() === wanted || l.id.toUpperCase().endsWith(`:${wanted}`)) ??
      layout.locations.find((l) => l.label.toUpperCase().includes(wanted));
    const parsed = match ? { location: match, componentId: null, unmatched: "" } : parseGoTo(goTo, layout, workspace.componentDefs);
    if (parsed) {
      const { location, componentId, unmatched } = parsed;
      onSelect(location.id, componentId);
      setGoToMessage(
        unmatched
          ? `Selected ${location.label}. No piece there matches "${unmatched}".`
          : `Selected ${location.label}${componentId ? `, ${workspace.componentDefs[componentId]?.name ?? componentId}` : ""}.`,
      );
      setGoTo("");
    } else setGoToMessage(`No location matches "${goTo.trim()}" in this layout.`);
  };

  const skippedBefore = (index: number): string[] => {
    const out: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const row = rows[i];
      if (row === undefined || row.exists) break;
      out.unshift(row.printedLabel);
    }
    return out;
  };

  const stateText = (f: LocationFlags | undefined): string => {
    const parts: string[] = [];
    if (f?.recorded) parts.push(`${f.recorded} replacement${f.recorded === 1 ? "" : "s"} recorded`);
    if (f?.unresolved) parts.push(`${f.unresolved} component${f.unresolved === 1 ? "" : "s"} unresolved`);
    if (f?.alternate) parts.push(alternateText(f.alternate));
    return parts.length ? `, ${parts.join(", ")}` : "";
  };
  // The accessible name is the visible text plus hidden prefix and state, so it always contains what is shown.
  const button = (location: CabinLocation, text: string, hiddenPrefix = "") => {
    const f = flags.get(location.id);
    return (
      <button
        key={location.id}
        type="button"
        className={stateClass(f, selection === location.id)}
        aria-pressed={selection === location.id}
        data-location={location.id}
        onClick={() => onSelect(location.id, null)}
      >
        <span>
          {hiddenPrefix && <span className="sr-only">{hiddenPrefix}</span>}
          {text}
          <span className="sr-only">{stateText(f)}</span>
        </span>
        <StatusGlyph status={f?.status ?? "none"} />
      </button>
    );
  };

  return (
    <div className="cabin-map">
      <form className="goto" onSubmit={submitGoTo}>
        <label htmlFor="goto-input">Go to location</label>
        <input
          id="goto-input"
          list="goto-options"
          value={goTo}
          onChange={(e) => setGoTo(e.target.value)}
          onKeyDown={submitOnEnter}
          onInput={forgetSuggestionKeys}
          placeholder="e.g. 3A, L-01, FWD"
          autoComplete="off"
        />
        <datalist id="goto-options">
          {layout.locations.map((l) => (
            <option key={l.id} value={l.seat?.code ?? l.id.split(":")[1]}>
              {l.label}
            </option>
          ))}
          {/* the pieces of the selected location only, so the list does not grow with every piece of the cabin */}
          {selected &&
            selected.componentIds.length > 1 &&
            selected.componentIds.map((c) => (
              <option key={`${selected.id}|${c}`} value={`${selected.seat?.code ?? selected.id.split(":")[1]} ${workspace.componentDefs[c]?.name ?? c}`}>
                {selected.label}
              </option>
            ))}
        </datalist>
        <button type="submit">Select</button>
        <span role="status" className="fine">
          {goToMessage}
        </span>
        {selected && (
          <button type="button" className="link" onClick={() => document.getElementById("inspector-heading")?.focus()}>
            Go to parts for {selected.label}
          </button>
        )}
      </form>

      <section aria-labelledby="map-seats">
        <h3 id="map-seats">
          Seats <span className="count">({seats.size})</span>
        </h3>
        <p className="fine">Forward is at the top. Arrow keys move between seats; Enter or Space selects.</p>
        <ul className="status-key" aria-label="Status key">
          {KEYED_STATUSES.map((s) => (
            <li key={s}>
              <StatusGlyph status={s} /> {STATUS_ENCODING[s].label}
            </li>
          ))}
        </ul>
        {seats.size === 0 ? (
          <p className="notice">No seat set is defined for this layout.</p>
        ) : (
          <fieldset className="seat-grid" ref={gridRef} aria-label={`Seat map, ${existing.length} rows`}>
            <div className="seat-row head" aria-hidden="true">
              <span className="row-label">Row</span>
              {LETTERS.map((l, i) => (
                <span key={l} className={i === 3 ? "letter after-aisle" : "letter"}>
                  {l}
                </span>
              ))}
            </div>
            {rows.map((row, index) => {
              if (!row.exists) return null;
              const skipped = skippedBefore(index);
              return (
                <div key={row.printedLabel} className="seat-row-wrap">
                  {skipped.length > 0 && (
                    <p className="skipped">
                      Printed row{skipped.length > 1 ? "s" : ""} {skipped.join(", ")} {skipped.length > 1 ? "do" : "does"} not exist in this layout
                    </p>
                  )}
                  <fieldset className="seat-row" aria-label={`Row ${row.printedLabel}`}>
                    <span className="row-label" aria-hidden="true">
                      {row.printedLabel}
                    </span>
                    {LETTERS.map((letter, i) => {
                      const code = `${row.printedLabel}${letter}`;
                      const location = seats.get(code);
                      const cls = i === 3 ? "cell after-aisle" : "cell";
                      if (!location) return <span key={code} className={`${cls} empty`} title={`No seat ${code}`} />;
                      const f = flags.get(location.id);
                      return (
                        <span key={code} className={cls}>
                          <button
                            type="button"
                            data-seat={code}
                            tabIndex={tabStop === code ? 0 : -1}
                            className={`${stateClass(f, selection === location.id)} tier-${(location.seat?.commercialTier ?? location.seat?.maintenanceZone ?? "none").replace(/\s+/g, "-").toLowerCase()}`}
                            aria-pressed={selection === location.id}
                            aria-label={seatLabelFor(location, f)}
                            onClick={() => {
                              setFocusCode(code);
                              onSelect(location.id, null);
                            }}
                            onFocus={() => setFocusCode(code)}
                            onKeyDown={(e) => onGridKey(e, code)}
                          >
                            <span aria-hidden="true">{letter}</span>
                            <StatusGlyph status={f?.status ?? "none"} />
                          </button>
                        </span>
                      );
                    })}
                  </fieldset>
                </div>
              );
            })}
          </fieldset>
        )}
      </section>

      <section aria-labelledby="map-floor">
        <h3 id="map-floor">
          Floor <span className="count">({floors.length})</span>
        </h3>
        {floors.length === 0 ? (
          <p className="notice">Floor panel map not supplied for this layout. No floor location can be selected.</p>
        ) : (
          <div className="loc-list">{floors.map((l) => button(l, l.label))}</div>
        )}
      </section>

      <section aria-labelledby="map-bins">
        <h3 id="map-bins">
          Overhead bins <span className="count">({bins.length})</span>
        </h3>
        {bins.length === 0 ? (
          <p className="notice">Overhead-bin module map not supplied for this layout. No bin can be selected.</p>
        ) : (
          <div className="bin-columns">
            {(["L", "R"] as const).map((side) => (
              <fieldset key={side} className="bin-side" aria-label={`${side === "L" ? "Left" : "Right"} side bins`}>
                <h4>{side === "L" ? "Left (A-C side)" : "Right (D-F side)"}</h4>
                <div className="loc-list">
                  {bins
                    .filter((l) => l.bin?.side === side)
                    .map((l) =>
                      button(l, `${l.bin!.side}-${String(l.bin!.module).padStart(2, "0")} · rows ${l.bin!.rowFrom}-${l.bin!.rowTo}`, "Overhead bin "),
                    )}
                </div>
              </fieldset>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
