"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Toast } from "radix-ui";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type ToastTone = "success" | "error" | "info";

type ToastRecord = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  /**
   * Whether this toast is still on its way in, as opposed to already gone.
   *
   * Radix wraps the root in a `Presence`, which holds a closing node in the tree until
   * its exit animation ends — but only if the node is still rendered. Deleting the record
   * inside `onOpenChange` unmounted `<Toast.Root>` first, so Presence never had anything
   * to work with and no toast has ever animated out. The record now survives its own
   * dismissal and is dropped when the animation actually finishes.
   */
  open: boolean;
};

/**
 * How many are on screen at once. A fourth arriving means the first is no longer news,
 * and a stack taller than this covers the controls that produced it.
 */
const MAX_VISIBLE = 3;

/**
 * Backstop for an environment that runs no animation at all, where `animationend` never
 * fires and the record would sit closed in the tree forever. `animationend` is the
 * primary path; this only ever runs second.
 */
const EXIT_FALLBACK_MS = 600;

type ToastApi = {
  toast: (input: { title: string; description?: string; tone?: ToastTone }) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Throws rather than no-ops: a swallowed toast is a bug you find in production. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used within <ToastProvider>");
  return api;
}

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-l-success",
  error: "border-l-danger",
  info: "border-l-accent",
};

let nextId = 0;

/**
 * App-wide toast region, built on Radix Toast for the announcement and dismissal
 * behaviour: errors are assertive, everything else polite, and each toast is reachable
 * with F6 rather than being an unreachable floating div.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const toast = useCallback<ToastApi["toast"]>(({ title, description, tone }) => {
    setToasts((current) =>
      [
        ...current,
        { id: nextId++, title, description, tone: tone ?? "info", open: true },
      ].slice(-MAX_VISIBLE),
    );
  }, []);

  /** Starts the exit. The record stays so Presence has a node to animate out. */
  const close = useCallback((id: number) => {
    setToasts((current) =>
      current.map((t) => (t.id === id ? { ...t, open: false } : t)),
    );
  }, []);

  /** Drops it for good, once the exit animation has run (or been skipped). */
  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  /*
   * The fallback timer for every toast that has begun closing.
   *
   * Under `prefers-reduced-motion` the animation is 0.01ms and `animationend` still
   * fires, so this almost never wins — but a jsdom test, or a browser that declines to
   * animate, would otherwise leave a closed record in the tree permanently.
   */
  // A string, not an array: the ids are the dependency, and a fresh array every render
  // would re-arm every timer on every render.
  const closing = toasts
    .filter((record) => !record.open)
    .map((record) => record.id)
    .join(",");

  useEffect(() => {
    if (!closing) return;
    const timers = closing
      .split(",")
      .map((id) => setTimeout(() => remove(Number(id)), EXIT_FALLBACK_MS));
    return () => timers.forEach(clearTimeout);
  }, [closing, remove]);

  const t = useTranslations("common");
  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider swipeDirection="right" duration={6000}>
        {children}

        {toasts.map((record) => (
          <Toast.Root
            key={record.id}
            open={record.open}
            type={record.tone === "error" ? "foreground" : "background"}
            onOpenChange={(open) => {
              if (!open) close(record.id);
            }}
            onAnimationEnd={(event) => {
              // The root's own animation, not one bubbling up from the spinner or an
              // icon inside it, and only the one that ends the exit.
              if (event.target !== event.currentTarget) return;
              if (event.currentTarget.dataset.state === "closed") remove(record.id);
            }}
            className={cn(
              "border-border bg-raised animate-content rounded-lg border border-l-2 p-3 shadow-lg",
              // Tracks the pointer 1:1 while dragging. Without transition-none the
              // transform lags the finger by the tokenised duration and the toast feels
              // stuck; without the rule at all it did not move until release.
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
              // Snaps back when the drag falls short of the dismiss threshold.
              "data-[swipe=cancel]:duration-fast data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
              "data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
              TONE_CLASS[record.tone],
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Toast.Title className="text-text text-label font-medium">
                  {record.title}
                </Toast.Title>
                {record.description && (
                  <Toast.Description className="text-text-muted text-caption mt-0.5">
                    {record.description}
                  </Toast.Description>
                )}
              </div>
              <Toast.Close
                aria-label={t("dismissNotification")}
                className="focus-ring text-text-subtle hover:text-text rounded p-0.5"
              >
                <X aria-hidden className="size-3.5" />
              </Toast.Close>
            </div>
          </Toast.Root>
        ))}

        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}
