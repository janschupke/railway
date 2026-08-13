import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setSearchParams } from "@/test/setup-dom";
import { LIST } from "@/lib/constants";
import type { Container } from "@/lib/railway/types";

/*
 * The rows are their own component with their own tests, and one of them opens a Radix
 * dialog and another holds a log stream. Stubbing them keeps this file about the list:
 * what is filtered, what is paged, and what the summary says about both.
 */
vi.mock("./container-row", () => ({
  ContainerRow: ({ container }: { container: Container }) => (
    <li>{container.displayName}</li>
  ),
}));

const { ContainerList } = await import("./container-list");

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
  managed: true,
  ...over,
});

const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    container({ serviceId: `svc_${i}`, displayName: `service-${i}` }),
  );

const renderList = (containers: Container[]) =>
  render(
    <ContainerList
      containers={containers}
      projectId="proj_1"
      environmentId="env_1"
      heading="Containers"
    />,
  );

const rows = () => screen.getAllByRole("listitem").map((li) => li.textContent);

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
});
