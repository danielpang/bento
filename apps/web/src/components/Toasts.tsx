import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Transient messages, bottom left, instead of text pushed into a panel.
 *
 * An error rendered inline moved everything below it, so a failed save
 * shifted the fields under the cursor and the message stayed until
 * something else replaced it. A toast says the same sentence without
 * rearranging the page, and leaves on its own.
 *
 * Bottom left on purpose: the drawers are on the right, and a message
 * about what just failed in one should not sit on top of it.
 */

export interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
}

interface ToastApi {
  /** Something went wrong, in the words the server used. */
  fail: (message: unknown) => void;
  /** Something worked and is worth confirming. Used sparingly. */
  note: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Long enough to read a sentence, short enough not to linger. */
const LIFETIME_MS = 6000;

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (text: string, tone: Toast["tone"]) => {
      if (!text) return;
      const id = nextId.current++;
      // Four at a time. A burst of failures from one action should not
      // become a wall that covers the board.
      setToasts((current) => [...current.slice(-3), { id, text, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME_MS),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      fail: (message: unknown) => push(readable(message), "error"),
      note: (text: string) => push(text, "info"),
    }),
    [push],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        Polite rather than assertive: these arrive after an action the
        person just took, so a screen reader should finish what it is
        saying before reading one.
      */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            <span className="toast-text">{toast.text}</span>
            <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Outside the host this is a no-op rather than a crash: a panel
 * rendered in isolation (a test, a future embed) should still work, and
 * losing a message is not worth a blank screen.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { fail: () => {}, note: () => {} };
}

/** The sentence inside whatever was thrown. */
function readable(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  return String(message);
}
