import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
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

  describe("environment variables", () => {
    const pickPreset = async (user: UserEvent, name: RegExp) => {
      await user.click(screen.getByRole("button", { name: "Show preset images" }));
      await user.click(screen.getByRole("option", { name }));
    };

    const addRow = async (user: UserEvent, name: string, value: string) => {
      await user.click(screen.getByRole("button", { name: "Add variable" }));
      const position = screen.getAllByLabelText(/^Variable name/).length;
      await user.type(screen.getByLabelText(`Variable name ${position}`), name);
      if (value) {
        await user.type(screen.getByLabelText(`Variable value ${position}`), value);
      }
    };

    it("seeds no rows for an image that boots bare", () => {
      renderForm();
      expect(screen.queryByLabelText(/^Variable name/)).not.toBeInTheDocument();
    });

    it("seeds a locked, blank row for a database", async () => {
      const user = userEvent.setup();
      renderForm();

      await pickPreset(user, /PostgreSQL/);

      const name = screen.getByLabelText("Variable name 1");
      expect(name).toHaveValue("POSTGRES_PASSWORD");
      expect(name).toHaveAttribute("readonly");
      // Blank, with the placeholder saying why — never a value the browser holds.
      const value = screen.getByLabelText("Variable value 1");
      expect(value).toHaveValue("");
      expect(value).toHaveAttribute("placeholder", "Generated for you");
    });

    it("drops an untouched preset row when the image changes", async () => {
      const user = userEvent.setup();
      renderForm();

      await pickPreset(user, /PostgreSQL/);
      await pickPreset(user, /Nginx/);

      expect(screen.queryByLabelText(/^Variable name/)).not.toBeInTheDocument();
    });

    it("keeps a preset row the user typed into, and unlocks it", async () => {
      /*
       * The one rule of the reseed: nothing a person typed is thrown away by changing the
       * image. The row stops being locked because the catalog that owned its name is gone.
       */
      const user = userEvent.setup();
      renderForm();

      await pickPreset(user, /PostgreSQL/);
      await user.type(screen.getByLabelText("Variable value 1"), "hunter2");
      await pickPreset(user, /Nginx/);

      expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
      expect(screen.getByLabelText("Variable name 1")).not.toHaveAttribute("readonly");
      expect(screen.getByLabelText("Variable value 1")).toHaveValue("hunter2");
    });

    it("keeps a user-added row when the image changes", async () => {
      const user = userEvent.setup();
      renderForm();

      await addRow(user, "MY_FLAG", "on");
      await pickPreset(user, /PostgreSQL/);

      // Seeded rows go first, so the user row moves down rather than away.
      expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
      expect(screen.getByLabelText("Variable name 2")).toHaveValue("MY_FLAG");
    });

    it("submits the rows as two parallel lists, skipping the blank one", async () => {
      /*
       * The wire-format regression test. Index i of the two lists has to be one row, and
       * a row nobody typed into has to contribute to neither — that pairing is what the
       * schema and the row-attributed errors are both built on.
       */
      const user = userEvent.setup();
      renderForm();

      await user.type(screen.getByLabelText("Name"), "cache");
      await addRow(user, "ONE", "1");
      await addRow(user, "TWO", "2");
      // A third row, left entirely blank.
      await user.click(screen.getByRole("button", { name: "Add variable" }));
      await user.click(submitButton());

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
      const formData = spinUp.mock.calls[0]![1];
      expect(formData.getAll("variableKey")).toEqual(["ONE", "TWO"]);
      expect(formData.getAll("variableValue")).toEqual(["1", "2"]);
    });

    it("submits a seeded database row with its value left blank", async () => {
      // Blank is what asks the catalog for a generated credential, so it has to survive
      // the trip rather than be filtered out as an empty field.
      const user = userEvent.setup();
      renderForm();

      await pickPreset(user, /PostgreSQL/);
      await user.type(screen.getByLabelText("Name"), "db");
      await user.click(submitButton());

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
      const formData = spinUp.mock.calls[0]![1];
      expect(formData.getAll("variableKey")).toEqual(["POSTGRES_PASSWORD"]);
      expect(formData.getAll("variableValue")).toEqual([""]);
    });

    it("shows a row-attributed error next to the row, not as a toast", async () => {
      const user = userEvent.setup();
      spinUp.mockResolvedValue({
        ok: false,
        error: "Names starting with RAILWAY_ are set by Railway itself",
        field: "variableKey",
        index: 0,
      });
      renderForm();

      await user.type(screen.getByLabelText("Name"), "cache");
      await addRow(user, "RAILWAY_TOKEN", "x");
      await user.click(submitButton());

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Names starting with RAILWAY_ are set by Railway itself",
        ),
      );
      expect(screen.queryByText("Could not spin up")).not.toBeInTheDocument();
    });

    it("toasts a variable error that names no row", async () => {
      /*
       * Too many rows, or too large together — real failures with nowhere to attach an
       * inline message. Without this branch they set `field` and are swallowed by the
       * guard that suppresses toasts for field-attributed errors.
       */
      const user = userEvent.setup();
      spinUp.mockResolvedValue({
        ok: false,
        error: "Set at most 25 variables here",
        field: "variableKey",
      });
      renderForm();

      await user.type(screen.getByLabelText("Name"), "cache");
      await user.click(submitButton());

      await waitFor(() =>
        expect(screen.getByText("Set at most 25 variables here")).toBeInTheDocument(),
      );
    });

    it("clears user rows after a success and re-seeds the image's own", async () => {
      /*
       * Matching the name field rather than the image. A leftover variable set silently
       * applied to the next container is worse than a leftover name: nothing on screen
       * says the last spin-up's environment is still armed.
       */
      const user = userEvent.setup();
      renderForm();

      await pickPreset(user, /PostgreSQL/);
      await addRow(user, "MY_FLAG", "on");
      await user.type(screen.getByLabelText("Name"), "db");
      await user.click(submitButton());

      await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
      expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
      expect(screen.queryByLabelText("Variable name 2")).not.toBeInTheDocument();
    });
  });
});
