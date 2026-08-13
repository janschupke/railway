import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Heading } from "./ui/text";

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

/*
 * There is deliberately no header placeholder here.
 *
 * There used to be one, and keeping it pixel-identical to the real bar was a standing
 * obligation that e2e/skeleton.spec.ts enforced with an exact boundingBox comparison. The
 * header now renders in the root layout, above this route's loading boundary, so the same
 * element survives the transition and there is nothing left to stand in for. The test
 * still guards that placement — it just passes by construction now.
 */

export function ProjectPickerSkeleton() {
  return (
    /*
     * `items-end` and `w-64` per column, matching ProjectPicker exactly. This used to be
     * `items-center` with a bare `w-48` control and no label placeholder at all — three
     * ways of standing in for a row it did not actually resemble.
     */
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex w-64 flex-col gap-1.5">
        <Skeleton className="h-5 w-16" />
        <Skeleton shape="control" className="h-control-md w-full" />
      </div>

      <div className="flex w-64 flex-col gap-1.5">
        <Skeleton className="h-5 w-24" />
        <Skeleton shape="control" className="h-control-md w-full" />
      </div>
    </div>
  );
}

export function SpinUpFormSkeleton() {
  return (
    <Card className="space-y-4 p-4">
      {/* The same two-up row as the real form: image and name share a line, and the
          wrappers carry Field's own `flex flex-col gap-1.5` because that is what they
          stand in for. */}
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 grow basis-64 flex-col gap-1.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton shape="control" className="h-control-md w-full" />
        </div>

        <div className="flex min-w-0 grow basis-48 flex-col gap-1.5">
          <Skeleton className="h-5 w-16" />
          <Skeleton shape="control" className="h-control-md w-full" />
        </div>
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
        {/* Tracks the time column's floor in container-row.tsx. A placeholder narrower
            than the thing it stands in for is exactly the drift this file exists to
            prevent — the row would settle wider than its own skeleton. */}
        <Skeleton className="h-3 w-24 shrink-0" />
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
