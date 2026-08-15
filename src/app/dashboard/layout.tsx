import { DashboardTabs } from "@/components/dashboard-tabs";
import { BarInner } from "@/components/ui/page";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The dashboard is a live view of Railway; caching it would show stale containers.
 *
 * Declared here rather than on each page, so the three views cannot disagree. It is also
 * what removes `useSearchParams`' static-bailout Suspense requirement from DashboardTabs
 * below: nothing under this segment is statically rendered.
 */
export const dynamic = "force-dynamic";

/**
 * Scopes the toast and tooltip systems to the only routes that use them, and holds the
 * tab strip above the routes it switches between.
 *
 * Toast used to sit in the root layout, which meant the landing page and the 404 shipped
 * Radix Toast — ~35 kB raw, ~12 kB gzip — to render UI that has no actions in it.
 *
 * Tooltip's provider belongs here rather than around each tooltip, so `delayDuration` is
 * grouped across the container list instead of restarting at every row.
 *
 * The tab strip is here for the reason loading.tsx gives about the header: a layout sits
 * above the segment's own loading and error boundaries, so the same element survives every
 * tab change rather than being replaced by a placeholder and then re-rendered. Nothing
 * stands in for it while a tab loads, because nothing needs to — and a failed tab can
 * still be navigated out of, which is the state a strip inside the page would lose.
 *
 * It renders above <main>, which is why the project picker is inside the pages rather than
 * beside it: the picker needs the *resolved* selection, and a layout cannot read
 * searchParams. See dashboard-frame.tsx.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>
        {/*
          BarInner lines this row up with the PageMain column below it. `justify-start`
          overrides the recipe's `justify-between`, which is for a bar with something at
          each end; this one is a single group that reads left to right.
        */}
        <div className="border-border border-b">
          <BarInner pad="none" className="justify-start px-6">
            <DashboardTabs />
          </BarInner>
        </div>
        {children}
      </TooltipProvider>
    </ToastProvider>
  );
}
