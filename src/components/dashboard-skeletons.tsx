import { Container } from "lucide-react";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Heading, Text } from "./ui/text";

/*
 * Placeholder compositions for the dashboard.
 *
 * Two consumers share these: the route-level loading.tsx (cold navigation) and the
 * in-page Suspense fallback in page.tsx (project switch). One definition of what a
 * loading row looks like, so the two cannot drift.
 *
 * EVERY export here is synchronous and takes its strings as props. A Suspense fallback
 * must not suspend — an `async` composition awaiting getTranslations() would escalate
 * past its own boundary to the route boundary and blank the whole page instead of
 * swapping one section. dashboard-skeletons.test.tsx pins that.
 */

/** How many rows the list stands in for before its real length is known. */
const PLACEHOLDER_ROWS = 3;

/*
 * Control placeholders take their height from the same `--control-h-*` tokens the real
 * controls do, so a skeleton cannot drift a few pixels away from the thing it stands in
 * for — which is what e2e/skeleton.spec.ts measures. The bare `h-4`/`h-5` placeholders
 * below stand in for *text*, not controls, and are sized from the type scale instead.
 */

/**
 * The icon and product name need no data, so they render for real: the header is the
 * one part of the page that must not move when the session lands.
 */
export function DashboardHeaderSkeleton({ appName }: { appName: string }) {
  return (
    <header className="border-border bg-surface border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <span className="flex items-center gap-2">
          <Container aria-hidden className="text-accent size-4" />
          <Text variant="title">{appName}</Text>
        </span>

        <div className="flex items-center gap-3">
          {/* The signed-in name is hidden below sm, exactly as in DashboardHeader. */}
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton shape="control" className="h-control-sm w-21" />
          <Skeleton shape="control" className="h-control-sm w-18" />
        </div>
      </div>
    </header>
  );
}

export function ProjectPickerSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Skeleton shape="control" className="h-control-md w-48" />
      <Skeleton shape="control" className="h-control-md w-48" />
    </div>
  );
}

export function SpinUpFormSkeleton() {
  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-2">
        <Skeleton className="h-5 w-28" />
        {/* Widths written out, not interpolated: Tailwind scans for literal class names. */}
        <div className="flex flex-wrap gap-2">
          <Skeleton shape="pill" className="h-6 w-24" />
          <Skeleton shape="pill" className="h-6 w-20" />
          <Skeleton shape="pill" className="h-6 w-28" />
          <Skeleton shape="pill" className="h-6 w-22" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-20" />
          <Skeleton shape="control" className="h-control-md w-full" />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-5 w-16" />
        <Skeleton shape="control" className="h-control-md w-full" />
      </div>

      <Skeleton shape="control" className="h-control-md w-40" />
    </Card>
  );
}

function ContainerRowSkeleton() {
  return (
    <div className="border-border border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        {/* Mirrors the disclosure button's -ml-1/p-1 so the text starts in the same place. */}
        <div className="-ml-1 flex min-w-0 flex-1 items-center gap-2 p-1">
          <Skeleton className="size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
        <Skeleton shape="pill" className="h-5 w-20" />
        <Skeleton className="h-3 w-20 shrink-0" />
        <Skeleton shape="control" className="h-control-sm w-24" />
      </div>
    </div>
  );
}

/**
 * Stands in for ContainerSection. The heading is real text, not a placeholder — it never
 * depends on the fetch, so it stays put and stays in the a11y tree while the list loads.
 */
export function ContainerSectionSkeleton({
  heading,
  rows = PLACEHOLDER_ROWS,
}: {
  heading: string;
  rows?: number;
}) {
  return (
    /*
     * aria-busy on the section, which is the smallest element that is genuinely busy.
     * No aria-label: a labelled <section> becomes a named landmark, and a landmark that
     * appears and disappears on every project switch is worse than none. No role=status
     * either — toasts and Banner own that role (see ui/misc.tsx).
     */
    <section className="space-y-2" aria-busy="true" data-loading="containers">
      <div className="flex items-baseline justify-between">
        <Heading level={2}>{heading}</Heading>
        <Skeleton className="h-4 w-40" />
      </div>

      <Card>
        {/*
          Deliberately not a <ul>: e2e/support.ts finds the container list by
          getByRole("list", { name: "Containers" }) and asserts there is exactly one, so
          a placeholder list would be a second one and break every container spec.
        */}
        <div>
          {Array.from({ length: rows }, (_, i) => (
            <ContainerRowSkeleton key={i} />
          ))}
        </div>
      </Card>

      <Skeleton className="h-4 w-full max-w-lg" />
    </section>
  );
}
