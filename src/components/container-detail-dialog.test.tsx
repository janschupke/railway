import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";
import type { Container } from "@/lib/railway/types";

const editContainer =
  vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  editContainer: (prev: unknown, formData: FormData) => editContainer(prev, formData),
}));

const { ContainerDetailDialog } = await import("./container-detail-dialog");
const { ToastProvider } = await import("./ui/toast");
// Mounted once in the dashboard layout in the app; the variable editor's row tooltips
// need one above them, and a bare Tooltip is a Radix error.
const { TooltipProvider } = await import("./ui/tooltip");

/** The variables read the edit form performs on open, answered without a network. */
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

const respondWith = (names: string[]) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ names }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-12T10:00:00Z",
  deployedAt: "2026-08-12T10:00:00Z",
  url: "https://cache.up.railway.app",
  managed: true,
  ...over,
});

function renderDialog(over: Partial<Container> = {}) {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ContainerDetailDialog
          container={container(over)}
          metrics={undefined}
          volume={undefined}
          state={over.state ?? "running"}
          projectId="p1"
          environmentId="e1"
        />
      </ToastProvider>
    </TooltipProvider>,
  );
}

const openDetail = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^details$/i }));
  return screen.findByRole("dialog");
};

/**
 * Opens the dialog, switches to edit, and waits for the variables read to settle.
 *
 * The form's shell renders immediately and the editor appears a tick later, so waiting for
 * the legend means every spec below acts on a fully mounted form rather than racing the
 * fetch — the same gate the edit dialog's own tests used before the two became one.
 */
const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
  const dialog = await openDetail(user);
  await user.click(within(dialog).getByRole("button", { name: /^edit$/i }));
  await screen.findByText("Environment variables");
  return dialog;
};

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /save changes/i }));

/** The FormData the action was called with, as parallel-array-aware plain values. */
const submitted = () => {
  const data = editContainer.mock.calls.at(-1)?.[1];
  if (!data) throw new Error("the action was never called");
  return {
    name: data.get("name"),
    image: data.get("image"),
    serviceId: data.get("serviceId"),
    variableKey: data.getAll("variableKey"),
    variableValue: data.getAll("variableValue"),
  };
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  respondWith([]);
  editContainer.mockReset();
  editContainer.mockResolvedValue({ ok: true, message: "Updating cache" });
  // Shared across the file; without this a call count is a running total.
  routerMock.refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContainerDetailDialog, reading", () => {
  it("shows what the app knows about the container", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDetail(user);

    // Scoped to the facts list: the dialog's own title is the display name too, and the
    // metrics readout below is a second <dl>.
    const facts = within(dialog.querySelector("dl") as HTMLElement);
    expect(facts.getByText("cache")).toBeVisible();
    // The prefixed name is the ownership marker, and the reason the split exists at all.
    expect(facts.getByText("spun-cache")).toBeVisible();
    expect(facts.getByText("redis:7-alpine")).toBeVisible();
    expect(facts.getByText("svc_1")).toBeVisible();
    expect(facts.getByText("Running (SUCCESS)")).toBeVisible();
    expect(
      facts.getByRole("link", { name: /cache\.up\.railway\.app/ }),
    ).toHaveAttribute("href", "https://cache.up.railway.app");
  });

  it("reads nothing from Railway until the edit form asks for it", async () => {
    /*
     * The reason variables are a route handler rather than part of the list render: they
     * cost a Railway round trip per service, against the rate limit that shapes every read
     * in this app. Opening a detail view must not become that request — twenty rows looked
     * at is twenty requests for a form nobody opened.
     */
    const user = userEvent.setup();
    renderDialog();

    await openDetail(user);
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^edit$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/service-variables?project=p1&environment=e1&service=svc_1",
    );
  });

  it("says an em dash for a container with no public address", async () => {
    const user = userEvent.setup();
    renderDialog({ url: null });
    const dialog = await openDetail(user);

    expect(within(dialog).queryByRole("link", { name: /railway\.app/ })).toBeNull();
  });

  it("falls back to the repo, then to nothing, for a service with no image", async () => {
    // ADR-6: this app deploys images, but the list holds whatever is in the environment.
    const user = userEvent.setup();
    renderDialog({ image: null, repo: "owner/app" });

    expect(within(await openDetail(user)).getByText("owner/app")).toBeVisible();
  });
});

describe("ContainerDetailDialog, on a container this app did not create", () => {
  const external = { managed: false, rawName: "legacy-api", displayName: "legacy-api" };

  it("says why it cannot be changed, in visible text", async () => {
    /*
     * The whole reason a read mode exists. The rule has always held on the server — every
     * verb goes through `withManagedContainer` — but what a reader saw of it was a row with
     * fewer buttons than its neighbour, which states nothing about why. An absence is not a
     * sentence.
     */
    const user = userEvent.setup();
    renderDialog(external);
    const dialog = await openDetail(user);

    expect(
      within(dialog).getByText(
        "This app did not create this service, so it cannot change it. " +
          "Everything below is read-only; manage it on Railway.",
      ),
    ).toBeVisible();
  });

  it("offers no edit mode at all, rather than a disabled one", async () => {
    /*
     * A disabled Edit is a promise that this container could be edited in some other state,
     * and for an external one there is no such state. Not a defence in depth either — the
     * server refuses whatever the browser sends — but the UI must not describe a capability
     * that does not exist.
     */
    const user = userEvent.setup();
    renderDialog(external);
    const dialog = await openDetail(user);

    expect(within(dialog).queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(within(dialog).queryByLabelText("Image reference")).toBeNull();
    /*
     * Still readable, which is the half that did not exist before — and twice over, because
     * an external service carries no prefix, so its display name and its name in Railway are
     * the same string. That is worth seeing rather than deduplicating: the pair being equal
     * is exactly what "this app did not create it" looks like in the data.
     */
    const facts = within(dialog.querySelector("dl") as HTMLElement);
    expect(facts.getAllByText("legacy-api")).toHaveLength(2);
  });

  it("still points at Railway, which is where it can be changed", async () => {
    const user = userEvent.setup();
    renderDialog(external);
    const dialog = await openDetail(user);

    expect(
      within(dialog).getByRole("link", { name: /open in railway/i }),
    ).toHaveAttribute("href", expect.stringContaining("svc_1"));
  });
});

describe("ContainerDetailDialog, editing", () => {
  it("opens prefilled with what the container runs now", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);

    expect(screen.getByLabelText("Name")).toHaveValue("cache");
    expect(screen.getByLabelText("Image reference")).toHaveValue("redis:7-alpine");
  });

  it("shows an existing variable as a name with an empty, explained value", async () => {
    /*
     * The write-only design, at the only place a user can see it. The stored value never
     * reaches the browser, so the row is a name and a placeholder saying what blank means —
     * and a version of this that prefilled the cell would put a database password in the DOM.
     */
    respondWith(["POSTGRES_PASSWORD"]);
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);

    const value = screen.getByLabelText("Variable value 1");
    expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", "Unchanged");
  });

  it("posts an untouched existing row blank, which is what says 'leave it alone'", async () => {
    respondWith(["KEEP"]);
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);
    await submit(user);

    await waitFor(() => expect(editContainer).toHaveBeenCalled());
    expect(submitted()).toMatchObject({
      variableKey: ["KEEP"],
      variableValue: [""],
    });
  });

  it("drops a removed row from the submission entirely", async () => {
    // Absence is the delete instruction — the action diffs against Railway's own answer, so
    // a name that stops being posted is a name that stops existing.
    respondWith(["KEEP", "DROP"]);
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);

    await user.click(screen.getByRole("button", { name: "Remove DROP" }));
    await submit(user);

    await waitFor(() => expect(editContainer).toHaveBeenCalled());
    expect(submitted().variableKey).toEqual(["KEEP"]);
  });

  it("closes, announces and refreshes the list on success", async () => {
    /*
     * The refresh is what re-keys the log stream: a changed image redeploys, and the row
     * only learns the new deployment id from a fresh server render. `useDeploymentStream`
     * keys on that id alone and re-attaches by itself once it arrives.
     */
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);
    await submit(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Updating cache")).toBeInTheDocument();
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps what was typed when the server refuses the form", async () => {
    /*
     * Why the inputs are controlled rather than uncontrolled, which is the opposite of the
     * spin-up form's choice. React resets an uncontrolled `<form action={fn}>` once the
     * action settles, so a refused submission would throw away a half-finished rename — and
     * an edit form is full by definition.
     */
    editContainer.mockResolvedValue({
      ok: false,
      field: "image",
      error: "That image reference is not valid.",
    });
    const user = userEvent.setup();
    renderDialog();
    await openEdit(user);

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "renamed");
    await submit(user);

    expect(await screen.findByText("That image reference is not valid.")).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("renamed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("lets the name and image be edited when the variables cannot be read", async () => {
    /*
     * A refused read does not refuse the form. Both other fields came off the row and need
     * nothing from Railway, and an empty editor submits no rows — so the action reads the
     * prior set itself and leaves the variables exactly as they were.
     */
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDetail(user);
    await user.click(within(dialog).getByRole("button", { name: /^edit$/i }));

    expect(
      await screen.findByText(/could not read this container's variables/i),
    ).toBeVisible();

    await submit(user);

    await waitFor(() => expect(editContainer).toHaveBeenCalled());
    expect(submitted().variableKey).toEqual([]);
  });

  it("starts empty for a service Railway describes with a repo rather than an image", async () => {
    // ADR-6: this app deploys images, and a repo-sourced service has no image to prefill.
    const user = userEvent.setup();
    renderDialog({ image: null });
    await openEdit(user);

    expect(screen.getByLabelText("Image reference")).toHaveValue("");
  });

  it("goes back to reading when a dismissed dialog is reopened", async () => {
    // A dialog that reopened mid-edit would show a form prefilled from a container
    // description that is one abandoned attempt out of date.
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openEdit(user);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const reopened = await openDetail(user);
    expect(within(reopened).getByRole("button", { name: /^edit$/i })).toBeVisible();
    expect(within(reopened).queryByLabelText("Image reference")).toBeNull();
    expect(dialog).not.toBeInTheDocument();
  });

  it("offers no edit mode while the container is on its way out", async () => {
    // The one state where the description this form edits is already being torn down.
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ToastProvider>
          <ContainerDetailDialog
            container={container()}
            metrics={undefined}
            volume={undefined}
            state="removing"
            projectId="p1"
            environmentId="e1"
            disabled
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    const dialog = await openDetail(user);
    expect(within(dialog).queryByRole("button", { name: /^edit$/i })).toBeNull();
    // The facts stay readable, which is the point of separating the two modes.
    expect(within(dialog).getByText("spun-cache")).toBeVisible();
  });
});
