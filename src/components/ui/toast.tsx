"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Toast } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "error" | "info";

type ToastRecord = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
};

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
    setToasts((current) => [
      ...current,
      { id: nextId++, title, description, tone: tone ?? "info" },
    ]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider swipeDirection="right" duration={6000}>
        {children}

        {toasts.map((record) => (
          <Toast.Root
            key={record.id}
            type={record.tone === "error" ? "foreground" : "background"}
            onOpenChange={(open) => {
              if (!open) dismiss(record.id);
            }}
            className={cn(
              "border-border bg-raised animate-content rounded-lg border border-l-2 p-3 shadow-lg",
              "data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]",
              TONE_CLASS[record.tone],
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Toast.Title className="text-text text-sm font-medium">
                  {record.title}
                </Toast.Title>
                {record.description && (
                  <Toast.Description className="text-text-muted mt-0.5 text-xs">
                    {record.description}
                  </Toast.Description>
                )}
              </div>
              <Toast.Close
                aria-label="Dismiss notification"
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
