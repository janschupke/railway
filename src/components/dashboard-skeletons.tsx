import { ContainerSectionHeader } from "./container-section-header";
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

/**
 * The two origin checkboxes' placeholder.
 *
 * This used to be four chips standing in for a nine-toggle status strip that wrapped to
 * two or three lines on a narrow viewport — a placeholder that matched it exactly would
 * have been a wall of grey, and one that did not left the card jumping a line. The status
 * filter is one dropdown now, so what is left to stand in for beside it is the pair of
 * checkboxes, which is a number rather than a guess.
 */
const PLACEHOLDER_OWNERS = 2;

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
     *
     * Two columns is now the whole row. It stood in for two selects and a pair of create
     * buttons it never drew, so it was narrower than what replaced it; the buttons have
     * since moved inside the selects as action rows, and the match is exact. Do not
     * "restore" a button placeholder here.
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

/** One label/value pair, matching `Figure` in billing-summary.tsx. */
function FigureSkeleton({ width }: { width: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className={`h-5 ${width}`} />
    </div>
  );
}

/**
 * Stands in for BillingSection: two cards, three figures each.
 *
 * The headings are real text for the same reason ContainerSectionSkeleton's is — they never
 * depend on the fetch, so they stay put and stay in the a11y tree while the reads run. The
 * figure rows are placeholders because their widths are the only thing that could shift, and
 * a card whose height changes when the number lands is the CLS the LHCI gate measures.
 */
export function BillingSectionSkeleton({
  spendHeading,
  usageHeading,
}: {
  spendHeading: string;
  usageHeading: string;
}) {
  return (
    <section className="space-y-3" aria-busy="true" data-loading="billing">
      {[spendHeading, usageHeading].map((heading) => (
        <Card key={heading} className="space-y-3 p-4">
          <Heading level={2}>{heading}</Heading>
          {/* Not a <dl>: the real cards use one, but an empty definition list is a
              structure a screen reader would announce as having no terms in it. */}
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <FigureSkeleton width="w-24" />
            <FigureSkeleton width="w-32" />
            <FigureSkeleton width="w-20" />
          </div>
          <Skeleton className="h-4 w-full max-w-lg" />
        </Card>
      ))}
    </section>
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
    <section className="space-y-3" aria-busy="true" data-loading="containers">
      <ContainerSectionHeader
        heading={heading}
        summary={<Skeleton className="h-4 w-56" />}
      />

      {/*
        The filter bar the real list grows once it has containers. Standing in for it is
        not optional: without this the card jumps a control row down the page the moment
        the fetch lands, which is the drift e2e/skeleton.spec.ts exists to catch.

        Heights come from the same `--control-h-*` tokens the real controls use, and the
        row mirrors ContainerFilterBar's own — including `basis-80`, which is what decides
        whether the search field shares its line at phone width. There is no placeholder
        for the selected-status chips: a fresh load has nothing selected, so a strip there
        would reserve a line the real bar does not draw, which is the same defect in the
        other direction.
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Skeleton shape="control" className="h-control-md min-w-0 grow basis-80" />
        <Skeleton shape="control" className="h-control-md w-24 shrink-0" />
        <div className="flex shrink-0 gap-3">
          {Array.from({ length: PLACEHOLDER_OWNERS }, (_, i) => (
            <Skeleton key={i} className="h-4 w-24" />
          ))}
        </div>
        <Skeleton shape="control" className="h-control-md ml-auto w-28 shrink-0" />
      </div>

      <Card>
        {/*
          Deliberately not a <ul>: e2e/support.ts finds the container list by
          getByRole("list", { name: "Containers" }) and asserts there is exactly one, so
          a placeholder list would be a second one and break every container spec.
        */}
        <div data-loading="container-rows">
          {Array.from({ length: rows }, (_, i) => (
            <ContainerRowSkeleton key={i} />
          ))}
        </div>
      </Card>

      <Skeleton className="h-4 w-full max-w-lg" />
    </section>
  );
}
