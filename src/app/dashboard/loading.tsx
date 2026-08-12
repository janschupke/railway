import { Skeleton } from "@/components/ui/misc";

/** Mirrors the real dashboard markup so nothing shifts when data lands. */
export default function DashboardLoading() {
  return (
    <>
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 py-3">
          <span className="font-display text-text font-semibold tracking-tight">
            Container Console
          </span>
          <Skeleton className="h-7 w-20" />
        </div>
      </header>

      <main
        className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6"
        aria-busy="true"
        aria-label="Loading dashboard"
      >
        <div className="flex gap-3">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-9 w-48 rounded-md" />
        </div>

        <Skeleton className="border-border h-56 rounded-lg border" />

        <section className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <div className="border-border bg-surface rounded-lg border">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="border-border flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-9 flex-1" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
