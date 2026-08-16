import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { DeploymentHistoryEntry } from "@/lib/railway/types";

const rollbackContainer =
  vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  rollbackContainer: (prev: unknown, formData: FormData) =>
    rollbackContainer(prev, formData),
}));

const fetchMock = vi.fn();

const { DeploymentHistory } = await import("./deployment-history");
const { ToastProvider } = await import("./ui/toast");

/**
 * One entry as the route hands it over — already mapped and already sorted, since the sort
 * belongs to `listServiceDeployments` and is asserted there.
 */
const entry = (
  id: string,
  over: Partial<DeploymentHistoryEntry> = {},
): DeploymentHistoryEntry => ({
  id,
  state: "running",
  rawStatus: "SUCCESS",
  createdAt: "2026-08-15T09:00:00.000Z",
  canRollback: true,
  ...over,
});

const respondWith = (deployments: DeploymentHistoryEntry[], refused = false) =>
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ deployments, refused }),
  });

function renderHistory(currentDeploymentId: string | null = "dep_current") {
  return render(
    <ToastProvider>
      <DeploymentHistory
        serviceId="svc_1"
        displayName="cache"
        projectId="p1"
        environmentId="e1"
        currentDeploymentId={currentDeploymentId}
      />
    </ToastProvider>,
  );
}

/** The two-entry history most cases want: the one running, and one to go back to. */
const twoEntries = () => [
  entry("dep_current", { createdAt: "2026-08-15T11:00:00.000Z" }),
  entry("dep_older"),
];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  respondWith([]);
  rollbackContainer.mockReset();
  rollbackContainer.mockResolvedValue({ ok: true, message: "Rolling cache back" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeploymentHistory", () => {
  it("reads one service's deployments when it mounts", async () => {
    /*
     * Mount is the trigger, because the component is only rendered inside an open panel —
     * the same condition the edit form relies on. Reading with the row instead would cost a
     * Railway round trip per service for a panel nobody has opened.
     */
    respondWith(twoEntries());
    renderHistory();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/service-deployments?");
    expect(url).toContain("service=svc_1");
    expect(url).toContain("project=p1");
    expect(url).toContain("environment=e1");
  });

  it("marks the deployment that is running and offers no control on it", async () => {
    respondWith(twoEntries());
    renderHistory("dep_current");

    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]!).getByText("Current")).toBeInTheDocument();
    expect(
      within(rows[0]!).queryByRole("button", { name: /roll back/i }),
    ).not.toBeInTheDocument();
  });

  it("renders an entry Railway will not roll back to, without a control", async () => {
    /*
     * Shown rather than dropped, which is the panel's whole promise about this case: the row
     * that broke things is often the one beside the row someone is looking for, and a list
     * that omitted it would read as a history with holes in it. The absence of a button is
     * the answer, and it is stated in words rather than as a disabled control.
     */
    respondWith([
      entry("dep_current", { createdAt: "2026-08-15T11:00:00.000Z" }),
      entry("dep_broken", { canRollback: false, state: "failed", rawStatus: "FAILED" }),
    ]);
    renderHistory("dep_current");

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(
      within(rows[1]!).getByText("Railway will not roll back to this one"),
    ).toBeInTheDocument();
    expect(
      within(rows[1]!).queryByRole("button", { name: /roll back/i }),
    ).not.toBeInTheDocument();
  });

  it("posts the chosen deployment id when a rollback is confirmed", async () => {
    const user = userEvent.setup();
    respondWith(twoEntries());
    renderHistory("dep_current");

    await user.click(
      await screen.findByRole("button", { name: /roll back to the deployment from/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^roll back container$/i }),
    );

    await waitFor(() => expect(rollbackContainer).toHaveBeenCalledTimes(1));
    expect(rollbackContainer.mock.calls[0]?.[1].get("deploymentId")).toBe("dep_older");
    expect(rollbackContainer.mock.calls[0]?.[1].get("serviceId")).toBe("svc_1");
  });

  it("says the read failed when the request does not land", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    renderHistory();

    expect(
      await screen.findByText(/earlier deployments could not be read/i),
    ).toBeInTheDocument();
  });

  it("says the read failed when Railway refused it, not that there is no history", async () => {
    /*
     * The defect this flag exists for. `Deployments` is a degrading read, so a token that
     * cannot make it gets a 200 and an empty list — indistinguishable from a service that
     * has genuinely never deployed unless the route says which it was. Telling the first
     * person their service has never deployed is both wrong and unactionable.
     */
    respondWith([], true);
    renderHistory();

    expect(
      await screen.findByText(/earlier deployments could not be read/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no deployments recorded/i)).not.toBeInTheDocument();
  });

  it("says Railway has no deployments when the list is genuinely empty", async () => {
    respondWith([]);
    renderHistory();

    expect(await screen.findByText(/no deployments recorded/i)).toBeInTheDocument();
  });

  it("says there is nowhere to go back to when there is only one deployment", async () => {
    /*
     * Its own sentence rather than the generic list, which would render a single row with no
     * control on it — and that reads as the control failing rather than as there being
     * nothing to roll back to.
     */
    respondWith([entry("dep_current")]);
    renderHistory("dep_current");

    expect(
      await screen.findByText(/only deployment this service has had/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("does not call a lone entry current when the service is on a different one", async () => {
    /*
     * The sentence claims a fact — "the only deployment this service has had" — and the
     * branch used to reach it on the count alone, with no check that the entry was the one
     * the service is on. Railway's list is capped at LIST.DEPLOYMENT_HISTORY and this app
     * has seen it answer with an id the service has since moved off, so a single entry that
     * is not current is a real shape rather than a hypothetical one.
     *
     * Falling through to the list is what should happen: the row renders with its own
     * rollback control, which is precisely what somebody in that position wants and what
     * the early return was silently withholding.
     */
    respondWith([entry("dep_old")]);
    renderHistory("dep_current");

    expect(await screen.findByRole("listitem")).toBeInTheDocument();
    expect(
      screen.queryByText(/only deployment this service has had/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /roll back/i })).toBeInTheDocument();
  });

  it("says nothing about a failure when the panel closes mid-request", async () => {
    /*
     * An abort is the panel collapsing, not an error — and the component is on its way out,
     * so setting state would be describing a failure to nobody.
     */
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValue(abort);
    const { unmount } = renderHistory();
    unmount();

    expect(
      screen.queryByText(/earlier deployments could not be read/i),
    ).not.toBeInTheDocument();
  });
});
