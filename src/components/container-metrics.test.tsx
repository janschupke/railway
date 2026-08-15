import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  ContainerMetrics,
  ContainerState,
  ContainerVolume,
} from "@/lib/railway/types";
import { ContainerMetricsReadout } from "./container-metrics";

/*
 * The ceilings are the figures a live probe returned off a real Railway service: a whole 2
 * for CPU, and 0.99999744 for the gigabyte of memory. The second one is not tidied up on
 * purpose — it is the value that used to render "1,000 MB", and keeping it here means the
 * readout is asserted against what Railway actually sends.
 */
const usage = (over: Partial<ContainerMetrics> = {}): ContainerMetrics => ({
  serviceId: "svc_1",
  cpuCores: 0.25,
  memoryGb: 0.21,
  cpuLimitCores: 2,
  memoryLimitGb: 0.99999744,
  sampledAt: 1_760_000_000,
  ...over,
});

const renderReadout = (
  props: Partial<React.ComponentProps<typeof ContainerMetricsReadout>> = {},
) =>
  render(
    <ContainerMetricsReadout
      metrics={usage()}
      volume={undefined}
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
    expect(screen.getByText("0.25 of 2 vCPU")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("210 MB of 1.0 GB")).toBeInTheDocument();
  });

  it("reads the ceiling as Railway enforces it, not as a round number", () => {
    /*
     * Railway reports the gigabyte limit as 0.99999744, which the readout used to render as
     * "1,000 MB" — wrong in its unit and a digit longer than the figure it means. The
     * denominator is also what makes the numerator legible: "0.25" alone answers nothing
     * about whether the container is near its limit, and the limit is the number the user
     * typed into the spin-up form and then never saw again.
     */
    renderReadout();
    expect(screen.queryByText(/1,000 MB/)).not.toBeInTheDocument();
    expect(screen.queryByText("2.00")).not.toBeInTheDocument();
  });

  it("switches memory to gigabytes once there is a gigabyte to show", () => {
    renderReadout({ metrics: usage({ memoryGb: 3.14, memoryLimitGb: 4 }) });
    expect(screen.getByText("3.1 GB of 4.0 GB")).toBeInTheDocument();
  });

  it("drops the denominator when only the reading arrived", () => {
    // A service whose limit series was empty still has a usage figure worth showing, and it
    // reads exactly as it did before ceilings existed.
    renderReadout({
      metrics: usage({ cpuLimitCores: null, memoryLimitGb: null }),
    });

    expect(screen.getByText("0.25 vCPU")).toBeInTheDocument();
    expect(screen.getByText("210 MB")).toBeInTheDocument();
  });

  it("shows an em dash for a ceiling with no reading beside it", () => {
    /*
     * The limit series is constant and outlives the usage one, so a stopped container can
     * answer with a ceiling and no sample. "— of 2 vCPU" would state what it COULD use while
     * saying nothing about whether it is running, and would weaken the em dash, which means
     * one specific thing here: Railway reported nothing.
     */
    renderReadout({ metrics: usage({ cpuCores: null, memoryGb: null }) });

    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(/of 2 vCPU/)).not.toBeInTheDocument();
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

    expect(screen.getByText("0.00 of 2 vCPU")).toBeInTheDocument();
    expect(screen.getByText("0 MB of 1.0 GB")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("marks a container doing a little work as doing a little, not as doing none", () => {
    /*
     * The defect this ticket exists for. 0.00019975 is what a live probe read off an idle
     * container, and two decimals rendered it "0.00 vCPU" — the same string an exact zero
     * gets, so a column of rows all reported nothing and read as a broken readout.
     */
    renderReadout({ metrics: usage({ cpuCores: 0.00019975 }) });

    const trace = screen.getByText("< 0.01 of 2 vCPU");
    expect(trace).toBeInTheDocument();

    renderReadout({ metrics: usage({ cpuCores: 0 }) });
    expect(screen.getByText("0.00 of 2 vCPU")).toBeInTheDocument();
    // Asserted directly rather than implied by the two lookups above: the point of the whole
    // discriminant is that these two containers do not read the same.
    expect(trace.textContent).not.toBe("0.00 of 2 vCPU");
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

describe("the volume readout", () => {
  const volume = (over: Partial<ContainerVolume> = {}): ContainerVolume => ({
    serviceId: "svc_1",
    volumeId: "vol_1",
    mountPath: "/var/lib/postgresql/data",
    sizeMB: 500,
    currentSizeMB: 12,
    ...over,
  });

  it("says where the data lives and how much of the volume it uses", () => {
    renderReadout({ volume: volume() });

    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(
      screen.getByText("/var/lib/postgresql/data · 12 MB of 500 MB"),
    ).toBeInTheDocument();
  });

  it("switches to gigabytes on a volume large enough to need them", () => {
    renderReadout({ volume: volume({ sizeMB: 5000, currentSizeMB: 2400 }) });
    expect(screen.getByText(/2\.4 GB of 5\.0 GB/)).toBeInTheDocument();
  });

  it("renders an untouched volume as a real zero rather than an em dash", () => {
    // The volume exists and nothing has been written to it yet. That is a fact, unlike an
    // absent metrics sample — which is Railway saying nothing and renders as a dash.
    renderReadout({ volume: volume({ currentSizeMB: 0 }) });
    expect(screen.getByText(/0 MB of 500 MB/)).toBeInTheDocument();
  });

  it("says nothing at all for a container with no volume", () => {
    /*
     * Absent rather than em-dashed, on the argument uptime already makes: most containers
     * here keep nothing, and a permanent "Volume —" on every nginx row would read as a
     * broken readout rather than one that does not apply. It is also how a refused
     * EnvironmentVolumes read renders, which is the honest rendering of not knowing.
     */
    renderReadout({ volume: undefined });
    expect(screen.queryByText("Volume")).not.toBeInTheDocument();
  });
});
