import type { CSSProperties } from "react";
import { GLYPH_PATHS, type LocationStatus, STATUS_ENCODING } from "../model.ts";

/**
 * A status as the 3D badge draws it: a disc in the status colour token with the glyph stroked in ink (WEB-21). It is
 * decorative (`aria-hidden`): the text beside it, or the control's accessible name, carries the meaning. "none" renders
 * nothing.
 */
export function StatusGlyph({ status }: { status: LocationStatus }) {
  const { glyph, token } = STATUS_ENCODING[status];
  if (glyph === "none") return null;
  return (
    <svg
      className="status-glyph"
      data-glyph={glyph}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ "--status-colour": `var(${token})` } as CSSProperties}
    >
      <circle cx="12" cy="12" r="10.6" />
      <path d={GLYPH_PATHS[glyph]} />
    </svg>
  );
}

/** The statuses that have a glyph, in the order a key lists them. */
export const KEYED_STATUSES = (Object.keys(STATUS_ENCODING) as LocationStatus[]).filter((s) => STATUS_ENCODING[s].glyph !== "none");
