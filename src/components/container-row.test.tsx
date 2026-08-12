import { render, screen } from "@testing-library/react";
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
  connected: false,
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

const renderRow = (over: Partial<Container> = {}) =>
  render(
    <ToastProvider>
      <ul>
        <ContainerRow container={container(over)} projectId="p1" environmentId="e1" />
      </ul>
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
    // findBy, not getBy: the log pane is a dynamic import, so it arrives a tick later.
    expect(await screen.findByRole("log")).toBeInTheDocument();

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
});
