import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import { REGISTRY } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import type { RegionOption } from "@/lib/railway/types";

const spinUp = vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  spinUp: (prev: unknown, formData: FormData) => spinUp(prev, formData),
}));

const { SpinUpForm } = await import("./spin-up-form");
const { ToastProvider } = await import("./ui/toast");
// Mounted once in the dashboard layout in the app; the variable editor's row
// tooltips need one above them, and a bare Tooltip is a Radix error.
const { TooltipProvider } = await import("./ui/tooltip");

const OREGON = {
  id: "us-west2",
  label: "US West (Oregon)",
  country: "United States",
};

const renderForm = ({
  names = [],
  regions = [OREGON],
  ...props
}: {
  disabled?: boolean;
  names?: string[] | Promise<string[]>;
  regions?: RegionOption[] | Promise<RegionOption[]>;
} = {}) =>
  render(
    <TooltipProvider>
      <ToastProvider>
        <SpinUpForm
          projectId="p1"
          environmentId="e1"
          names={Array.isArray(names) ? Promise.resolve(names) : names}
          regions={Array.isArray(regions) ? Promise.resolve(regions) : regions}
          {...props}
        />
      </ToastProvider>
    </TooltipProvider>,
  );

/** Opens the Advanced panel, which every case below has to do before it can type. */
const openAdvanced = async (user: UserEvent) => {
  await user.click(screen.getByText("Advanced settings"));
};

/**
 * Picks one row of a Select, by the label on the control and the text on the row.
 *
 * Not `user.selectOptions`, which only drives a real `<select>`. Both advanced dropdowns
 * are Radix now, so a row is a portalled `role="option"` that exists only while the popup
 * is open — and it is addressable by its visible label rather than by the value it posts,
 * which is why every call site below names copy from `messages/en.json`.
 */
const choose = async (user: UserEvent, control: string, option: string) => {
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(await screen.findByRole("option", { name: option }));
};

/*
 * By its summary rather than by role: `<details>` and `<fieldset>` both report
 * role="group", and the variable editor contributes one.
 */
const advanced = () =>
  screen.getByText("Advanced settings").closest("details") as HTMLDetailsElement;

const submitButton = () => screen.getByRole("button", { name: /spin up container/i });
/** The image control is one editable combobox now, so this is a real <input>. */
const image = () => screen.getByLabelText("Image reference");

/**
 * The image check's transport.
 *
 * Stubbed for the whole file rather than per test: the form asks /api/image-check about
 * any non-preset reference, and jsdom has no server to answer — an unstubbed `fetch` here
 * is an unhandled rejection in whichever test happens to type a reference, which is the
 * kind of failure that gets attributed to the wrong change a week later.
 */
const fetchMock = vi.fn<typeof fetch>();
const imageCheckAnswers = (status: string) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ status }), {
      headers: { "content-type": "application/json" },
    }),
  );

const warning = () => screen.queryByRole("status");

describe("SpinUpForm", () => {
  beforeEach(() => {
    spinUp.mockReset();
    spinUp.mockResolvedValue({ ok: true, message: "Spinning up cache" });
    // Shared across the file; without this a call count is a running total.
    routerMock.refresh.mockClear();
    fetchMock.mockReset();
    imageCheckAnswers("available");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

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

  describe("the submission key", () => {
    const keyFrom = (call: number) =>
      spinUp.mock.calls[call]?.[1]?.get("idempotencyKey");

    const submitNamed = async (user: UserEvent, name: string) => {
      await user.type(screen.getByLabelText("Name"), name);
      await user.click(submitButton());
    };

    it("carries one on every submission", async () => {
      const user = userEvent.setup();
      renderForm();

      await submitNamed(user, "cache");

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
      expect(keyFrom(0)).toMatch(/^[0-9a-f]{32}$/);
    });

    it("mints a new one after a success", async () => {
      // The submission that key named is over. Reusing it would have the server answer
      // the next container with the last one's result.
      const user = userEvent.setup();
      renderForm();

      await submitNamed(user, "cache");
      await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
      await submitNamed(user, "queue");

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(2));
      expect(keyFrom(1)).not.toBe(keyFrom(0));
    });

    it("keeps the same one after a failure", async () => {
      /*
       * The property that makes retrying work. A failed submission left nothing on
       * Railway and released its key server-side, so pressing the button again is the
       * same submission — and a key re-minted on every render, or on every result,
       * would silently turn each retry into a fresh container.
       */
      spinUp.mockResolvedValue({ ok: false, error: "Rate limited by Railway" });
      const user = userEvent.setup();
      renderForm();

      await submitNamed(user, "cache");
      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
      // React resets the uncontrolled fields once a function action returns, whatever it
      // returned, so retrying means retyping. The key is state rather than a field, which
      // is exactly why it survives that reset.
      await submitNamed(user, "cache");

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(2));
      expect(keyFrom(1)).toBe(keyFrom(0));
    });
  });

  describe("the local duplicate check", () => {
    it("refuses a name already taken, without calling the action", async () => {
      // What replaced the container-list read the action used to make before every
      // create. Free, because the page has already fetched this list.
      const user = userEvent.setup();
      renderForm({ names: ["cache"] });

      // Typed as the person would type it: the slug rule runs on this side too.
      await user.type(screen.getByLabelText("Name"), "Cache");
      await user.click(submitButton());

      expect(await screen.findByText(/already exists here/)).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
      expect(spinUp).not.toHaveBeenCalled();
      // React resets an uncontrolled form once a function action returns, which is why
      // this refuses in onSubmit instead: clearing the name while asking for a different
      // one leaves nothing to change.
      expect(screen.getByLabelText("Name")).toHaveValue("Cache");
    });

    it("submits a name that only resembles a taken one", async () => {
      const user = userEvent.setup();
      renderForm({ names: ["cache"] });

      await user.type(screen.getByLabelText("Name"), "cache2");
      await user.click(submitButton());

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    });

    it("submits while the list it would check against is still loading", async () => {
      /*
       * The check is read from a promise in an effect rather than with `use`, so the form
       * paints and works without it. Suspending here would put the container round trip
       * back in front of the form, which is what its Suspense boundary exists to avoid.
       */
      const user = userEvent.setup();
      renderForm({ names: new Promise<string[]>(() => {}) });

      await user.type(screen.getByLabelText("Name"), "cache");
      await user.click(submitButton());

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    });
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

      /*
       * Seeded rows go first, so the user row moves down rather than away — and postgres
       * seeds two of them since T-491: the credential, and the PGDATA that its volume mount
       * makes necessary.
       */
      expect(screen.getByLabelText("Variable name 1")).toHaveValue("POSTGRES_PASSWORD");
      expect(screen.getByLabelText("Variable name 2")).toHaveValue("PGDATA");
      expect(screen.getByLabelText("Variable name 3")).toHaveValue("MY_FLAG");
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
      expect(formData.getAll("variableKey")).toEqual(["POSTGRES_PASSWORD", "PGDATA"]);
      // Blank asks the catalog to mint; the literal beside it travels as itself.
      expect(formData.getAll("variableValue")).toEqual([
        "",
        "/var/lib/postgresql/data/pgdata",
      ]);
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
      expect(screen.getByLabelText("Variable name 2")).toHaveValue("PGDATA");
      expect(screen.queryByLabelText("Variable name 3")).not.toBeInTheDocument();
    });
  });
  describe("the image existence check", () => {
    /*
     * Advisory throughout, and every case here is about that. Nothing a warning does stops
     * the form working — a registry having a bad day must never be the reason a spin-up
     * did not happen.
     *
     * Real timers, deliberately. The hook debounces, and driving that with fake ones means
     * user-event and the timer both wanting to own the same clock; waiting for the request
     * the debounce eventually makes is the same assertion with nothing to synchronise.
     */
    const type = async (user: UserEvent, reference: string) => {
      await user.clear(image());
      await user.type(image(), reference);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });
    };

    it("warns that the registry has no such image, without refusing it", async () => {
      imageCheckAnswers("unavailable");
      const user = userEvent.setup();
      renderForm();

      await type(user, "nonexistent/image:tag");

      expect(await screen.findByRole("status")).toHaveTextContent(
        "No public image matches this reference. Check the spelling — private registries are not supported.",
      );
      // The three things that would make this a blocking validation, and are not.
      expect(image()).not.toHaveAttribute("aria-invalid");
      expect(submitButton()).toBeEnabled();
    });

    it("spins the container up anyway", async () => {
      imageCheckAnswers("unavailable");
      const user = userEvent.setup();
      renderForm();

      await type(user, "nonexistent/image:tag");
      await screen.findByRole("status");
      await user.type(screen.getByLabelText("Name"), "cache");
      await user.click(submitButton());

      await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
      expect(spinUp.mock.calls[0]![1].get("image")).toBe("nonexistent/image:tag");
    });

    it("takes the warning back when the answer changes", async () => {
      imageCheckAnswers("unavailable");
      const user = userEvent.setup();
      renderForm();

      await type(user, "nonexistent/image:tag");
      await screen.findByRole("status");

      imageCheckAnswers("available");
      fetchMock.mockClear();
      await type(user, "ghcr.io/owner/app");

      await waitFor(() => expect(warning()).not.toBeInTheDocument());
    });

    it("asks nothing about the preset it starts on", async () => {
      /*
       * The largest saving in the feature. useDebouncedValue does not delay its first
       * render, so the value the form mounts with is checked immediately — and the only
       * reason a dashboard visit costs no request at all is that the value is a preset.
       */
      renderForm();
      await new Promise((resolve) => setTimeout(resolve, REGISTRY.DEBOUNCE_MS * 2));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows a real validation error instead of the warning", async () => {
      // Both are about the same value, and only one of them says the form will refuse it.
      imageCheckAnswers("unavailable");
      spinUp.mockResolvedValue({
        ok: false,
        field: "image",
        error: "That does not look like a valid image reference",
      });
      const user = userEvent.setup();
      renderForm();

      await type(user, "nonexistent/image:tag");
      await screen.findByRole("status");
      await user.type(screen.getByLabelText("Name"), "cache");
      await user.click(submitButton());

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That does not look like a valid image reference",
      );
      expect(warning()).not.toBeInTheDocument();
      expect(image()).toHaveAttribute("aria-invalid", "true");
    });
  });
});

describe("what the image does with data", () => {
  /*
   * Three cases, two sentences. A preset the catalog knows keeps state names its mount
   * path; an image matching no preset says the app does not know where it stores data; and
   * a preset the catalog knows keeps nothing says nothing at all — a warning there would be
   * noise on nginx and would teach people to skip the one that matters.
   */
  const pickPreset = async (user: UserEvent, name: RegExp) => {
    await user.click(screen.getByRole("button", { name: "Show preset images" }));
    await user.click(screen.getByRole("option", { name }));
  };

  it("names the mount path for an image that keeps state", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickPreset(user, /PostgreSQL/);

    expect(
      screen.getByText(
        "Data written to /var/lib/postgresql/data is kept on a volume and survives restarts.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about a preset the catalog knows keeps nothing", async () => {
    const user = userEvent.setup();
    renderForm();

    await pickPreset(user, /Nginx/);

    expect(screen.queryByText(/kept on a volume/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not know where/i)).not.toBeInTheDocument();
  });

  it("warns for an image it has never heard of, which gets no volume", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "couchdb:3");

    expect(
      screen.getByText(/does not know where this image stores data/i),
    ).toBeVisible();
  });

  it("follows the repository rather than the tag, like every other preset lookup", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "postgres:17");

    expect(
      screen.getByText(/\/var\/lib\/postgresql\/data is kept on a volume/),
    ).toBeVisible();
  });

  it("says nothing while the field is empty", async () => {
    // A warning about an image nobody has chosen yet is a warning about nothing.
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());

    expect(screen.queryByText(/does not know where/i)).not.toBeInTheDocument();
  });
});

describe("the public port", () => {
  /*
   * Its own setup rather than the outer block's. This describe is a sibling of
   * `SpinUpForm`, so nothing above it runs here — and without the reset every case would
   * inherit the previous one's call count and its resolved result, which is exactly the
   * state these assertions are about.
   */
  beforeEach(() => {
    spinUp.mockReset();
    spinUp.mockResolvedValue({ ok: true, message: "Spinning up cache" });
    routerMock.refresh.mockClear();
    fetchMock.mockReset();
    imageCheckAnswers("available");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const port = () => screen.getByLabelText("Public port");

  it("seeds the catalog's port for an image that serves HTTP", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "nginx:alpine");

    expect(port()).toHaveValue("80");
  });

  /*
   * Blank is the answer for both of the catalog's undefineds — a preset that serves nothing,
   * and an image it has never heard of — because in both cases the app has no port to offer
   * and the person is the one who knows.
   */
  it("leaves it blank for an image with nothing to expose", () => {
    renderForm();
    expect(port()).toHaveValue("");
  });

  it("leaves it blank for an image the catalog has never heard of", async () => {
    const user = userEvent.setup();
    imageCheckAnswers("unknown");
    renderForm();

    await user.clear(image());
    await user.type(image(), "ghcr.io/owner/api:1");

    expect(port()).toHaveValue("");
  });

  it("follows the image while nobody has touched it", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "nginx:alpine");
    expect(port()).toHaveValue("80");

    await user.clear(image());
    await user.type(image(), "redis:7-alpine");
    expect(port()).toHaveValue("");
  });

  it("keeps a port the person typed, whatever the image becomes", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(port(), "8080");
    await user.clear(image());
    await user.type(image(), "nginx:alpine");

    expect(port()).toHaveValue("8080");
  });

  /*
   * Clearing the seeded 80 is how a person says "do not expose this", so it has to count as
   * touched. Without that, switching away from nginx and back would helpfully re-add the
   * port that was just deleted.
   */
  it("treats a cleared port as a decision, not as an untouched blank", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "nginx:alpine");
    await user.clear(port());

    await user.clear(image());
    await user.type(image(), "caddy:2-alpine");

    expect(port()).toHaveValue("");
  });

  it("submits the port alongside the image", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(image());
    await user.type(image(), "nginx:alpine");
    await user.type(screen.getByLabelText("Name"), "web");
    await user.click(submitButton());

    await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    expect(spinUp.mock.calls[0]?.[1].get("port")).toBe("80");
  });

  /*
   * The same argument the variable rows make: a port left armed from the last spin-up would
   * put the NEXT container on the public internet with nothing on screen having said so.
   */
  it("returns to the catalog's answer after a success", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(port(), "9000");
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(port()).toHaveValue(""));
  });

  it("renders a refused port next to the field rather than as a toast", async () => {
    const user = userEvent.setup();
    spinUp.mockResolvedValue({
      ok: false,
      error: "Give a port between 1 and 65,535, or leave it blank",
      field: "port",
    });
    renderForm();

    await user.type(port(), "70000");
    await user.type(screen.getByLabelText("Name"), "web");
    await user.click(submitButton());

    expect(
      await screen.findByText("Give a port between 1 and 65,535, or leave it blank"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not spin up")).not.toBeInTheDocument();
  });
});

describe("the advanced panel", () => {
  beforeEach(() => {
    spinUp.mockReset();
    spinUp.mockResolvedValue({ ok: true, message: "Spinning up cache" });
    routerMock.refresh.mockClear();
    fetchMock.mockReset();
    imageCheckAnswers("available");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * The ticket's own constraint: the common case stays the fields it was. Everything Railway
   * would otherwise default is a click away rather than on screen.
   */
  it("is closed on first render, with image and name outside it", () => {
    renderForm();
    expect(advanced().open).toBe(false);
    expect(advanced()).not.toContainElement(image());
    expect(advanced()).not.toContainElement(screen.getByLabelText("Name"));
  });

  it("submits every advanced field under the name the schema reads", async () => {
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => expect(screen.getByLabelText("Region")).not.toBeDisabled());

    await openAdvanced(user);
    await choose(user, "Region", "US West (Oregon)");
    await user.type(screen.getByLabelText("Replicas"), "3");
    await user.type(screen.getByLabelText("vCPU"), "0.5");
    await user.type(screen.getByLabelText("Memory (GB)"), "2");
    await choose(user, "Restart policy", "On failure");
    await user.type(screen.getByLabelText("Retries"), "4");
    await user.type(screen.getByLabelText("Start command"), "serve --port 80");
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    const submitted = spinUp.mock.calls[0]![1];
    expect(submitted.get("region")).toBe("us-west2");
    expect(submitted.get("replicas")).toBe("3");
    expect(submitted.get("cpu")).toBe("0.5");
    expect(submitted.get("memory")).toBe("2");
    expect(submitted.get("restartPolicy")).toBe("ON_FAILURE");
    expect(submitted.get("restartRetries")).toBe("4");
    expect(submitted.get("startCommand")).toBe("serve --port 80");
  });

  /*
   * Collapsing the panel is "tidy this away", not "throw this away". The primitive's own
   * test asserts the mechanism; this asserts it survives being wired into a real form, which
   * is the version that would break if the panel were ever conditionally rendered.
   */
  it("keeps a value that was set and then hidden again", async () => {
    const user = userEvent.setup();
    renderForm();

    await openAdvanced(user);
    await user.type(screen.getByLabelText("Replicas"), "2");
    await user.click(screen.getByText("Advanced settings"));
    expect(advanced().open).toBe(false);

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    expect(spinUp.mock.calls[0]![1].get("replicas")).toBe("2");
  });

  /*
   * The `key={submissionKey}` behaviour, both halves. The values clear because the subtree
   * remounts; the panel stays open because the `<details>` around it does not. Keying the
   * `<details>` instead looks identical in review and fails the second assertion.
   */
  it("clears its values on success without closing the panel", async () => {
    const user = userEvent.setup();
    renderForm();

    await openAdvanced(user);
    await user.type(screen.getByLabelText("Replicas"), "3");
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByLabelText("Replicas")).toHaveValue(""));
    expect(advanced().open).toBe(true);
  });

  /*
   * The other half of the same rule. A failed submission left nothing on Railway and the
   * person is about to correct one field — throwing away the other six would be the form
   * punishing them for a typo.
   */
  it("keeps its values when the submission failed", async () => {
    const user = userEvent.setup();
    spinUp.mockResolvedValue({
      ok: false,
      error: "Run at most 5 replicas here. Scale further on Railway.",
      field: "replicas",
    });
    renderForm();

    await openAdvanced(user);
    await user.type(screen.getByLabelText("Replicas"), "9");
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await screen.findByText("Run at most 5 replicas here. Scale further on Railway.");
    expect(screen.getByLabelText("Replicas")).toHaveValue("9");
  });

  it("renders an advanced failure beside its field rather than as a toast", async () => {
    const user = userEvent.setup();
    spinUp.mockResolvedValue({
      ok: false,
      error: "Ask for at most 8 vCPU here. Size a bigger service on Railway.",
      field: "cpu",
    });
    renderForm();

    await openAdvanced(user);
    await user.type(screen.getByLabelText("vCPU"), "99");
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    expect(
      await screen.findByText(
        "Ask for at most 8 vCPU here. Size a bigger service on Railway.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not spin up")).not.toBeInTheDocument();
  });

  /*
   * An inline error inside a closed panel is a form that failed silently. This is the one
   * thing the form writes to `open`, and it is why Disclosure forwards a ref at all.
   */
  it("opens itself when a failure names a field inside it", async () => {
    const user = userEvent.setup();
    spinUp.mockResolvedValue({
      ok: false,
      error: "Replicas is a whole number, one or more, or blank",
      field: "replicas",
    });
    renderForm();

    expect(advanced().open).toBe(false);
    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(advanced().open).toBe(true));
    expect(
      screen.getByText("Replicas is a whole number, one or more, or blank"),
    ).toBeInTheDocument();
  });

  /*
   * The two controls that are deliberately not attributable to a field. Their only reachable
   * failure is a stale page, which is a sentence about the page — so it toasts, where the
   * other five render inline. See the note on ActionField.
   */
  it("toasts a region failure, which names no control to correct", async () => {
    const user = userEvent.setup();
    spinUp.mockResolvedValue({
      ok: false,
      error: "That is not a region Railway offers. Reload the page and try again.",
    });
    renderForm();

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    expect(await screen.findByText("Could not spin up")).toBeInTheDocument();
    expect(
      screen.getByText(
        "That is not a region Railway offers. Reload the page and try again.",
      ),
    ).toBeInTheDocument();
  });

  /*
   * Retries only means something under ON_FAILURE, and a disabled input is not submitted at
   * all — so the coupling is what stops a retry count reaching a policy that ignores it,
   * rather than a cross-field rule in the schema.
   */
  it("enables retries only for the policy the number applies to", async () => {
    const user = userEvent.setup();
    renderForm();

    await openAdvanced(user);
    expect(screen.getByLabelText("Retries")).toBeDisabled();

    await choose(user, "Restart policy", "On failure");
    expect(screen.getByLabelText("Retries")).toBeEnabled();

    await user.type(screen.getByLabelText("Retries"), "4");
    await choose(user, "Restart policy", "Always");
    expect(screen.getByLabelText("Retries")).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "cache");
    await user.click(submitButton());

    await waitFor(() => expect(spinUp).toHaveBeenCalledTimes(1));
    expect(spinUp.mock.calls[0]![1].get("restartRetries")).toBeNull();
  });

  it("offers the regions it was given, grouped by country", async () => {
    const user = userEvent.setup();
    renderForm({
      regions: [OREGON, { id: "eu-west4", label: "Amsterdam", country: "Netherlands" }],
    });

    await openAdvanced(user);
    await waitFor(() => expect(screen.getByLabelText("Region")).not.toBeDisabled());

    // Portalled and mounted only while open, unlike the <optgroup>s this replaced — so
    // the popup has to be opened before there is anything to count.
    await user.click(screen.getByRole("combobox", { name: "Region" }));
    const listbox = within(await screen.findByRole("listbox"));

    expect(listbox.getByRole("option", { name: "US West (Oregon)" })).toBeVisible();
    expect(listbox.getByRole("group", { name: "United States" })).toBeVisible();
    expect(listbox.getByRole("group", { name: "Netherlands" })).toBeVisible();
    // "Railway chooses" is ungrouped: an unlabelled group announces itself with no name.
    expect(listbox.getAllByRole("group")).toHaveLength(2);
  });

  /*
   * The read is allowed to fail into an empty list — see deployRegions — and the honest
   * answer to that is a disabled control that says Railway will choose, not a dropdown whose
   * only row is "Railway chooses".
   */
  it("disables the region select and says so when the list came back empty", async () => {
    const user = userEvent.setup();
    renderForm({ regions: [] });

    await openAdvanced(user);
    await waitFor(() => expect(screen.getByLabelText("Region")).toBeDisabled());
    expect(
      screen.getByText("Railway did not offer a region list, so it will choose one."),
    ).toBeInTheDocument();
  });
});
