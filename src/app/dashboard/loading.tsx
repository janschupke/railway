/** Mirrors the real dashboard markup so nothing shifts when data lands. */
export default function DashboardLoading() {
  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 py-3">
          <span className="font-semibold tracking-tight">Container Console</span>
          <div className="h-7 w-20 animate-pulse rounded-md bg-subtle" />
        </div>
      </header>

      <main
        className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6"
        aria-busy="true"
        aria-label="Loading dashboard"
      >
        <div className="flex gap-3">
          <div className="h-9 w-48 animate-pulse rounded-md bg-subtle" />
          <div className="h-9 w-48 animate-pulse rounded-md bg-subtle" />
        </div>

        <div className="h-56 animate-pulse rounded-lg border border-border bg-subtle" />

        <section className="space-y-2">
          <div className="h-4 w-24 animate-pulse rounded bg-subtle" />
          <div className="rounded-lg border border-border bg-surface">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="h-9 flex-1 animate-pulse rounded bg-subtle" />
                <div className="h-5 w-20 animate-pulse rounded-full bg-subtle" />
                <div className="h-8 w-24 animate-pulse rounded-md bg-subtle" />
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
