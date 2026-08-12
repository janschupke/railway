import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("SpinUpForm", () => {
  beforeEach(() => {
    spinUp.mockReset();
    spinUp.mockResolvedValue({ ok: true, message: "Spinning up cache" });
  });

  it("defaults to a preset that stays running once started", () => {
    // A preset that boots and exits reads as a bug in this app, not in the image.
    renderForm();
    expect(screen.getByLabelText("Image reference")).toHaveValue("redis:7-alpine");
  });

  it("fills the image field from a preset chip", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Nginx" }));

    expect(screen.getByLabelText("Image reference")).toHaveValue("nginx:alpine");
  });

  it("moves focus between presets with arrow keys, selecting on Enter", async () => {
    /*
     * Radix roving tabindex: the whole chip row is one tab stop and arrows move
     * within it. Focus moves without selecting — activation is explicit — so a
     * keyboard user can survey the options without changing the image.
     */
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Redis" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("radio", { name: "Nginx" })).toHaveFocus();
    expect(screen.getByLabelText("Image reference")).toHaveValue("redis:7-alpine");

    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Image reference")).toHaveValue("nginx:alpine");
  });

  it("accepts a hand-typed image over the preset", async () => {
    const user = userEvent.setup();
    renderForm();

    const image = screen.getByLabelText("Image reference");
    await user.clear(image);
    await user.type(image, "ghcr.io/owner/app:1.0.0");

    expect(image).toHaveValue("ghcr.io/owner/app:1.0.0");
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
    expect(screen.getByLabelText("Image reference")).toHaveValue("redis:7-alpine");
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

  it("explains why it is disabled instead of silently doing nothing", async () => {
    renderForm({ disabled: true });

    expect(submitButton()).toBeDisabled();
    expect(
      screen.getByText("Select a project and environment first."),
    ).toBeInTheDocument();
  });
});
