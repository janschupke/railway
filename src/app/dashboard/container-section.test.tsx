import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Container } from "@/lib/railway/types";

const loadContainers = vi.fn();
vi.mock("./data", () => ({
  loadContainers: (...args: unknown[]) => loadContainers(...args),
}));

/*
 * The rows are their own component with their own tests, and one of them opens a Radix
 * dialog. Stubbing them keeps this file about the section: the heading, the count, and
 * which of the two the empty state replaces.
 */
vi.mock("@/components/container-row", () => ({
  ContainerRow: ({ container }: { container: Container }) => (
    <li>{container.displayName}</li>
  ),
}));

const { ContainerSection } = await import("./container-section");

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

const renderSection = async (containers: Container[]) => {
  loadContainers.mockResolvedValue({ containers, error: null });
  return render(
    await ContainerSection({ projectId: "proj_1", environmentId: "env_1" }),
  );
};

describe("ContainerSection", () => {
  it("says nothing about a count when there is nothing to count", async () => {
    /*
     * This read "0 of no containers created here" — ICU resolving a `=0` branch that
     * replaced the count and left the sentence built around it — directly above the empty
     * state that already says nothing is running.
     */
    await renderSection([]);

    // Anchored on the count, not on "created here" — the prefix note below the list ends
    // in those same words and is meant to be there at zero.
    expect(screen.queryByText(/\d+ of /)).toBeNull();
    expect(screen.queryByText(/no containers/)).toBeNull();
    expect(
      screen.getByText(/nothing running in this environment/i),
    ).toBeInTheDocument();
  });

  it("counts the ones this app created against the ones that are there", async () => {
    await renderSection([
      container({ serviceId: "svc_1", displayName: "cache" }),
      container({ serviceId: "svc_2", displayName: "postgres", managed: false }),
    ]);

    expect(screen.getByText("1 of 2 containers created here")).toBeInTheDocument();
  });

  it("uses the singular for a single container", async () => {
    // The catalog no longer carries a zero form; this pins the one it does carry, since a
    // malformed plural is a runtime failure of the real ICU message, not a type error.
    await renderSection([container()]);

    expect(screen.getByText("1 of 1 container created here")).toBeInTheDocument();
  });

  it("switches to the on-screen count once the list is longer than a page", async () => {
    /*
     * "1 of 45 created here" over twenty visible rows describes a list nobody is looking
     * at. Past a page the sentence has to name all three numbers.
     */
    await renderSection(
      Array.from({ length: 45 }, (_, i) =>
        container({ serviceId: `svc_${i}`, displayName: `c${i}`, managed: i === 0 }),
      ),
    );

    expect(
      screen.getByText("Showing 20 of 45 containers, 1 created here"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
  });

  it("renders the filter bar only when there is something to filter", async () => {
    await renderSection([]);
    expect(screen.queryByLabelText("Search containers")).toBeNull();

    await renderSection([container()]);
    expect(screen.getByLabelText("Search containers")).toBeInTheDocument();
  });
});
