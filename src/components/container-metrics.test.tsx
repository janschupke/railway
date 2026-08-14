import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContainerMetrics, ContainerState } from "@/lib/railway/types";
import { ContainerMetricsReadout } from "./container-metrics";

const usage = (over: Partial<ContainerMetrics> = {}): ContainerMetrics => ({
  serviceId: "svc_1",
  cpuCores: 0.25,
  memoryGb: 0.21,
  sampledAt: 1_760_000_000,
  ...over,
});

const renderReadout = (
  props: Partial<React.ComponentProps<typeof ContainerMetricsReadout>> = {},
) =>
  render(
    <ContainerMetricsReadout
      metrics={usage()}
      state={"running" as ContainerState}
      deployedAt={new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()}
      name="cache"
      {...props}
    />,
  );

describe("ContainerMetricsReadout", () => {
  it("labels each number, so a bare figure is never on its own", () => {
    renderReadout();

    // Real catalog copy through setup-intl, not a key — a renamed message should fail here
    // rather than render a missing-message marker at the user.
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("0.25 vCPU")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("210 MB")).toBeInTheDocument();
  });

  it("switches memory to gigabytes once there is a gigabyte to show", () => {
    renderReadout({ metrics: usage({ memoryGb: 3.14 }) });
    expect(screen.getByText("3.1 GB")).toBeInTheDocument();
  });

  it("shows an em dash when Railway said nothing about this container", () => {
    /*
     * `undefined` is refused, stopped, or too new to have a sample — all of which mean the
     * same thing to a reader. There is deliberately no skeleton: metrics arrive in the same
     * RSC payload as the row, so a shimmer here would be permanent on a stopped container.
     */
    renderReadout({ metrics: undefined });

    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("distinguishes a container that is idle from one Railway said nothing about", () => {
    // The distinction the mapper protects and the copy depends on: 0.00 is a claim that the
    // container is running and costing money, and an em dash is no claim at all.
    renderReadout({ metrics: usage({ cpuCores: 0, memoryGb: 0 }) });

    expect(screen.getByText("0.00 vCPU")).toBeInTheDocument();
    expect(screen.getByText("0 MB")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("shows uptime for a running container", () => {
    renderReadout();
    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.getByText("4h 0m")).toBeInTheDocument();
  });

  it.each([["failed"], ["sleeping"], ["removed"], ["building"]] as const)(
    "omits uptime entirely for a %s container",
    (state) => {
      // Omitted rather than em-dashed: "up 3d 4h" beside a crashed badge would be the row
      // contradicting itself, and a pair that cannot apply reads worse empty than absent.
      renderReadout({ state });
      expect(screen.queryByText("Uptime")).not.toBeInTheDocument();
    },
  );

  it("does not announce itself, because the panel already has a live region", () => {
    /*
     * The decision most likely to be "fixed" by the next person, so it is pinned.
     *
     * The expanded panel already holds the log pane's role="log" and its implicit
     * aria-live. A third announcing source is what made every status assertion in this
     * suite ambiguous once before (see ui/misc.tsx), and a CPU figure moving every couple
     * of minutes is not worth interrupting someone reading log output for.
     */
    const { container } = renderReadout();

    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="log"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("is findable in the accessibility tree by the container it describes", () => {
    // Silent is not the same as invisible: without a name this is an unlabelled group of
    // numbers in a panel that may hold several.
    renderReadout();
    expect(screen.getByLabelText("Resource use for cache")).toBeInTheDocument();
  });
});
