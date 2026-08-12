import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Container } from "@/lib/railway/types";

vi.mock("@/app/dashboard/actions", () => ({
  spinDown: vi.fn(async () => ({ ok: true, message: "Destroyed" })),
}));

const streamState = {
  state: null as string | null,
  rawStatus: null as string | null,
  logs: [] as Array<{ timestamp: string; message: string }>,
  status: "connecting" as "connecting" | "live" | "closed",
  done: false,
  warning: null as string | null,
  error: null as string | null,
};
const useDeploymentStream = vi.fn(() => streamState);
vi.mock("@/hooks/use-deployment-stream", () => ({
  useDeploymentStream: (...args: unknown[]) => useDeploymentStream(...(args as [])),
}));

const { ContainerRow } = await import("./container-row");
const { ToastProvider } = await import("./ui/toast");
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
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  managed: true,
  ...over,
});

/** The row's disclosure control; its accessible name starts with the container name. */
const disclosure = (name = "cache") =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

/** Mirrors the dashboard layout, which owns both providers. */
const renderRow = (over: Partial<Container> = {}) =>
  render(
    <ToastProvider>
      <TooltipProvider>
        <ul>
          <ContainerRow container={container(over)} projectId="p1" environmentId="e1" />
        </ul>
      </TooltipProvider>
    </ToastProvider>,
  );

describe("ContainerRow", () => {
  it("shows the name without the ownership prefix, and the image", () => {
    renderRow();
    expect(screen.getByText("cache")).toBeInTheDocument();
    expect(screen.getByText("redis:7-alpine")).toBeInTheDocument();
  });

  it("falls back to the repo, then to a placeholder, for the source line", () => {
    const { unmount } = renderRow({ image: null, repo: "owner/app" });
    expect(screen.getByText("owner/app")).toBeInTheDocument();
    unmount();

    renderRow({ image: null, repo: null });
    expect(screen.getByText("no source")).toBeInTheDocument();
  });

  it("offers destroy only for containers this app created", () => {
    const { unmount } = renderRow({ managed: true });
    expect(screen.getByRole("button", { name: /^destroy$/i })).toBeInTheDocument();
    unmount();

    renderRow({ managed: false });
    expect(screen.queryByRole("button", { name: /^destroy$/i })).toBeNull();
    expect(screen.getByText("Not managed here")).toBeInTheDocument();
  });

  it("explains why an unmanaged container has no destroy control", async () => {
    // Silently omitting the control leaves the user wondering; the reason is reachable
    // by keyboard, not buried in a title attribute.
    const user = userEvent.setup();
    renderRow({ managed: false, displayName: "postgres" });

    /*
     * The accessible name must be the visible text. It used to be overridden with
     * "Why can't postgres be destroyed?", which shares no words with the label on
     * screen — WCAG 2.5.3, and unusable by voice control.
     */
    const info = screen.getByRole("button", { name: "Not managed here" });
    // Radix Tooltip opens on hover or focus, not click.
    await user.hover(info);

    expect(
      await screen.findByText(/only services created in this app/i),
    ).toBeInTheDocument();
  });

  it("disables destroy while a removal is already running", () => {
    renderRow({ state: "removing" });
    expect(screen.getByRole("button", { name: /^destroy$/i })).toBeDisabled();
  });

  it("expands and collapses the log panel", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(disclosure());

    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    /*
     * getBy, and re-queried rather than captured. LogPane is a dynamic import whose
     * loading fallback presents the same role and accessible name, so the region exists
     * from the click — but holding a reference across the swap asserts on a detached
     * node once the chunk lands, which is a race, not a wait.
     */
    await waitFor(() =>
      expect(screen.getByRole("log")).toHaveAccessibleName("Container logs"),
    );

    await user.click(disclosure());
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("explains itself instead of streaming when there is no deployment", async () => {
    const user = userEvent.setup();
    renderRow({ deploymentId: null, state: "unknown" });

    await user.click(disclosure());

    expect(screen.getByText(/no deployment yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("holds no connection for a settled container nobody is watching", () => {
    renderRow({ state: "running" });
    // (deploymentId, phase, enabled)
    expect(useDeploymentStream).toHaveBeenLastCalledWith("dep_1", "deploy", false);
  });

  it("streams while a deployment is in flight, without being expanded", () => {
    renderRow({ state: "building" });
    expect(useDeploymentStream).toHaveBeenLastCalledWith("dep_1", "build", true);
  });

  it("streams a settled container once its panel is open", async () => {
    const user = userEvent.setup();
    renderRow({ state: "running" });

    await user.click(disclosure());

    expect(useDeploymentStream).toHaveBeenLastCalledWith("dep_1", "deploy", true);
  });

  it("reads build logs for a queued deployment, not deploy logs", () => {
    /*
     * A queued deployment's next stop is BUILDING, and build output is what the person
     * watching is waiting for. Nothing re-renders the row from the server mid-flight, so
     * guessing "deploy" on the strength of a stale QUEUED status meant the pane stayed
     * empty through the entire build.
     */
    renderRow({ state: "pending" });
    expect(useDeploymentStream).toHaveBeenLastCalledWith("dep_1", "build", true);
  });

  it("follows the stream's own state when it disagrees with the server render", () => {
    // The server render is as old as the page; the stream is not.
    streamState.state = "building";
    try {
      renderRow({ state: "running" });
      expect(useDeploymentStream).toHaveBeenLastCalledWith("dep_1", "build", false);
    } finally {
      streamState.state = null;
    }
  });

  it("names a stream the browser refused to open, rather than waiting on it", async () => {
    /*
     * A 400, a 401 or the per-user slot cap all reach EventSource as an unlabelled
     * failure. Silence there is a pane that waits forever on a connection nobody is
     * making, which is indistinguishable from a slow build.
     */
    const user = userEvent.setup();
    streamState.status = "closed";
    try {
      renderRow({ state: "running" });
      await user.click(disclosure());

      expect(screen.getByText(/log stream could not be opened/i)).toBeInTheDocument();
    } finally {
      streamState.status = "connecting";
    }
  });

  it("says nothing about the connection once the stream has finished normally", async () => {
    const user = userEvent.setup();
    streamState.status = "closed";
    streamState.done = true;
    try {
      renderRow({ state: "running" });
      await user.click(disclosure());

      expect(screen.queryByText(/log stream could not be opened/i)).toBeNull();
      expect(
        screen.getByText("No log output for this deployment."),
      ).toBeInTheDocument();
    } finally {
      streamState.status = "connecting";
      streamState.done = false;
    }
  });
});
