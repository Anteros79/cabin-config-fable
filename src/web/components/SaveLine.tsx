import type { ReactNode } from "react";
import { canRetry, describeSaveStatus, type SaveStatus, saveStatusClass } from "../hooks/useMutations.ts";

/** A status in words, and after a conflict that the saved state was reloaded. */
export const statusText = (status: SaveStatus): string =>
  status.phase === "conflict" ? `${describeSaveStatus(status)} The current saved state has been reloaded.` : describeSaveStatus(status);

/** A save status line (a polite live region) and, where it applies, its Retry safely button. */
export function SaveLine({ status, text = statusText(status), onRetry }: { status: SaveStatus; text?: ReactNode; onRetry(): void }) {
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
