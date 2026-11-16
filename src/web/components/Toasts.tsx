import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface ToastOptions {
  action?: { label: string; run(): void };
  durationMs?: number;
}
interface Toast {
  id: number;
  message: string;
  action: ToastOptions["action"];
  /** null: stays until used or dismissed */
  durationMs: number | null;
}
interface ToastApi {
  /** Shows a toast and returns a handle that withdraws it (a view withdraws its own toasts when it goes). */
  show(message: string, options?: ToastOptions): () => void;
}

/** At most this many show at once; a new one replaces the oldest. */
export const MAX_TOASTS = 3;
/** How long a plain notice shows. A toast with an action (Undo) has no time limit (WCAG 2.2.1). */
export const TOAST_MS = 5000;

/** Without a provider (a view rendered on its own) a toast goes nowhere. */
const ToastContext = createContext<ToastApi>({ show: () => () => undefined });

export const useToast = (): ToastApi => useContext(ToastContext);

/** One toast. Its time runs only while the region is not paused, and what was left carries over a pause. */
function ToastItem({ toast, paused, dismiss }: { toast: Toast; paused: boolean; dismiss(id: number): void }) {
  const remaining = useRef(toast.durationMs ?? 0);
  const timed = toast.durationMs !== null;
  useEffect(() => {
    if (paused || !timed) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, timed, toast.id, dismiss]);
  return (
    <li className="toast" data-toast={toast.id}>
      <span className="toast-message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close icon" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

/**
 * Short notes about something that just happened, with an optional action (Undo). They appear in a polite status
 * region, so a screen reader reads them without focus moving. A plain notice goes after 5 s, waiting while a mouse
 * pointer or focus is on the region; one with an action stays until it is used, dismissed (button or Escape) or
 * withdrawn by the view that showed it. No animation: they appear and go.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    // A toast that goes while it holds focus hands focus on (to another toast, or to the main content), never to the page body.
    const region = regionRef.current;
    const item = region?.querySelector(`[data-toast="${id}"]`);
    if (item?.contains(document.activeElement)) {
      const other = [...(region?.querySelectorAll<HTMLElement>("[data-toast]") ?? [])].find((el) => el !== item)?.querySelector("button");
      (other ?? document.getElementById("main"))?.focus();
      if (!other) setFocused(false);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options?: ToastOptions) => {
      const toast: Toast = {
        id: nextId.current++,
        message,
        action: options?.action,
        durationMs: options?.action ? null : (options?.durationMs ?? TOAST_MS),
      };
      setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
      return () => dismiss(toast.id);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);
  const paused = hovered || focused;
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        ref={regionRef}
        className="toasts no-print"
        role="status"
        aria-live="polite"
        aria-label="Notifications"
        // a mouse pointer pauses the timers; a touch never sends the leave, so it would leave them paused
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onKeyDown={(e) => {
          const last = toasts.at(-1);
          if (e.key !== "Escape" || !last) return;
          e.stopPropagation();
          dismiss(last.id);
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <ul>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} paused={paused} dismiss={dismiss} />
          ))}
        </ul>
      </div>
    </ToastContext.Provider>
  );
}
