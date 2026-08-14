import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";

const editContainer =
  vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  editContainer: (prev: unknown, formData: FormData) => editContainer(prev, formData),
}));

const { EditContainerDialog } = await import("./edit-container-dialog");
const { ToastProvider } = await import("./ui/toast");

/** The variables read the form performs on open, answered without a network. */
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

const respondWith = (names: string[]) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ names }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

function renderDialog(image: string | null = "redis:7-alpine") {
  return render(
    <ToastProvider>
      <EditContainerDialog
        serviceId="svc_1"
        displayName="cache"
        image={image}
        projectId="p1"
        environmentId="e1"
      />
    </ToastProvider>,
  );
}

/**
 * Opens the dialog and waits for the variables read to settle.
 *
 * The shell renders immediately and the editor appears a tick later, so waiting for the
 * legend means every spec below acts on a fully mounted form rather than racing the fetch.
 */
const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^edit$/i }));
  const dialog = await screen.findByRole("dialog");
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

describe("EditContainerDialog", () => {
  it("opens prefilled with what the container runs now", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    expect(dialog).toHaveTextContent("Edit cache");
    expect(screen.getByLabelText("Name")).toHaveValue("cache");
    expect(screen.getByLabelText("Image reference")).toHaveValue("redis:7-alpine");
  });

  it("reads the container's variables only once it is opened", async () => {
    /*
     * The reason this is a route handler rather than part of the list render: it costs a
     * Railway round trip per service, against the rate limit that shapes every read in this
     * app. Twenty rows must not be twenty requests for a panel nobody opened.
     */
    const user = userEvent.setup();
    renderDialog();

    expect(fetchMock).not.toHaveBeenCalled();

    await openDialog(user);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/service-variables?project=p1&environment=e1&service=svc_1",
    );
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
    await openDialog(user);

    const value = screen.getByLabelText("Variable value 1");
    expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", "Unchanged");
  });

  it("posts an untouched existing row blank, which is what says 'leave it alone'", async () => {
    respondWith(["KEEP"]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
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
    await openDialog(user);

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
    await openDialog(user);
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
    await openDialog(user);

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

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
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
    renderDialog(null);
    await openDialog(user);

    expect(screen.getByLabelText("Image reference")).toHaveValue("");
  });
});
