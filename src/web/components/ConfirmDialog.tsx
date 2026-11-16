import { type ReactNode, useEffect, useId, useRef } from "react";

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** The confirm action loses something; it is styled as a danger button. */
  destructive?: boolean;
  /** The confirm action cannot run yet (for example, a save is still in flight). The button stays focusable but does nothing. */
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * A modal question on a native `<dialog>`. The page behind it is inert while it is open.
 * Escape and the cancel button both answer "cancel". Focus starts on the cancel button and,
 * when the dialog closes, goes back to the element that had it when the dialog opened.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel, destructive = false, busy = false, onConfirm, onCancel }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    openerRef.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape: the parent decides whether the dialog closes.
        e.preventDefault();
        onCancelRef.current();
      }}
      onClose={(e) => {
        // A browser can close the dialog itself (a second Escape); keep the parent in step. The event is queued, so one
        // from an earlier close can arrive after the dialog has opened again: an open dialog ignores it.
        if (openRef.current && !e.currentTarget.open) onCancelRef.current();
      }}
    >
      {open && (
        <>
          <h2 id={titleId}>{title}</h2>
          {children}
          <div className="actions">
            {/* aria-disabled, not disabled: a button that disables itself while focused would drop focus to the page */}
            <button
              type="button"
              className={destructive ? "danger" : "primary"}
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onConfirm();
              }}
            >
              {confirmLabel}
            </button>
            <button type="button" ref={cancelRef} onClick={onCancel}>
              {cancelLabel}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
