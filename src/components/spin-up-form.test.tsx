import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";

const spinUp = vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  spinUp: (prev: unknown, formData: FormData) => spinUp(prev, formData),
}));

const { SpinUpForm } = await import("./spin-up-form");
const { ToastProvider } = await import("./ui/toast");

const renderForm = (props: { disabled?: boolean } = {}) =>
  render(
    <ToastProvider>
      <SpinUpForm projectId="p1" environmentId="e1" {...props} />
    </ToastProvider>,
  );

const submitButton = () => screen.getByRole("button", { name: /spin up container/i });
/** The image control is one editable combobox now, so this is a real <input>. */
const image = () => screen.getByLabelText("Image reference");

describe("SpinUpForm", () => {
  beforeEach(() => {
    spinUp.mockReset();
    spinUp.mockResolvedValue({ ok: true, message: "Spinning up cache" });
    // Shared across the file; without this a call count is a running total.
    routerMock.refresh.mockClear();
  });

  it("defaults to a preset that stays running once started", () => {
    // A preset that boots and exits reads as a bug in this app, not in the image.
    renderForm();
    expect(image()).toHaveValue("redis:7-alpine");
  });

  it("fills the image field from the preset list", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("button", { name: "Show preset images" }));
    await user.click(screen.getByRole("option", { name: /Nginx/ }));

    expect(image()).toHaveValue("nginx:alpine");
  });

  it("groups the list by what the images are for", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("button", { name: "Show preset images" }));

    expect(screen.getByRole("group", { name: "Databases" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Web servers" })).toBeInTheDocument();
  });

  it("highlights options without moving focus or changing the value", async () => {
    /*
     * The editable-combobox contract: focus never leaves the input, because the input is
     * the control — it carries the ARIA state and it is what the user is typing into.
     * Highlighting is announced through aria-activedescendant instead, and nothing is
     * committed until Enter.
     */
    const user = userEvent.setup();
    renderForm();

    image().focus();
    await user.keyboard("{ArrowDown}");
    expect(image()).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{ArrowDown}");
    expect(image()).toHaveFocus();
    expect(image()).toHaveValue("redis:7-alpine");
    expect(image().getAttribute("aria-activedescendant")).toBeTruthy();

    await user.keyboard("{Enter}");
    expect(image()).toHaveValue("memcached:1-alpine");
    expect(image()).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes the editable-combobox ARIA, not a select's", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(image()).toHaveAttribute("role", "combobox");
    expect(image()).toHaveAttribute("aria-autocomplete", "list");
    // Omitted, never "": an empty value makes NVDA re-announce the whole field.
    expect(image()).not.toHaveAttribute("aria-activedescendant");

    await user.click(screen.getByRole("button", { name: "Show preset images" }));
    const listbox = screen.getByRole("listbox");
    expect(image().getAttribute("aria-controls")).toBe(listbox.id);
  });

  it("accepts a hand-typed image over the preset", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "ghcr.io/owner/app:1.0.0");

    expect(image()).toHaveValue("ghcr.io/owner/app:1.0.0");
    // Nothing in the catalog matches, and that is not an error — the field takes any
    // reference the server accepts, and the server is what decides.
    expect(screen.getByText(/no preset matches/i)).toBeInTheDocument();
  });

  it("closes the list on Escape without touching what was typed", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "ghcr.io/owner/app");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(image()).toHaveValue("ghcr.io/owner/app");
    expect(image()).toHaveFocus();
  });

  it("shows the whole catalog again once a preset is selected", async () => {
    /*
     * Filtering on a committed value would leave every other preset unreachable without
     * clearing the field first — the list would narrow to the one entry the field
     * already holds. Typing narrows; a known value does not.
     */
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("button", { name: "Show preset images" }));

    expect(screen.getAllByRole("option").length).toBeGreaterThan(5);
  });

  it("submits both fields to the action", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    const formData = spinUp.mock.calls[0]?.[1];
    expect(formData?.get("name")).toBe("cache");
    expect(formData?.get("image")).toBe("redis:7-alpine");
    expect(formData?.get("projectId")).toBe("p1");
  });

  it("clears the name after a successful submit, but keeps the image", async () => {
    // Spinning up several containers from one image is the common case.
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
    expect(image()).toHaveValue("redis:7-alpine");
  });

  it("announces success", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    expect(await screen.findByText("Spinning up cache")).toBeInTheDocument();
  });

  it("shows a field error next to the field rather than as a toast", async () => {
    spinUp.mockResolvedValue({
      ok: false,
      field: "name",
      error: 'A container named "cache" already exists here.',
    });

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    const error = await screen.findByText(/already exists here/);
    expect(error).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("surfaces an unattributable failure as a toast", async () => {
    spinUp.mockResolvedValue({ ok: false, error: "Rate limited by Railway" });

    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    expect(await screen.findByText("Could not spin up")).toBeInTheDocument();
    expect(screen.getByText("Rate limited by Railway")).toBeInTheDocument();
  });

  it("pulls the fresh list exactly once on success", async () => {
    /*
     * Only the call is asserted, not the busy window it opens. `refresh` is a no-op spy
     * here, so the transition wrapping it resolves in the same tick; in the browser it
     * stays pending for the Railway round trip, which is covered by
     * e2e/skeleton.spec.ts. "Exactly once" is the guard against the effect-dependency
     * loop that fired this repeatedly before.
     */
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("explains why it is disabled instead of silently doing nothing", async () => {
    renderForm({ disabled: true });

    expect(submitButton()).toBeDisabled();
    expect(
      screen.getByText("Select a project and environment first."),
    ).toBeInTheDocument();
  });
});
