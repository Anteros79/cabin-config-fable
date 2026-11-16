import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface ToastOptions {
  action?: { label: string; run(): void };
  durationMs?: number;
}
interface Toast {
  id: number;
  message: string;
  action: ToastOptions["action"];
  durationMs: number;
}
interface ToastApi {
  show(message: string, options?: ToastOptions): void;
}

/** At most this many show at once; a new one replaces the oldest. */
export const MAX_TOASTS = 3;
export const TOAST_MS = 5000;
/** Longer when there is something to do, such as Undo. */
export const TOAST_ACTION_MS = 8000;

/** Without a provider (a view rendered on its own) a toast goes nowhere. */
const ToastContext = createContext<ToastApi>({ show: () => undefined });

export const useToast = (): ToastApi => useContext(ToastContext);

/** One toast. Its time runs only while the region is not paused, and what was left carries over a pause. */
function ToastItem({ toast, paused, dismiss }: { toast: Toast; paused: boolean; dismiss(id: number): void }) {
  const remaining = useRef(toast.durationMs);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, toast.id, dismiss]);
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
      <button type="button" className="toast-close icon" aria-label={`Dismiss: ${toast.message}`} onClick={() => dismiss(toast.id)}>
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

/**
 * Short notes about something that just happened, with an optional action (Undo). They appear in a polite status
 * region, so a screen reader reads them without focus moving; they wait while the pointer or focus is on them.
 * No animation: they appear and go.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  const show = useCallback((message: string, options?: ToastOptions) => {
    const toast: Toast = {
      id: nextId.current++,
      message,
      action: options?.action,
      durationMs: options?.durationMs ?? (options?.action ? TOAST_ACTION_MS : TOAST_MS),
    };
    setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
  }, []);

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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
