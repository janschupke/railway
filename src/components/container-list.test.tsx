import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setSearchParams } from "@/test/setup-dom";
import { LIMITS, LIST } from "@/lib/constants";
import type { Container, ContainerMetrics, ContainerVolume } from "@/lib/railway/types";

/*
 * The rows are their own component with their own tests, and one of them opens a Radix
 * dialog and another holds a log stream. Stubbing them keeps this file about the list:
 * what is filtered, what is paged, and what the summary says about both.
 */
vi.mock("./container-row", () => ({
  ContainerRow: ({
    container,
    selected,
    onSelectedChange,
  }: {
    container: Container;
    selected?: boolean;
    onSelectedChange?: (checked: boolean) => void;
  }) => (
    <li>
      {container.displayName}
      {/*
        The one thing about a row this file is about: whether the list offered it a checkbox
        at all. `onSelectedChange` absent IS the answer for a row this app cannot destroy, so
        rendering nothing is the assertion rather than a shortcut.

        Labelled through `aria-label` rather than wrapping text, so `rows()` below still reads
        a row as its container's name and every existing assertion here keeps its meaning.
      */}
      {onSelectedChange && (
        <input
          type="checkbox"
          aria-label={`Select ${container.displayName}`}
          checked={Boolean(selected)}
          onChange={(event) => onSelectedChange(event.target.checked)}
        />
      )}
    </li>
  ),
}));

const { ContainerList } = await import("./container-list");
const { ToastProvider } = await import("./ui/toast");
// The usage figures hang off a Radix tooltip now, and a bare Tooltip is a Radix error.
const { TooltipProvider } = await import("./ui/tooltip");

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: null,
  updatedAt: null,
  deployedAt: null,
  url: null,
  managed: true,
  ...over,
});

const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    container({ serviceId: `svc_${i}`, displayName: `service-${i}` }),
  );

const renderList = (
  containers: Container[],
  metrics: Record<string, ContainerMetrics> = {},
  volumes: Record<string, ContainerVolume> = {},
) =>
  render(
    // The selection toolbar holds a destroy dialog, which toasts its own outcome.
    <TooltipProvider>
      <ToastProvider>
        <ContainerList
          containers={containers}
          projectId="proj_1"
          environmentId="env_1"
          heading="Containers"
          metrics={metrics}
          volumes={volumes}
        />
      </ToastProvider>
    </TooltipProvider>,
  );

/** The rows, and only the rows — the toast viewport is a list of list items too. */
const rows = () =>
  within(screen.getByRole("list", { name: "Containers" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("ContainerList", () => {
  it("renders exactly one list, named so it cannot be confused with the toast viewport", () => {
    renderList(many(3));
    // e2e/support.ts asserts a count of one; a second list breaks every container spec.
    expect(screen.getAllByRole("list", { name: "Containers" })).toHaveLength(1);
  });

  it("keeps the sentinel and the footer out of the list", () => {
    renderList(many(45));
    // Anything inside the <ul> is matchable as a row by the e2e helpers.
    expect(rows().every((text) => text?.startsWith("service-"))).toBe(true);
  });

  describe("paging", () => {
    it("shows one page of a long list and offers the rest", async () => {
      renderList(many(45));

      expect(rows()).toHaveLength(LIST.PAGE_SIZE);
      expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
      expect(screen.queryByText(/that is every container/i)).toBeNull();
    });

    it("appends a page per activation and finishes with the end notice", async () => {
      const user = userEvent.setup();
      renderList(many(45));

      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(rows()).toHaveLength(40);

      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(rows()).toHaveLength(45);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(
        screen.getByText("That is every container in this environment."),
      ).toBeInTheDocument();
    });

    it("gives a short list no footer at all", () => {
      renderList(many(3));
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(screen.queryByText(/that is every container/i)).toBeNull();
    });

    it("says the end is the end of the filtered list when filters are on", async () => {
      // Otherwise the notice claims the environment holds 25 containers when it holds 45.
      const user = userEvent.setup();
      setSearchParams("q=service");
      renderList(many(45));

      await user.click(screen.getByRole("button", { name: "Load more" }));
      await user.click(screen.getByRole("button", { name: "Load more" }));

      expect(
        screen.getByText("That is every container matching these filters."),
      ).toBeInTheDocument();
    });

    it("gives a filtered list that fits on one page no footer either", () => {
      setSearchParams("q=service-1");
      renderList(many(45));

      // service-1 plus service-10..19: eleven rows, nothing held back, nothing to say.
      expect(rows()).toHaveLength(11);
      expect(screen.queryByText(/that is every container/i)).toBeNull();
    });
  });

  describe("filtering from the URL", () => {
    it("filters on the first render of a deep link", () => {
      setSearchParams("q=postgres");
      renderList([
        container({ serviceId: "a", displayName: "cache" }),
        container({ serviceId: "b", displayName: "postgres" }),
      ]);

      expect(rows()).toEqual(["postgres"]);
    });

    it("ORs the selected statuses", () => {
      setSearchParams("status=failed,building");
      renderList([
        container({ serviceId: "a", displayName: "cache", state: "running" }),
        container({ serviceId: "b", displayName: "api", state: "failed" }),
        container({ serviceId: "c", displayName: "web", state: "building" }),
      ]);

      expect(rows()).toEqual(["api", "web"]);
    });

    it("reads owner=created as the containers this app made", () => {
      setSearchParams("owner=created");
      renderList([
        container({ serviceId: "a", displayName: "cache", managed: true }),
        container({ serviceId: "b", displayName: "postgres", managed: false }),
      ]);

      expect(rows()).toEqual(["cache"]);
    });

    it("offers a way out when nothing matches", () => {
      setSearchParams("q=nothing-like-this");
      renderList(many(45));

      expect(screen.queryByRole("list", { name: "Containers" })).toBeNull();
      expect(screen.getByText("No containers match these filters")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Clear filters" })).not.toHaveLength(
        0,
      );
    });
  });

  describe("the summary", () => {
    it("keeps the original sentence while nothing is hidden", () => {
      renderList([
        container({ serviceId: "a", displayName: "cache" }),
        container({ serviceId: "b", displayName: "postgres", managed: false }),
      ]);

      expect(screen.getByText("1 of 2 containers created here")).toBeInTheDocument();
    });

    it("names all three numbers once the list is paged", () => {
      renderList(many(45));
      expect(
        screen.getByText("Showing 20 of 45 containers, 45 created here"),
      ).toBeInTheDocument();
    });

    it("counts the matched set rather than the environment", () => {
      setSearchParams("q=postgres");
      renderList([
        container({ serviceId: "a", displayName: "cache", managed: true }),
        container({ serviceId: "b", displayName: "postgres", managed: false }),
      ]);

      expect(
        screen.getByText("Showing 1 of 1 container, 0 created here"),
      ).toBeInTheDocument();
    });

    it("says nothing when nothing matched", () => {
      setSearchParams("q=nothing-like-this");
      renderList(many(45));
      expect(screen.queryByText(/showing/i)).toBeNull();
    });

    it("is a polite live region, not a third role=status", () => {
      // Toasts and Banner already own role=status; see ui/misc.tsx.
      renderList(many(3));
      const summary = screen.getByText("3 of 3 containers created here");
      expect(summary).toHaveAttribute("aria-live", "polite");
      expect(summary).not.toHaveAttribute("role");
    });
  });

  describe("the usage total", () => {
    const usage = (serviceId: string, cpuCores: number, memoryGb: number) => ({
      serviceId,
      cpuCores,
      memoryGb,
      // The totals sentence deliberately does not sum these — see lib/container-metrics.ts.
      cpuLimitCores: 2,
      memoryLimitGb: 0.99999744,
      sampledAt: 1_760_000_000,
    });

    /** The usage figures live in a tooltip now; this opens it and hands back its content. */
    const openUsage = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.hover(await screen.findByRole("button", { name: /created here/ }));
      return screen.findByRole("tooltip");
    };

    it("adds up only the containers this app created", async () => {
      /*
       * The scope the cost story rests on. A total that quietly included services someone
       * else made would be exactly the misreading the copy around it is written to prevent.
       */
      const user = userEvent.setup();
      renderList(
        [
          container({ serviceId: "svc_1" }),
          container({ serviceId: "svc_2", managed: false }),
        ],
        {
          svc_1: usage("svc_1", 0.25, 1.5),
          svc_2: usage("svc_2", 9, 9),
        },
      );

      const tip = await openUsage(user);
      expect(within(tip).getByText("Created here")).toBeInTheDocument();
      expect(
        within(tip).getByText("0.25 vCPU and 1.5 GB across 1 container"),
      ).toBeInTheDocument();
    });

    it("states the environment total beside it, which is what makes it legible", async () => {
      /*
       * A figure with nothing beside it is a figure nobody can tell is large. The second
       * row covers every service in the environment, managed or not — and it says so, which
       * is the condition the managed-only invariant is relaxed under.
       */
      const user = userEvent.setup();
      renderList(
        [
          container({ serviceId: "svc_1" }),
          container({ serviceId: "svc_2", managed: false }),
        ],
        {
          svc_1: usage("svc_1", 0.25, 1.5),
          svc_2: usage("svc_2", 0.75, 2.5),
        },
      );

      const tip = await openUsage(user);
      expect(
        within(tip).getByText("Everything in this environment"),
      ).toBeInTheDocument();
      expect(
        within(tip).getByText("1.00 vCPU and 4.0 GB across 2 containers"),
      ).toBeInTheDocument();
    });

    it("says nothing at all when nothing answered", async () => {
      /*
       * "— vCPU and — across 0 containers" is a sentence with no content, so there is no
       * tooltip to open: the count stays plain text rather than becoming a control that
       * reveals nothing.
       */
      renderList([container()], {});

      expect(screen.queryByRole("button", { name: /created here/ })).toBeNull();
      expect(screen.queryByText(/vCPU and/)).toBeNull();
    });

    it("says so in words when one scope answered and the other did not", async () => {
      // Absent is not zero, all the way to the copy: a scope with no samples says nothing
      // reported rather than showing a figure that would read as running and idle.
      const user = userEvent.setup();
      renderList([container({ serviceId: "svc_1", managed: false })], {
        svc_1: usage("svc_1", 0.25, 1.5),
      });

      const tip = await openUsage(user);
      expect(within(tip).getByText("Nothing reported usage.")).toBeInTheDocument();
      expect(
        within(tip).getByText("0.25 vCPU and 1.5 GB across 1 container"),
      ).toBeInTheDocument();
    });

    it("keeps the figures out of the live region", async () => {
      /*
       * These numbers move on every metrics refresh. Inside the live region they would be
       * announced each time — the announcement spam live-region.tsx's debounce exists to
       * prevent, arriving from a different direction. The count sentence is the one worth
       * interrupting a screen-reader user for, and it is still in there.
       *
       * Radix mounts tooltip content only while open, which is what makes the trigger
       * living INSIDE the region safe: the figures are not in the DOM until asked for.
       */
      const { container: root } = renderList([container({ serviceId: "svc_1" })], {
        svc_1: usage("svc_1", 0.25, 1.5),
      });

      const live = root.querySelector("[aria-live]");
      expect(live).not.toBeNull();
      expect(live!.textContent).not.toMatch(/vCPU/);
      expect(live!.textContent).toMatch(/created here/);
    });

    it("gives the figures a trigger a keyboard can reach", async () => {
      // Radix renders Trigger asChild, so a bare paragraph would give this tooltip no
      // keyboard user at all — the whole reason the count is wrapped in a button.
      const user = userEvent.setup();
      renderList([container({ serviceId: "svc_1" })], {
        svc_1: usage("svc_1", 0.25, 1.5),
      });

      await user.tab();
      await user.keyboard("{Tab}");

      expect(
        await screen.findByRole("button", { name: /created here/ }),
      ).toBeInTheDocument();
    });
  });

  describe("sorting", () => {
    const dated = (name: string, createdAt: string) =>
      container({ serviceId: `svc_${name}`, displayName: name, createdAt });

    it("leaves the server's order alone by default", () => {
      // Managed first, then newest, from sortContainers on the server. A list that
      // re-sorted itself on arrival would silently drop that guarantee.
      renderList([
        dated("web", "2026-08-01T00:00:00Z"),
        dated("api", "2026-08-03T00:00:00Z"),
      ]);
      expect(rows()).toEqual(["web", "api"]);
    });

    it("applies the order named in the URL, on the first paint of a shared link", () => {
      setSearchParams("sort=name-asc");
      renderList([
        dated("web", "2026-08-01T00:00:00Z"),
        dated("api", "2026-08-03T00:00:00Z"),
      ]);
      expect(rows()).toEqual(["api", "web"]);
    });

    it("sorts before it pages, so the first page is the first page of that order", () => {
      setSearchParams("sort=name-desc");
      renderList(many(45));
      // service-9 is the last name in a descending string sort, not service-44.
      expect(rows()[0]).toBe("service-9");
      expect(rows()).toHaveLength(LIST.PAGE_SIZE);
    });
  });

  describe("selection", () => {
    const managed = (name: string) =>
      container({ serviceId: `svc_${name}`, displayName: name, managed: true });

    const selectAllBox = () =>
      screen.getByRole("checkbox", { name: "Select every container created here" });
    const rowBox = (name: string) =>
      screen.getByRole("checkbox", { name: `Select ${name}` });
    const destroyButton = () =>
      screen.getByRole("button", { name: "Destroy selected" });

    it("offers a checkbox only on the rows this app could destroy", () => {
      renderList([
        managed("cache"),
        container({ serviceId: "svc_pg", displayName: "postgres", managed: false }),
      ]);

      expect(rowBox("cache")).toBeInTheDocument();
      // A checkbox on a service this app cannot touch is a selection that leads nowhere.
      expect(screen.queryByRole("checkbox", { name: "Select postgres" })).toBeNull();
    });

    it("keeps the toolbar mounted and the trigger disabled rather than letting it appear", async () => {
      /*
       * A toolbar that arrived on the first tick would push the list down at the exact
       * moment the pointer was over a row checkbox, so the second tick would land on a
       * different row. Clear in the filter bar settles the same question the same way.
       */
      const user = userEvent.setup();
      renderList([managed("cache")]);

      expect(destroyButton()).toBeDisabled();
      await user.click(rowBox("cache"));
      expect(destroyButton()).toBeEnabled();
    });

    it("says how many are selected, and says what selection is for when none are", async () => {
      const user = userEvent.setup();
      renderList([managed("cache"), managed("queue")]);

      expect(
        screen.getByText("Select containers to destroy several at once."),
      ).toBeInTheDocument();

      await user.click(rowBox("cache"));
      expect(screen.getByText("1 container selected")).toBeInTheDocument();

      await user.click(rowBox("queue"));
      expect(screen.getByText("2 containers selected")).toBeInTheDocument();
    });

    it("goes indeterminate while only some of them are ticked", async () => {
      const user = userEvent.setup();
      renderList([managed("cache"), managed("queue")]);

      const all = selectAllBox() as HTMLInputElement;
      expect(all.indeterminate).toBe(false);

      await user.click(rowBox("cache"));
      // Without the third state a partial selection reads as an empty one, and the box is
      // the only thing on the row that says which way pressing it will go.
      expect(all.indeterminate).toBe(true);
      expect(all.checked).toBe(false);

      await user.click(rowBox("queue"));
      expect(all.indeterminate).toBe(false);
      expect(all.checked).toBe(true);
    });

    it("selects the matched set rather than the page on screen", async () => {
      const user = userEvent.setup();
      renderList(many(45));

      await user.click(selectAllBox());

      // 45 matched, 20 rendered. A checkbox that silently meant "the rows loaded so far"
      // would depend on how far the reader had scrolled.
      expect(screen.getByText("45 containers selected")).toBeInTheDocument();
    });

    it("stops at what one request may carry, and says so", async () => {
      const user = userEvent.setup();
      renderList(many(LIMITS.BULK_DESTROY_MAX + 5));

      await user.click(selectAllBox());

      // Silently selecting 50 of 55 would be the list telling the user something untrue
      // about their own selection.
      expect(
        screen.getByText(
          `${LIMITS.BULK_DESTROY_MAX} containers selected, the most that can be destroyed at once.`,
        ),
      ).toBeInTheDocument();
    });

    it("forgets the selection when the reader changes what they are looking at", async () => {
      const user = userEvent.setup();
      const { rerender } = renderList([managed("cache"), managed("queue")]);

      await user.click(rowBox("cache"));
      expect(screen.getByText("1 container selected")).toBeInTheDocument();

      /*
       * The rule that keeps a row hidden by a filter out of the batch. Changing what is on
       * screen clears what was picked, which is both predictable and what stops the
       * confirmation naming a container the reader can no longer see.
       */
      setSearchParams("q=queue");
      rerender(
        <ToastProvider>
          <ContainerList
            containers={[managed("cache"), managed("queue")]}
            projectId="proj_1"
            environmentId="env_1"
            heading="Containers"
            metrics={{}}
            volumes={{}}
          />
        </ToastProvider>,
      );

      expect(
        screen.getByText("Select containers to destroy several at once."),
      ).toBeInTheDocument();
    });

    it("names the selected containers in the confirmation, and nothing else", async () => {
      const user = userEvent.setup();
      renderList([managed("cache"), managed("queue")]);

      await user.click(rowBox("cache"));
      await user.click(destroyButton());

      const listed = within(
        await screen.findByRole("list", { name: "Containers about to be destroyed" }),
      );
      expect(listed.getByText("cache")).toBeInTheDocument();
      expect(listed.queryByText("queue")).toBeNull();
    });

    it("has no toolbar at all when nothing here was created by this app", () => {
      renderList([
        container({ serviceId: "svc_pg", displayName: "postgres", managed: false }),
      ]);

      expect(screen.queryByRole("button", { name: "Destroy selected" })).toBeNull();
    });
  });
});
