import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { Faults } from "./fixtures/fake-railway/store";

const FIXTURE_URL = `http://localhost:${process.env.FAKE_RAILWAY_PORT ?? 4010}`;

/** Every spec starts from a known fixture state; workers:1 makes this safe. */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.request.post(`${FIXTURE_URL}/__test/reset`);
    await use(page);
  },
});

export { expect };

/*
 * `Partial<Faults>` rather than a list of knobs written out again.
 *
 * The copy that used to be here restated all twenty-seven by hand, so it could only ever
 * be as current as the last person to add one — and it had already fallen behind by
 * three. Worse, a knob the store does not have was not a type error, so a typo silently
 * posted a fault nothing would ever read and the spec failed somewhere else entirely.
 */
export async function injectFaults(page: Page, faults: Partial<Faults>) {
  await page.request.post(`${FIXTURE_URL}/__test/faults`, { data: faults });
}

export type FixtureStats = {
  authorizationCode: number;
  refreshToken: number;
  refreshRejected: number;
  /** GraphQL operations the fixture has answered, by name. */
  operations: Record<string, number>;
};

/**
 * Grant counters from the fixture.
 *
 * Token refresh happens server-side, between Next and the fixture, so the browser
 * never issues that request and Playwright cannot observe it with waitForRequest.
 */
export async function fixtureStats(page: Page): Promise<FixtureStats> {
  const response = await page.request.get(`${FIXTURE_URL}/__test/stats`);
  return response.json() as Promise<FixtureStats>;
}

/** The app's own alert regions, excluding Next's always-present empty route announcer. */
export function alerts(page: Page) {
  return page.getByRole("alert").filter({ hasNotText: /^$/, visible: true });
}

/**
 * Toast notifications, located through Radix's own viewport region.
 *
 * NOT `getByRole("status")`, which is what this used to be and is a trap. Radix does not
 * put that role on the toast itself: it renders a separate, visually-hidden
 * `role="status"` copy of the toast's text for screen readers, removes it about a second
 * later, and marks the close button `data-radix-toast-announce-exclude` so it is left
 * out of that copy entirely.
 *
 * So every assertion here was matching a transient hidden div rather than the toast on
 * screen. Text assertions passed anyway — the copy carries the same words — which meant
 * a toast that never rendered visibly would still have passed, and anything that had to
 * *interact* with one could not resolve at all.
 */
function toasts(page: Page) {
  return onlyVisible(
    page.getByRole("region", { name: /notifications/i }).getByRole("listitem"),
  );
}

/**
 * One toast, by its text. Several can be on screen at once — spinning a container up
 * and destroying it within the toast lifetime leaves both visible — so an assertion
 * has to name the one it means.
 */
export function toast(page: Page, text: string | RegExp) {
  return toasts(page).filter({ hasText: text });
}

/**
 * Restricts a locator to elements the user can actually see.
 *
 * While React streams, finished content is parked in a hidden container before being
 * relocated into place, so for roughly 100ms the document holds two copies of the page
 * and every unqualified locator is ambiguous. Filtering on visibility is both the fix
 * and the more honest assertion — a spec should only ever act on what a user could.
 */
export const onlyVisible = (locator: Locator) => locator.filter({ visible: true });

/**
 * Waits until a dialog is actually able to receive the next click or Escape.
 *
 * **Three signals, and each one is earned by a failure that happened without it.** The
 * dialog being visible is not enough: Radix renders the shell before the body settles, so
 * a spec acting on `alertdialog` alone proves nothing about the form inside it — hence
 * `ready`, which is the confirm field for the destroy dialog and the confirm button for the
 * ones with nothing to type into. And `pointer-events: auto` is the layer gate: Radix hands
 * a dialog its layer one render AFTER it appears, and a click or an Escape landing in that
 * window is swallowed, which reads as a flaky test rather than as a race.
 *
 * This sequence was written out five times, under four separate docblocks each arguing the
 * same point in slightly different words. The argument is the same every time and now it is
 * written once.
 */
async function awaitDialogReady(dialog: Locator, ready?: Locator) {
  await expect(dialog).toBeVisible();
  if (ready) await expect(ready).toBeVisible();
  await expect(dialog).toHaveCSS("pointer-events", "auto");
  return dialog;
}

/**
 * A form control, by its exact label.
 *
 * `exact` is load-bearing rather than tidy. `getByLabel` defaults to a case-insensitive
 * substring match, so once the spin-up form grew an environment editor, `field(page,
 * "Name")` matched both the container name and every "Variable name N" cell — three specs
 * failed on a strict-mode violation that named neither of them. A label is an identifier
 * here; matching part of one is how a spec silently starts acting on a different control.
 */
export const field = (page: Page, label: string) =>
  onlyVisible(page.getByLabel(label, { exact: true }));

export const button = (page: Page, name: RegExp | string) =>
  onlyVisible(page.getByRole("button", { name }));

/** The container list, named so it cannot be confused with the toast viewport. */
export const containerList = (page: Page) =>
  onlyVisible(page.getByRole("list", { name: "Containers" }));

/**
 * Every row currently rendered.
 *
 * The list is paged, so this is what is on screen rather than what the environment
 * holds — which is the distinction a paging spec is actually about.
 */
export const containerRows = (page: Page) => containerList(page).getByRole("listitem");

/** The list's search field. */
export const searchBox = (page: Page) =>
  onlyVisible(page.getByLabel("Search containers"));

/** The status dropdown's checkbox group, once it is open. */
export const statusOptions = (page: Page) =>
  onlyVisible(page.getByRole("group", { name: "Filter by status" }));

/**
 * Ticks one status in the filter dropdown, then closes it.
 *
 * The popup deliberately survives a tick — narrowing a list is iterative — so closing it
 * is a separate act, and it is done here rather than left to the caller: a spec that read
 * the list through an open popup covering it would be asserting about the wrong pixels.
 */
export async function selectStatus(page: Page, label: string) {
  await button(page, /^Status/).click();
  await statusOptions(page).getByLabel(label, { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(statusOptions(page)).toBeHidden();
}

export function row(page: Page, name: string) {
  return onlyVisible(
    containerList(page).getByRole("listitem").filter({ hasText: name }),
  );
}

/**
 * A row's log disclosure.
 *
 * The chevron alone, and its accessible name is sr-only: the container name next to it
 * is a link to Railway now, so a `{ name: /^cache/ }` button query would find nothing.
 * A helper rather than nine inline queries, because that spelling is exactly what broke.
 */
export function disclosure(page: Page, name: string) {
  return onlyVisible(row(page, name).getByRole("button", { name: `Logs for ${name}` }));
}

/** A row's link out to Railway's own page for the service — the container name. */
export function railwayLink(page: Page, name: string) {
  /*
   * `exact`, because a row can hold two links now. Since T-485 a container with a public
   * address renders it beside its source, and that link is named "Open cache at
   * spun-cache-production.up.railway.app" — which contains the container's name, so a
   * substring match resolves to both and fails strict mode. This helper means the name
   * link, whose accessible name is the container's name and nothing else.
   */
  return onlyVisible(row(page, name).getByRole("link", { name, exact: true }));
}

/**
 * Waits for a re-render to finish.
 *
 * A Server Action followed by router.refresh() streams a fresh tree the same way the
 * initial load does, so the container list momentarily exists twice. Asserting on the
 * count retries until exactly one remains — no fixed sleep, and it fails loudly if the
 * page genuinely renders two lists.
 *
 * **This used to wait on the spin-up button too, and no longer can.** That button is on
 * /dashboard/new now, and this helper runs on /dashboard where it does not exist — so the
 * wait would have been a locator that never resolves. `spinUp` below covers the half that
 * was about a submission in flight: it waits for the navigation the form performs on
 * success, which is a stronger signal than the button going idle, because the destination
 * render is what the caller is about to assert on.
 *
 * The second line below covers the other half, and it is not optional — dropping it is
 * what made two filter specs fail on strict-mode violations naming two identical elements.
 * While React streams, finished content is parked in a container off to one side and
 * relocated a moment later, so the document briefly holds two copies of everything, and any
 * unqualified locator a caller then writes is ambiguous. The old spin-up-button wait had
 * been closing that window by accident, which is why removing it surfaced this.
 *
 * A **CSS** locator, deliberately, and this is the part that is easy to get wrong: a
 * `getByRole` or `getByLabel` count reports 1 through the whole window, because the parked
 * copy is out of the accessibility tree — so the obvious spelling of this line waits for
 * nothing while the duplicate the caller is about to trip over is still in the DOM.
 * `ul[aria-label]` matches it regardless.
 *
 * This was also once blamed for a dialog swallowing an Escape. It was not the cause —
 * see dismissWithEscape below, which is.
 */
export async function settled(page: Page) {
  await expect(containerList(page)).toHaveCount(1);
  await expect(page.locator('ul[aria-label="Containers"]')).toHaveCount(1);
}

/** Completes the real OAuth round trip and lands on the dashboard. */
export async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: /sign in with railway/i }).click();
  await page.waitForURL("**/dashboard**");
  await expect(
    onlyVisible(page.getByRole("heading", { name: "Containers" })),
  ).toBeVisible();
  await settled(page);
}

/**
 * Waits until a Radix layer is listening for Escape, then presses it.
 *
 * Being on screen is not the same as being dismissable, and the gap is real: Radix's
 * DismissableLayer only attaches its keydown handler once `isHighestLayer` is true, and
 * that needs a *second* render — the content ref sets state, an effect adds the node to
 * the layer set, and a CONTEXT_UPDATE event forces the re-render that finally computes
 * the index. `toBeVisible()` resolves after the first commit, several milliseconds early.
 *
 * Measured: an Escape sent 2-8ms after the node appeared was swallowed; 10ms and later
 * always landed. A person cannot type into that window, but Playwright can, and does —
 * keyboard input has no actionability check, which is why only the Escape presses ever
 * saw this and every click-driven dismissal was always fine.
 *
 * `pointer-events: auto` is the signal rather than a delay because Radix computes it from
 * the same layer index on the same render: the style flipping IS the handler attaching.
 * (It is inline `auto` from the start on a layer that does not disable outside pointer
 * events, so this gates modal layers — Select, AlertDialog — and is merely harmless on
 * the combobox popover, whose Escape is the app's own handler and live at commit.)
 */
export async function dismissWithEscape(page: Page, layer: Locator) {
  await expect(layer).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Escape");
}

/**
 * Opens the destroy confirmation and waits until it is actually usable.
 *
 * Two separate readiness signals, both earned: the confirm field, because the dialog
 * shell renders before its body settles and a spec that acts on `alertdialog` alone
 * proves nothing about the form; and the layer gate above, because the dialog handles
 * Escape a render later than it appears.
 */
export async function openDestroyDialog(page: Page, name: string) {
  await onlyVisible(
    row(page, name).getByRole("button", { name: /^destroy$/i }),
  ).click();
  const dialog = onlyVisible(page.getByRole("alertdialog"));
  return awaitDialogReady(dialog, dialog.getByLabel(/to confirm/i));
}

/**
 * Runs one of a row's reversible actions, from its trigger to its confirmation.
 *
 * Separate from `openDestroyDialog` because the two confirmations are deliberately not the
 * same: this one has no field to type into, so the readiness signal is the confirm button
 * rather than the input, and the layer gate is what keeps an Escape from being swallowed.
 *
 * The trigger and the confirm button are matched separately on purpose — "Stop" and "Stop
 * container" are two controls, and a loose match would click whichever the dialog painted
 * first.
 */
export async function runRowAction(
  page: Page,
  name: string,
  action: "Stop" | "Restart" | "Redeploy",
) {
  await onlyVisible(
    row(page, name).getByRole("button", { name: new RegExp(`^${action}$`) }),
  ).click();

  const dialog = onlyVisible(page.getByRole("alertdialog"));
  const confirm = dialog.getByRole("button", {
    name: new RegExp(`^${action} container$`, "i"),
  });
  await awaitDialogReady(dialog, confirm);

  await confirm.click();
  await expect(dialog).toBeHidden();
}

/**
 * The deployment history inside an expanded row, as a list of its entries.
 *
 * Named by its own heading rather than by position: the panel holds a metrics `<dl>` and a
 * log pane too, and `getByRole("list")` would pick whichever came first.
 */
export function deploymentHistory(page: Page, name: string) {
  return onlyVisible(
    row(page, name).getByRole("list", {
      name: new RegExp(`Earlier deployments of ${name}`),
    }),
  );
}

/**
 * Rolls a container back to one entry of its history, from the trigger to the confirmation.
 *
 * Separate from `runRowAction` rather than a fourth member of its union, because the control
 * is not in the row's action cluster: there is one per eligible deployment, inside the
 * expanded panel, so a caller has to say *which* — and the trigger reads "Roll back" on every
 * one of them. `index` is into the visible history, newest first, so 1 is the entry directly
 * before the one running.
 *
 * The panel has to be open already; expanding is what starts the read this depends on.
 */
export async function rollBackTo(page: Page, name: string, index: number) {
  const entries = deploymentHistory(page, name).getByRole("listitem");
  const trigger = entries.nth(index).getByRole("button", { name: /^Roll back/ });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = onlyVisible(page.getByRole("alertdialog"));
  const confirm = dialog.getByRole("button", { name: /^Roll back container$/i });
  await awaitDialogReady(dialog, confirm);

  await confirm.click();
  await expect(dialog).toBeHidden();
}

/**
 * Opens the provisioning tab, keeping whatever selection the URL already carries.
 *
 * Clicked rather than `page.goto("/dashboard/new")`, and that is deliberate: the strip
 * builds each href from the current query string, so clicking carries `?project=` and
 * `?environment=` across — a goto would drop them and land the spec on whatever project
 * the server defaults to. It also means every spec that creates a container exercises the
 * strip, which is where a broken href would otherwise go unnoticed.
 */
export async function openNewContainerTab(page: Page) {
  await onlyVisible(tabs(page).getByRole("link", { name: "New container" })).click();
  await page.waitForURL(/\/dashboard\/new(\?|$)/);
  await expect(button(page, /spin up container/i)).toBeVisible();
  await tabArrived(page, "New container");
}

/**
 * The dashboard's tab strip.
 *
 * Every tab helper goes through this rather than a page-wide `getByRole("link")`, because
 * the page can hold a link with the same words: the empty-environment card offers its own
 * way to the provisioning tab. Scoping to the landmark is what keeps these helpers from
 * failing strict mode in exactly the state a spec is most likely to be checking.
 */
const tabs = (page: Page) =>
  page.getByRole("navigation", { name: "Dashboard sections" });

/**
 * Waits until a tab navigation has actually finished, title and all.
 *
 * The heading each helper waits for proves the new route rendered; it does not prove the
 * document is done changing. Next swaps `<head>` metadata separately from the tree, so for
 * a moment after a client-side navigation the document has NO `<title>` — and axe reports
 * that as a `document-title` violation, which is how e2e/a11y.spec.ts found this. It is
 * transient and framework-level rather than anything these routes declare, but a scan that
 * lands inside the window is a real failure with a confusing name.
 *
 * An assertion on real content with Playwright's own retry, not a sleep: it settles the
 * instant the title lands.
 */
async function tabArrived(page: Page, heading: string) {
  await expect(onlyVisible(page.getByRole("heading", { name: heading }))).toBeVisible();
  await expect(page).toHaveTitle(/\S/);
}

/** Opens the billing tab, keeping the selection, for the reason openNewContainerTab gives. */
export async function openBillingTab(page: Page) {
  await onlyVisible(tabs(page).getByRole("link", { name: "Billing" })).click();
  await page.waitForURL(/\/dashboard\/billing(\?|$)/);
  await tabArrived(page, "Workspace spend");
}

/** Back to the container list, from wherever a spec has navigated to. */
export async function openContainersTab(page: Page) {
  await onlyVisible(tabs(page).getByRole("link", { name: "Containers" })).click();
  await page.waitForURL(/\/dashboard(\?|$)/);
  await settled(page);
  await expect(page).toHaveTitle(/\S/);
}

/**
 * Picks one image from the preset catalog and waits for the list to actually close.
 *
 * The wait is not tidiness: the listbox animates out, so reopening it while the previous
 * one is still leaving resolves the option locator against a node that is detached a frame
 * later — a stale element rather than a slow one, which no timeout makes deterministic. It
 * is also portalled and overlaps the submit button, so leaving it open makes the next click
 * land on the list.
 */
export async function pickPreset(page: Page, name: RegExp) {
  await onlyVisible(page.getByRole("button", { name: /show preset images/i })).click();
  await onlyVisible(page.getByRole("option", { name })).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/**
 * Submits the form for a create that is expected NOT to succeed, and stays on the form.
 *
 * The counterpart to `spinUp`, and the split is forced by what the app does rather than by
 * taste: a success hands over to the container tab, and a refusal stays here and renders
 * the reason — inline beside the field that caused it, or as a toast. So a spec about a
 * refusal cannot go through the helper that waits for the hop, and one that tried would
 * fail on a navigation that is correctly not happening.
 *
 * Settles on the button coming back to its idle label, which is the form saying the
 * submission is over. That is the same signal `settled` used to carry for the whole page,
 * and it belongs here now that it only describes this one route.
 */
export async function submitFailing(page: Page, name: string, preset?: RegExp) {
  await openNewContainerTab(page);
  if (preset) await pickPreset(page, preset);
  await field(page, "Name").fill(name);
  await button(page, /spin up container/i).click();
  await expect(button(page, /spin up container/i)).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
}

/**
 * Opens the provisioning tab, picks a preset, submits, and follows the hop back.
 *
 * The tab hop at each end is what keeps ~60 call sites unchanged after the dashboard split:
 * they all began on /dashboard and expect to be back there with the new row present, which
 * is exactly what the form now does on success.
 *
 * **Only for a create that succeeds.** See `submitFailing` above for why the two cannot be
 * one helper.
 */
export async function spinUp(
  page: Page,
  name: string,
  preset = "Redis",
  /**
   * Extra environment rows to add before submitting.
   *
   * Optional so every existing caller stays as it is — which is only possible because the
   * editor posts two native repeated fields rather than something a helper would have to
   * serialise.
   */
  variables: Record<string, string> = {},
) {
  await openNewContainerTab(page);
  await pickPreset(page, new RegExp(`^${preset}`));
  await field(page, "Name").fill(name);
  for (const [key, value] of Object.entries(variables)) {
    await addVariable(page, key, value);
  }
  await button(page, /spin up container/i).click();

  /*
   * The form pushes to /dashboard on success, so the caller is back where it started with
   * the new row on screen. Waited on here rather than in every call site — and this is the
   * signal that replaced `settled`'s old wait on the submit button, since the destination
   * render is the thing the caller is about to assert against.
   *
   * A failed submission stays on this tab and renders its error inline, so a spec covering
   * that path drives the form itself rather than calling this.
   */
  await page.waitForURL(/\/dashboard(\?|$)/);
  await settled(page);
}

/**
 * Appends one environment row and fills both of its cells.
 *
 * `scope` exists because there can now be two editors on the page at once: the spin-up
 * form's, and the one inside an open edit dialog. Row positions restart at 1 per editor, so
 * a page-wide count returns the total across both and names a cell that exists in neither —
 * which is a strict-mode-clean lookup for a label nothing carries, and therefore a timeout
 * rather than an error that says what happened. Defaulted so every existing caller, all of
 * which run with no dialog open, stays as it is.
 */
export async function addVariable(
  page: Page,
  name: string,
  value: string,
  scope: Locator | Page = page,
) {
  await onlyVisible(scope.getByRole("button", { name: /add variable/i })).click();
  // The new row is the last one, and its cells are labelled by that position.
  const position = await scope.getByLabel(/^Variable name \d+$/).count();
  await scope.getByLabel(`Variable name ${position}`).fill(name);
  await scope.getByLabel(`Variable value ${position}`).fill(value);
}

/**
 * Opens a row's detail dialog and waits until it is actually usable.
 *
 * `pointer-events: auto` is the layer gate the destroy and lifecycle helpers use for the
 * same reason — Radix hands a dialog its layer one render after it appears, and a click or
 * an Escape that lands before that is swallowed.
 */
export async function openDetailDialog(page: Page, name: string) {
  await onlyVisible(row(page, name).getByRole("button", { name: /^Details$/ })).click();

  const dialog = onlyVisible(page.getByRole("dialog"));
  return awaitDialogReady(dialog);
}

/**
 * Opens a row's detail dialog, switches it into edit mode, and waits for the variables.
 *
 * Two waits, not one. The form's shell paints immediately; the environment editor appears
 * only once `/api/service-variables` answers, so a spec that acted on the shell would race
 * a fetch and fill a form that is about to re-render. Waiting for the legend is the signal
 * that both halves are mounted.
 *
 * Edit is a mode of the detail view now rather than a dialog of its own — see
 * container-detail-dialog.tsx — so this is two clicks where it used to be one. The extra
 * hop is not a wait: the switch is local state, and the fetch it starts is what the legend
 * below is already gating on.
 */
export async function openEditDialog(page: Page, name: string) {
  const dialog = await openDetailDialog(page, name);
  await onlyVisible(dialog.getByRole("button", { name: /^Edit$/ })).click();
  await expect(dialog.getByText("Environment variables")).toBeVisible();
  return dialog;
}

/**
 * Creates a service behind the app's back, as Railway's own dashboard would.
 *
 * The only way to produce the case the project watcher exists for: driving this app's
 * own form would be the app noticing a change it made itself.
 */
export async function createServiceOutOfBand(page: Page, name: string) {
  await page.request.post(`${FIXTURE_URL}/__test/services`, { data: { name } });
}

/**
 * Drives `document.visibilityState`, which is what gates the project watcher.
 *
 * Two uses, and the second is not obvious. A hidden tab holds no watch connection and
 * makes no Railway requests — that is the property watch.spec.ts asserts, and it is also
 * the only way a spec can hold the *counted* faults (`rateLimit`, `unauthorized`) for
 * itself. Those come off one queue in the fixture, drained by whichever request arrives
 * first, and the watcher polls once a second: leave it running and it eats the 429s the
 * spec queued for a user action.
 */
export async function setTabVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      value,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/**
 * Seeds a batch of services in one request, optionally parked at a status.
 *
 * The default fixture holds a single service, which is the right size for every
 * lifecycle spec and far too small for a paged one. Seeded here rather than in
 * `store.reset()` so the rest of the suite keeps its cheap, one-row starting point.
 *
 * Names come back zero-padded — `web-00`, `web-01` — so a locator for one cannot also
 * match another that merely starts the same way.
 */
export async function seedServices(
  page: Page,
  options: {
    name: string;
    count?: number;
    status?: string;
    /** Seeds a service that already answers somewhere, so its row offers no second address. */
    domains?: string[];
  },
) {
  await page.request.post(`${FIXTURE_URL}/__test/services`, { data: options });
}

/** What the fixture holds for a service, which is more than any page renders. */
export type FixtureService = {
  name: string;
  image: string | null;
  variables: Record<string, string>;
  domains: string[];
  /**
   * The resource controls the spin-up applied.
   *
   * Nothing renders these back, so this is the only way a spec can tell a value that reached
   * Railway from one that only reached the form. All null means no `serviceInstanceUpdate`
   * and no `serviceInstanceLimitsUpdate` was sent at all, which is the round-trip guarantee
   * the common case depends on.
   */
  settings: {
    region: string | null;
    replicas: number | null;
    restartPolicy: string | null;
    restartRetries: number | null;
    startCommand: string | null;
    vcpus: number | null;
    memoryGB: number | null;
  };
};

/** Service records from the fixture, including the environment each was created with. */
export async function fixtureServices(page: Page): Promise<FixtureService[]> {
  const response = await page.request.get(`${FIXTURE_URL}/__test/services`);
  return response.json() as Promise<FixtureService[]>;
}

/**
 * Opens a create dialog the way the picker offers it: from inside the dropdown it adds to.
 *
 * The `pointer-events` gate is the same one `dismissWithEscape` documents, and here it
 * carries a second meaning. A Select popup and a Dialog are both modal layers; the dialog
 * only becomes actionable once the select's layer has finished releasing the body. Waiting
 * on it is therefore the proof that the two did not overlap, not merely a settle.
 */
export async function openCreateFromSelect(
  page: Page,
  label: string,
  row: RegExp,
): Promise<Locator> {
  await onlyVisible(page.getByRole("combobox", { name: label })).click();
  await onlyVisible(page.getByRole("option", { name: row })).click();

  const dialog = onlyVisible(page.getByRole("dialog"));
  return awaitDialogReady(dialog);
}

/**
 * Picks one row of a Select, by the label on the control and the text on the row.
 *
 * Not `selectOption`, which only drives a real `<select>`: every dropdown in the app is
 * Radix now, so a row is a portalled `role="option"` that exists only while the popup is
 * open — and it is addressable by its visible label rather than by the value it posts.
 *
 * The listbox count is the gate on the way out, and it is not optional. A Select popup is
 * a modal layer: while it is up, `body` carries `pointer-events: none`, so the next
 * `.fill()` on the panel behind it would sit unactionable until it timed out. That matters
 * most for the select inside the create dialog, where the layer being torn down sits on
 * top of another one.
 */
export async function chooseOption(page: Page, label: string, option: string | RegExp) {
  await onlyVisible(page.getByRole("combobox", { name: label })).click();
  await onlyVisible(page.getByRole("option", { name: option })).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/**
 * Opens the spin-up form's Advanced panel and fills whichever controls were named.
 *
 * Dropdowns and text fields in the same helper because the panel mixes them and a caller
 * should not have to know which is which. Leaves the panel OPEN: closing it is a behaviour
 * one spec asserts deliberately rather than something every caller should pay for.
 *
 * `region` and `restartPolicy` name the row's VISIBLE LABEL, not the value it submits —
 * "US West (Oregon)" rather than "us-west2". That is what a Radix option can be addressed
 * by; the value is still what the assertion on the fixture record checks.
 */
export async function fillAdvanced(
  page: Page,
  values: Partial<{
    region: string;
    replicas: string;
    cpu: string;
    memory: string;
    restartPolicy: string;
    restartRetries: string;
    startCommand: string;
  }>,
) {
  const summary = page.getByText("Advanced settings");
  if ((await page.locator("details[open]").count()) === 0) await summary.click();

  if (values.region !== undefined) {
    await chooseOption(page, "Region", values.region);
  }
  if (values.restartPolicy !== undefined) {
    await chooseOption(page, "Restart policy", values.restartPolicy);
  }
  const typed: Array<[string, string | undefined]> = [
    ["Replicas", values.replicas],
    ["vCPU", values.cpu],
    ["Memory (GB)", values.memory],
    ["Retries", values.restartRetries],
    ["Start command", values.startCommand],
  ];
  for (const [label, value] of typed) {
    if (value !== undefined) await page.getByLabel(label, { exact: true }).fill(value);
  }
}

/**
 * WCAG 2.1 AA, scoped to the tags a reviewer would actually hold this to.
 *
 * Axe cannot see focus traps, tab order, or whether a live region is announced at a
 * sensible politeness — e2e/keyboard.spec.ts covers those separately.
 */
export async function expectNoA11yViolations(
  page: Page,
  context?: string,
  /**
   * Restricts the scan to one subtree.
   *
   * For a state where something OUTSIDE the thing under test is what a rule fires on — see
   * the open-dropdown scan in a11y.spec.ts, which is scoped for a reason worth reading
   * there. Whole-page by default, and it should stay the default: a scan that names its
   * own boundary is a scan that can be narrowed until it asserts nothing.
   */
  within?: string,
) {
  /*
   * Axe reads computed colours, so a scan taken mid-transition measures a blend of the
   * old and new values and reports contrast failures that never appear on screen.
   * Reduced motion collapses the app's transitions (see globals.css), and waiting on
   * getAnimations() covers anything still in flight — deterministically, without a sleep.
   */
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );

  /*
   * Two scans, because the WCAG tags do not cover document structure.
   *
   * `page-has-heading-one`, `heading-order` and `bypass` are all tagged best-practice
   * in axe, so a wcag-only scan reported nothing while /dashboard had no h1 at all and
   * no page had a skip link. Four rules are named rather than adding the whole
   * best-practice tag: that pulls in `region`, `landmark-unique` and others whose
   * fallout is unbounded and unrelated to the defect being fixed. Widening further is a
   * deliberate act, one rule at a time.
   */
  // Sequential, not Promise.all: axe-core injects one instance per frame and refuses a
  // second concurrent run outright ("Axe is already running").
  const scoped = <T extends AxeBuilder>(builder: T) =>
    within ? builder.include(within) : builder;

  const wcag = await scoped(
    new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]),
  ).analyze();
  /*
   * Document structure is a property of the page, so it is never scoped: asking whether a
   * portalled listbox has an h1 is a question with no useful answer either way.
   */
  const structure = within
    ? { violations: [] }
    : await new AxeBuilder({ page })
        .withRules([
          "page-has-heading-one",
          "heading-order",
          "landmark-one-main",
          "bypass",
        ])
        .analyze();

  const results = { violations: [...wcag.violations, ...structure.violations] };

  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => ({
      target: n.target.join(" "),
      // The measured values, so a contrast failure names the two colours rather
      // than leaving you to guess which token is at fault.
      why: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 240),
    })),
  }));

  expect(summary, `axe violations${context ? ` (${context})` : ""}`).toEqual([]);
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
    window.localStorage.setItem("theme", value);
  }, theme);
}
