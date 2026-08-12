import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Scopes the toast and tooltip systems to the only routes that use them.
 *
 * Toast used to sit in the root layout, which meant the landing page and the 404 shipped
 * Radix Toast — ~35 kB raw, ~12 kB gzip — to render UI that has no actions in it.
 *
 * Tooltip's provider belongs here rather than around each tooltip, so `delayDuration` is
 * grouped across the container list instead of restarting at every row.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </ToastProvider>
  );
}
