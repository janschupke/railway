import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container, ContainerMetrics } from "@/lib/railway/types";

const loadContainers = vi.fn();
vi.mock("./data-containers", () => ({
  loadContainers: (...args: unknown[]) => loadContainers(...args),
}));

const { BillingSection } = await import("./billing-section");

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

const usage = (over: Partial<ContainerMetrics> = {}): ContainerMetrics => ({
  serviceId: "svc_1",
  cpuCores: 0.25,
  memoryGb: 0.5,
  cpuLimitCores: 2,
  memoryLimitGb: 8,
  sampledAt: null,
  ...over,
});

const spend = {
  currentUsage: 18.4,
  periodStart: "2026-08-01T00:00:00Z",
  periodEnd: "2026-08-31T00:00:00Z",
  workspaceName: "Acme",
};

const renderSection = async (
  over: Partial<Awaited<ReturnType<typeof loadContainers>>> = {},
) => {
  loadContainers.mockResolvedValue({
    containers: [],
    error: null,
    metrics: {},
    volumes: {},
    spend: null,
    ...over,
  });
  return render(await BillingSection({ projectId: "proj_1", environmentId: "env_1" }));
};

// Shared across the file; without this a call count is a running total.
beforeEach(() => loadContainers.mockClear());

describe("BillingSection", () => {
  describe("the spend card", () => {
    it("names the figure, the period, and the workspace it belongs to", async () => {
      await renderSection({ spend });

      expect(screen.getByText("$18.40")).toBeInTheDocument();
      expect(screen.getByText("Aug 1, 2026 – Aug 31, 2026")).toBeInTheDocument();
      expect(screen.getByText("Acme")).toBeInTheDocument();
    });

    it("keeps saying what the figure actually covers", async () => {
      /*
       * The scope clause is not padding. It is the answer to "why does this not match my
       * container list", asked once in the copy instead of many times in an issue tracker:
       * Railway has no per-project or per-container cost, so this number necessarily
       * includes services this app did not create.
       */
      await renderSection({ spend });

      expect(
        screen.getByText(/including ones this app did not create/),
      ).toBeInTheDocument();
    });

    it("falls back to a generic name rather than dropping a real figure", async () => {
      // The name is decoration; the number is the point.
      await renderSection({ spend: { ...spend, workspaceName: null } });

      expect(screen.getByText("This project's workspace")).toBeInTheDocument();
      expect(screen.getByText("$18.40")).toBeInTheDocument();
    });

    it("points at Railway when there is no figure to show", async () => {
      /*
       * A personal project has no workspace, and a token without workspace:viewer cannot
       * read one. Those render identically on purpose: from the reader's side they are the
       * same situation, and neither is something they can act on in this app — so no
       * banner and no re-consent prompt, just where the number lives.
       */
      await renderSection({ spend: null });

      expect(
        screen.getByText(/Railway reports spend per workspace/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /Open billing on Railway/ }),
      ).toBeInTheDocument();
    });
  });

  describe("the usage card", () => {
    it("adds up what this app's own containers are using", async () => {
      await renderSection({
        containers: [
          container({ serviceId: "svc_1" }),
          container({ serviceId: "svc_2", displayName: "queue" }),
        ],
        metrics: { svc_1: usage(), svc_2: usage() },
      });

      expect(screen.getByText("0.50 vCPU")).toBeInTheDocument();
      expect(screen.getByText("1.0 GB")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("leaves out services this app did not create", async () => {
      // The total's whole scope. A figure that quietly included someone else's services
      // would be the exact misreading the copy beside it is written to prevent.
      await renderSection({
        containers: [
          container({ serviceId: "svc_1" }),
          container({ serviceId: "svc_2", managed: false }),
        ],
        metrics: { svc_1: usage(), svc_2: usage({ cpuCores: 4 }) },
      });

      expect(screen.getByText("0.25 vCPU")).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("says nothing was reported rather than claiming a zero", async () => {
      /*
       * "0.00 vCPU across 0 containers" is a claim about idle infrastructure someone is
       * paying for, sitting inches from a dollar figure. Absent is not zero.
       */
      await renderSection({ containers: [container()], metrics: {} });

      expect(screen.getByText(/no usage for these containers yet/)).toBeInTheDocument();
      expect(screen.queryByText(/0\.00 vCPU/)).toBeNull();
    });

    it("marks a summed trace rather than rounding it to nothing", async () => {
      // Twenty containers each below a hundredth of a core add up to something two decimal
      // places still cannot show.
      await renderSection({
        containers: [container()],
        metrics: { svc_1: usage({ cpuCores: 0.001 }) },
      });

      expect(screen.getByText("< 0.01 vCPU")).toBeInTheDocument();
    });

    it("says these are not the figure Railway bills", async () => {
      // Required, not decorative: without it the two cards read as one readout, which is
      // the misreading container-section.tsx used to prevent by keeping them apart.
      await renderSection({ containers: [container()], metrics: { svc_1: usage() } });

      expect(screen.getByText(/not the figure Railway bills/)).toBeInTheDocument();
    });
  });

  it("keeps the two scopes in separate cards under their own headings", async () => {
    await renderSection({
      spend,
      containers: [container()],
      metrics: { svc_1: usage() },
    });

    expect(
      screen.getByRole("heading", { level: 2, name: "Workspace spend" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Usage by containers created here",
      }),
    ).toBeInTheDocument();
  });

  it("reports a failed container read without losing the spend figure", async () => {
    // Independent reads: a broken container list must not take the cost figure with it.
    await renderSection({ error: "Containers could not be read.", spend });

    expect(screen.getByText("Containers could not be read.")).toBeInTheDocument();
    expect(screen.getByText("$18.40")).toBeInTheDocument();
  });

  it("asks Railway for nothing when there is no environment selected", async () => {
    render(await BillingSection({ projectId: null, environmentId: null }));

    expect(loadContainers).not.toHaveBeenCalled();
    expect(screen.getByText("No environment selected")).toBeInTheDocument();
  });
});
