import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";
import type { Container } from "@/lib/railway/types";

const spinDownMany =
  vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  spinDownMany: (prev: unknown, formData: FormData) => spinDownMany(prev, formData),
}));

const { BulkDestroyDialog } = await import("./bulk-destroy-dialog");
const { ToastProvider } = await import("./ui/toast");

const container = (name: string): Container => ({
  serviceId: `svc_${name}`,
  rawName: `spun-${name}`,
  displayName: name,
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
});

const onDestroyed = vi.fn();

function renderDialog(
  containers = [container("cache"), container("queue")],
  volumeCount = 0,
) {
  return render(
    <ToastProvider>
      <BulkDestroyDialog
        containers={containers}
        projectId="p1"
        environmentId="e1"
        volumeCount={volumeCount}
        onDestroyed={onDestroyed}
      />
    </ToastProvider>,
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Destroy selected" }));
  const dialog = await screen.findByRole("alertdialog");
  await screen.findByLabelText(/to confirm/i);
  return dialog;
};

const submitButton = () => screen.getByRole("button", { name: /permanently$/ });

/** The phrase the confirmation demands for a two-container batch, and its field's label. */
const CONFIRM_TOKEN = "destroy 2 containers";
const CONFIRM_LABEL = `Type \u201c${CONFIRM_TOKEN}\u201d to confirm`;

beforeEach(() => {
  spinDownMany.mockReset();
  spinDownMany.mockResolvedValue({ ok: true, message: "Destroyed 2 containers" });
  onDestroyed.mockReset();
  routerMock.refresh.mockClear();
});

describe("BulkDestroyDialog", () => {
  it("is disabled with nothing selected rather than absent", async () => {
    // It sits in a toolbar above the list; a trigger that came and went as rows were
    // ticked would move the list under the pointer doing the ticking.
    renderDialog([]);
    expect(screen.getByRole("button", { name: "Destroy selected" })).toBeDisabled();
  });

  it("names every container it is about to destroy", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    /*
     * The selection was built one row at a time, possibly across a filter change, so this
     * is the last place a stray tick is visible before it becomes irreversible.
     */
    const listed = within(
      screen.getByRole("list", { name: "Containers about to be destroyed" }),
    );
    expect(listed.getByText("cache")).toBeInTheDocument();
    expect(listed.getByText("queue")).toBeInTheDocument();
  });

  it("counts the batch in the title and on the button", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    expect(screen.getByText("Destroy 2 containers?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Destroy 2 containers permanently" }),
    ).toBeInTheDocument();
  });

  it("holds the submit until the whole phrase is typed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    const field = () => screen.getByLabelText(CONFIRM_LABEL);
    const retype = async (text: string) => {
      await user.clear(field());
      await user.type(field(), text);
    };

    expect(submitButton()).toBeDisabled();

    /*
     * The bare count is what this used to accept — one keystroke on a numeric keypad for
     * an irreversible action on the whole selection, where destroying a single container
     * demands its full name. It is refused now.
     */
    await retype("2");
    expect(submitButton()).toBeDisabled();

    // The count still lives inside the phrase, so a miscounted selection is still the one
    // fact this confirmation catches.
    await retype("destroy 3 containers");
    expect(submitButton()).toBeDisabled();

    // The verb alone is not the phrase either.
    await retype("destroy");
    expect(submitButton()).toBeDisabled();

    await retype(CONFIRM_TOKEN);
    expect(submitButton()).toBeEnabled();
  });

  it("does not make them hold shift as well", async () => {
    /*
     * Case-insensitive, where the single destroy matches a container name exactly. A name
     * is an identifier the reader is copying; this is prose, and the friction is meant to
     * come from typing twenty characters rather than from the first one.
     */
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText(CONFIRM_LABEL), "Destroy 2 Containers");
    expect(submitButton()).toBeEnabled();
  });

  it("posts one repeated service id per container", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText(CONFIRM_LABEL), CONFIRM_TOKEN);
    await user.click(submitButton());

    await waitFor(() => expect(spinDownMany).toHaveBeenCalledOnce());
    const formData = spinDownMany.mock.calls[0]![1];
    expect(formData.getAll("serviceId")).toEqual(["svc_cache", "svc_queue"]);
    expect(formData.get("projectId")).toBe("p1");
    expect(formData.get("environmentId")).toBe("e1");
  });

  it("asks about volumes only when the batch has any, and does not tick it by default", async () => {
    const user = userEvent.setup();
    renderDialog([container("cache")], 1);
    await open(user);

    /*
     * Unchecked, which is the opposite of the single destroy's default and the same
     * decision about a different question: one tick here covers containers whose volumes
     * the reader has not seen individually.
     */
    const box = screen.getByRole("checkbox", {
      name: "Also delete the volume attached to these containers",
    });
    expect(box).not.toBeChecked();
  });

  it("asks nothing about volumes when none of them has one", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("clears the selection and refreshes once the batch lands", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText(CONFIRM_LABEL), CONFIRM_TOKEN);
    await user.click(submitButton());

    await waitFor(() => expect(onDestroyed).toHaveBeenCalledOnce());
    expect(routerMock.refresh).toHaveBeenCalled();
    expect(await screen.findByText("Destroyed 2 containers")).toBeInTheDocument();
  });

  it("keeps the dialog open and says why when the batch is refused", async () => {
    spinDownMany.mockResolvedValue({
      ok: false,
      error: "None of them could be destroyed",
    });
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText(CONFIRM_LABEL), CONFIRM_TOKEN);
    await user.click(submitButton());

    expect(
      await screen.findByText("Could not destroy the selected containers"),
    ).toBeInTheDocument();
    // Nothing was cleared: the selection is still the thing the user was working on.
    expect(onDestroyed).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
