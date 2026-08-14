import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { LogPhaseFault, ProjectsSource } from "./fixtures/fake-railway/store";

const FIXTURE_URL = `http://localhost:${process.env.FAKE_RAILWAY_PORT ?? 4010}`;

/** Every spec starts from a known fixture state; workers:1 makes this safe. */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.request.post(`${FIXTURE_URL}/__test/reset`);
    await use(page);
  },
});

export { expect };

export async function injectFaults(
  page: Page,
  faults: Partial<{
    rateLimit: number;
    unauthorized: number;
    refreshFails: boolean;
    accessTokenTtl: number;
    deploymentsFail: boolean;
    logPhase: LogPhaseFault;
    variablesFail: boolean;
    projectsSource: ProjectsSource;
    rejectWorkspaces: boolean;
    rejectPersonal: boolean;
    slowMs: number;
  }>,
) {
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
  return onlyVisible(row(page, name).getByRole("link", { name }));
}

/**
 * Waits for a re-render to finish.
 *
 * A Server Action followed by router.refresh() streams a fresh tree the same way the
 * initial load does, so the container list momentarily exists twice. Asserting on the
 * count retries until exactly one remains — no fixed sleep, and it fails loudly if the
 * page genuinely renders two lists.
 *
 * The count alone was not enough. `spin-up-form` starts its refresh inside a
 * `useTransition`, and a transition commits the *whole* new tree at once — so the list
 * can read as settled while the refresh is still in flight, and the commit then
 * reconciles the rows out from under whatever the test does next. The form marks its own
 * button busy for exactly that window, so waiting on it closes the race at the signal
 * rather than by sleeping past it.
 *
 * This was also once blamed for a dialog swallowing an Escape. It was not the cause —
 * see dismissWithEscape below, which is — and both waits are kept because they close
 * different windows.
 */
export async function settled(page: Page) {
  await expect(containerList(page)).toHaveCount(1);
  await expect(button(page, /spin up container/i)).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
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
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/to confirm/i)).toBeVisible();
  await expect(dialog).toHaveCSS("pointer-events", "auto");
  return dialog;
}

/**
 * Picks a preset and submits.
 *
 * The image control is one editable combobox now, so this opens the list, picks, and
 * lets it close itself. It MUST leave the popup closed: the listbox is portalled and
 * overlaps the submit button, so a spec that leaves it open clicks the list instead.
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
  await onlyVisible(page.getByRole("button", { name: /show preset images/i })).click();
  await onlyVisible(
    page.getByRole("option", { name: new RegExp(`^${preset}`) }),
  ).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await field(page, "Name").fill(name);
  for (const [key, value] of Object.entries(variables)) {
    await addVariable(page, key, value);
  }
  await button(page, /spin up container/i).click();
}

/** Appends one environment row and fills both of its cells. */
export async function addVariable(page: Page, name: string, value: string) {
  await button(page, /add variable/i).click();
  // The new row is the last one, and its cells are labelled by that position.
  const position = await page.getByLabel(/^Variable name \d+$/).count();
  await page.getByLabel(`Variable name ${position}`).fill(name);
  await page.getByLabel(`Variable value ${position}`).fill(value);
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
  options: { name: string; count?: number; status?: string },
) {
  await page.request.post(`${FIXTURE_URL}/__test/services`, { data: options });
}

/** Service records from the fixture, including the environment each was created with. */
export async function fixtureServices(
  page: Page,
): Promise<
  Array<{ name: string; image: string | null; variables: Record<string, string> }>
> {
  const response = await page.request.get(`${FIXTURE_URL}/__test/services`);
  return response.json() as Promise<
    Array<{ name: string; image: string | null; variables: Record<string, string> }>
  >;
}

/**
 * WCAG 2.1 AA, scoped to the tags a reviewer would actually hold this to.
 *
 * Axe cannot see focus traps, tab order, or whether a live region is announced at a
 * sensible politeness — e2e/keyboard.spec.ts covers those separately.
 */
export async function expectNoA11yViolations(page: Page, context?: string) {
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
  const wcag = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const structure = await new AxeBuilder({ page })
    .withRules(["page-has-heading-one", "heading-order", "landmark-one-main", "bypass"])
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
