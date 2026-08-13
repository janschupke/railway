import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * The row's disclosure control.
 *
 * The chevron alone, named by sr-only text: the container name beside it is a link to
 * Railway, and an anchor cannot live inside a button.
 */
const disclosure = (name = "cache") =>
  screen.getByRole("button", { name: `Logs for ${name}` });

/**
 * Opens the panel and waits for it to actually be open.
 *
 * Expanding takes two animation frames: the first mounts the panel collapsed so the grid
 * transition has a value to interpolate *from*, the second flips it open. Without that
 * the panel would appear from `display: none`, which cannot be transitioned at all.
 */
async function expand(user: ReturnType<typeof userEvent.setup>, name = "cache") {
  await user.click(disclosure(name));
  await waitFor(() =>
    expect(disclosure(name)).toHaveAttribute("aria-expanded", "true"),
  );
}

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
  });

  it("gives an unmanaged container the one action it does have", () => {
    /*
     * The slot used to hold a button reading "Not managed here" that did nothing when
     * pressed — a control whose entire content was an explanation of why it was not a
     * control, which is read as broken long before it is read as a note. Railway's own
     * page is where this service can actually be managed, so that is what the row's
     * action column offers.
     */
    renderRow({ managed: false, serviceId: "svc_pg" });

    const open = screen.getByRole("link", { name: "Open in Railway" });
    expect(open).toHaveAttribute("href", expect.stringContaining("/service/svc_pg"));
    // A new tab that can reach back into this one is the reason rel is asserted, not
    // assumed, on every outbound link in this file.
    expect(open).toHaveAttribute("rel", "noreferrer");
  });

  it("explains why an unmanaged container has no destroy control", async () => {
    // Silently omitting the control leaves the user wondering; the reason is reachable
    // by keyboard, not buried in a title attribute.
    const user = userEvent.setup();
    renderRow({ managed: false, displayName: "postgres" });

    /*
     * A description, not a label. Overriding the name left it sharing no words with the
     * visible text — WCAG 2.5.3, and unusable by voice control — so the accessible name
     * stays "Open in Railway" and the reason rides along as the tooltip.
     */
    const open = screen.getByRole("link", { name: "Open in Railway" });
    // Radix Tooltip opens on hover or focus, not click.
    await user.hover(open);

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

    await expand(user);

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
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    /*
     * The panel outlives the collapse by one transition — it is what animates out — so
     * it is still in the tree here, at zero height. What must be immediate is that it is
     * gone from the a11y tree and the tab order, which is what `hidden` provides and
     * what a purely visual collapse would have quietly lost.
     */
    await waitFor(() => expect(screen.queryByRole("log")).toBeNull());
  });

  it("does not strand the panel when the frames land after the backstop", async () => {
    /*
     * Found by the suite failing under load, then reproduced by shrinking the backstop.
     *
     * Opening mounts the panel and schedules two animation frames to flip it open. The
     * interrupted-transition backstop sees `mounted && !expanded` — which is also what
     * one frame into opening looks like — and on a machine that delayed those frames
     * past 400ms it unmounted a panel that was on its way in. The rAF then set
     * `expanded` against an unmounted panel, leaving the row claiming
     * aria-expanded="true" over a `hidden` region: a log pane that could not be opened
     * again without a reload.
     *
     * fireEvent rather than userEvent because userEvent schedules its own timers, and
     * the whole point here is to control which timer runs first.
     */
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb) => frames.push(cb));
    vi.useFakeTimers();

    try {
      renderRow();
      fireEvent.click(disclosure());

      // The backstop window elapses while the frames are still queued.
      act(() => void vi.advanceTimersByTime(1_000));
      // Only now do they arrive. Twice: the outer frame only schedules the inner one.
      act(() => void frames.splice(0).forEach((cb) => cb(0)));
      act(() => void frames.splice(0).forEach((cb) => cb(0)));

      expect(disclosure()).toHaveAttribute("aria-expanded", "true");
      // getByRole ignores hidden subtrees, so finding it *is* the assertion.
      expect(screen.getByRole("log")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      raf.mockRestore();
    }
  });

  it("explains itself instead of streaming when there is no deployment", async () => {
    const user = userEvent.setup();
    renderRow({ deploymentId: null, state: "unknown" });

    await expand(user);

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

    await expand(user);

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
      await expand(user);

      expect(screen.getByText(/log stream could not be opened/i)).toBeInTheDocument();
    } finally {
      streamState.status = "connecting";
    }
  });

  it("keeps the relative time on one line", async () => {
    /*
     * The cell was 80px with wrapping left on, and at 12px "34 minutes ago" measures
     * about 78px — so the longest values in the commonest unit broke across two lines and
     * grew the row. The floor keeps the column aligned; nowrap is what stops the wrap,
     * and neither works without the other.
     */
    const { container: dom } = renderRow();
    const time = dom.querySelector("time")!;
    expect(time).toHaveClass("min-w-24", "whitespace-nowrap");
  });

  it("makes the name a link to the service on Railway", async () => {
    // On every row, not only the failed ones: the deep link is built from ids the row
    // already holds, so it costs nothing, and everything this app does not show —
    // variables, domains, metrics — is on the other end of it.
    renderRow({ state: "running" });

    const link = screen.getByRole("link", { name: "cache" });
    expect(link).toHaveAttribute(
      "href",
      "https://railway.com/project/p1/service/svc_1?environmentId=e1",
    );
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("points a failed deployment at the page that has the reason", async () => {
    /*
     * Railway answers this app with the enum FAILED and nothing else, and an image source
     * that fails to pull may write to neither log phase — so the row was a red badge over
     * an empty pane with no route to the explanation.
     */
    const user = userEvent.setup();
    renderRow({ state: "failed", rawStatus: "FAILED" });

    await expand(user);

    expect(screen.getByText(/reported this deployment as failed/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open in railway/i });
    expect(link).toHaveAttribute(
      "href",
      "https://railway.com/project/p1/service/svc_1?environmentId=e1",
    );
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("says nothing of the sort for a deployment that is fine", async () => {
    const user = userEvent.setup();
    renderRow({ state: "running" });

    await expand(user);

    expect(screen.queryByRole("link", { name: /open in railway/i })).toBeNull();
  });

  it("says nothing about the connection once the stream has finished normally", async () => {
    const user = userEvent.setup();
    streamState.status = "closed";
    streamState.done = true;
    try {
      renderRow({ state: "running" });
      await expand(user);

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
