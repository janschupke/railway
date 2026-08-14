import {
  addVariable,
  button,
  disclosure,
  expect,
  field,
  fixtureServices,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  railwayLink,
  row,
  seedServices,
  setTabVisibility,
  settled,
  signIn,
  spinUp,
  test,
  toast,
} from "./support";
import { FAILURE_TEXT } from "./fixtures/fake-railway/store";

test.describe("container lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("spins a container up and follows it to Running", async ({ page }) => {
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await expect(cache).toBeVisible();
    // The fixture advances QUEUED → BUILDING → DEPLOYING → SUCCESS on a timer, so
    // this is a real transition sequence rather than a fixed snapshot.
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
  });

  test("streams log output into the expanded panel", async ({ page }) => {
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();

    const log = cache.getByRole("log");
    await expect(log).toBeVisible();
    await expect(log).toContainText("[fake-railway]", { timeout: 20_000 });
  });

  test("downloads the buffered lines as a file named after the container", async ({
    page,
  }) => {
    /*
     * The object-URL dance is the part a component test cannot prove: jsdom has no
     * download at all, so the anchor, the blob and the revoke-on-the-next-task are only
     * ever asserted as calls. Here the browser actually produces a file.
     *
     * The clipboard deliberately has no equivalent spec — reading it needs
     * clipboard-read granted on a context this config shares across every test, and for
     * chromium only. The success toast is what proves that path.
     */
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();
    await expect(cache.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });

    const download = page.waitForEvent("download");
    await cache.getByRole("button", { name: "Download these lines" }).click();

    expect((await download).suggestedFilename()).toMatch(/^cache-logs-.+\.txt$/);
  });

  test("narrows the log pane to the severities the stream actually sent", async ({
    page,
  }) => {
    // The control is built from what arrived rather than a vocabulary this app invented,
    // so this is also the assertion that severity survives query, subscription, SSE route
    // and hook without anything dropping it.
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();
    await expect(cache.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });

    // A toolbar, not a group: ToggleGroup implements roving focus, so it claims the role
    // that promises arrow-key navigation — which is why the strip around it does not.
    const severity = cache.getByRole("toolbar", { name: "Severity" });
    await expect(severity.getByRole("button", { name: "info" })).toBeVisible();
  });

  test("says a finished deployment had no output, instead of connecting forever", async ({
    page,
  }) => {
    /*
     * The seeded postgres service is SUCCESS with zero log lines — a deployment that
     * finished before anyone attached. The pane knew only connected/not-connected, and
     * `done` set connected to false, so this rendered "Connecting…" permanently: HTTP
     * 200, stream closed cleanly, nothing in the console, nothing failed in the network
     * panel, and a spinner that resolved to nothing.
     */
    const postgres = row(page, "postgres");
    await disclosure(page, "postgres").click();

    const log = postgres.getByRole("log");
    await expect(log).toContainText("No log output for this deployment.");
    await expect(log).not.toContainText("Connecting…");
  });

  test("shows the image and strips the ownership prefix from the name", async ({
    page,
  }) => {
    await spinUp(page, "cache", "Nginx");

    const cache = row(page, "cache");
    await expect(cache).toContainText("nginx:alpine");
    // Displayed as "cache"; stored in Railway as "spun-cache".
    await expect(cache).not.toContainText("spun-cache");
  });

  test("points every container at its own page on Railway", async ({ page }) => {
    /*
     * Not only the failed ones. The app shows a status and a log stream; everything else
     * a service has — variables, domains, metrics, the deploy history — lives on Railway,
     * and the name is the obvious thing to click to get there.
     */
    await spinUp(page, "cache");

    await expect(railwayLink(page, "cache")).toHaveAttribute(
      "href",
      /railway\.com\/project\/proj_demo\/service\/svc_\d+\?environmentId=env_prod/,
    );
    await expect(railwayLink(page, "cache")).toHaveAttribute("rel", "noreferrer");
    await expect(railwayLink(page, "cache")).toHaveAttribute("target", "_blank");
  });

  test("destroys a container after typed confirmation", async ({ page }) => {
    await spinUp(page, "cache");
    const cache = row(page, "cache");
    await expect(cache).toBeVisible();

    const dialog = await openDestroyDialog(page, "cache");
    await expect(dialog).toContainText("Destroy cache?");

    const confirm = dialog.getByRole("button", { name: /destroy permanently/i });
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(/type .cache. to confirm/i).fill("cache");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(toast(page, "Destroyed cache")).toBeVisible();
    await expect(row(page, "cache")).toHaveCount(0);
  });

  test("offers no destroy control for a service it did not create", async ({
    page,
  }) => {
    /*
     * The UI half of the ownership rule, and only that half — this asserts the control
     * is absent, not that the server would refuse a request made without it. The
     * refusal itself is proven in actions.integration.test.ts, which asserts zero
     * ServiceDelete calls for a forged serviceId.
     *
     * The fixture seeds `postgres`, which carries no ownership prefix.
     */
    const postgres = row(page, "postgres");
    await expect(postgres).toBeVisible();

    await expect(
      onlyVisible(postgres.getByRole("button", { name: /^destroy$/i })),
    ).toHaveCount(0);

    // The slot is not left dead: what a reader wants from a row this app cannot destroy
    // is Railway's own page for it, and that is what the action column offers instead.
    const open = onlyVisible(postgres.getByRole("link", { name: "Open in Railway" }));
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("href", /railway\.com\/project\/.+\/service\//);
  });

  test("rejects a duplicate name at the field that caused it", async ({ page }) => {
    await spinUp(page, "cache");
    await expect(row(page, "cache")).toBeVisible();

    await spinUp(page, "cache");

    await expect(onlyVisible(page.getByText(/already exists here/))).toBeVisible();
    await expect(field(page, "Name")).toHaveAttribute("aria-invalid", "true");
  });

  test("rejects a malformed image reference before submitting", async ({ page }) => {
    /*
     * Typed, not picked — the whole reason the image control stays free text. The value
     * has to reach the server so the server's own rule stays the single definition of
     * what is valid; a dropdown that could only emit known-good values would make this
     * case unreachable and the validation untested.
     */
    await field(page, "Image reference").fill("redis; rm -rf /");
    // The portalled list covers the submit button while it is open.
    await page.keyboard.press("Escape");
    await field(page, "Name").fill("bad");
    await button(page, /spin up container/i).click();

    await expect(
      onlyVisible(page.getByText(/does not look like a valid image reference/)),
    ).toBeVisible();
    await expect(field(page, "Image reference")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("gives a database the credentials it needs, without showing them", async ({
    page,
  }) => {
    /*
     * The default a user does not have to think about. `postgres` exits on its first tick
     * without POSTGRES_PASSWORD and Railway restarts it forever, so a preset offering it
     * without one would show a crash loop and read as a bug in this app. The form now
     * seeds that row and leaves its value blank, which is what asks the server to mint.
     *
     * Both halves matter: the credential reaches Railway, and it never reaches the page.
     * The user reads it on Railway's own Variables page, which is where every other
     * Railway secret lives — this app stores nothing.
     *
     * The last assertion is also a design tripwire. Implement the generated default by
     * prefilling a client-visible value rather than a placeholder attribute and this test
     * fails, which is exactly the review it should perform.
     */
    await spinUp(page, "db", "PostgreSQL");
    await expect(row(page, "db")).toBeVisible();

    const services = await fixtureServices(page);
    const created = services.find((service) => service.name === "spun-db")!;

    expect(Object.keys(created.variables)).toEqual(["POSTGRES_PASSWORD"]);
    const password = created.variables.POSTGRES_PASSWORD!;
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(await page.content()).not.toContain(password);
  });

  test("sets the variables the user typed", async ({ page }) => {
    await spinUp(page, "app", "Nginx", { GREETING: "hello", MODE: "test" });
    await expect(row(page, "app")).toBeVisible();

    const services = await fixtureServices(page);
    const created = services.find((service) => service.name === "spun-app")!;

    expect(created.variables).toEqual({ GREETING: "hello", MODE: "test" });
  });

  test("lets the user supply a database password instead of a generated one", async ({
    page,
  }) => {
    /*
     * The honest counterpart to the assertion above. The boundary this app holds is "it
     * does not reveal what it generated", not "a password never appears on screen" — a
     * value the user typed is theirs, and hiding it would be theatre.
     *
     * This is also what makes not showing generated credentials cost nothing: anyone who
     * needs a password they can keep types one here.
     */
    await onlyVisible(
      page.getByRole("button", { name: /show preset images/i }),
    ).click();
    await onlyVisible(page.getByRole("option", { name: /^PostgreSQL/ })).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await field(page, "Name").fill("db");
    await page.getByLabel("Variable value 1").fill("hunter2hunter2");

    /*
     * Asserted before submitting, and on the control's value rather than on page.content().
     * Two reasons, both worth writing down: a success clears the user's rows and re-seeds
     * the image's own, so nothing typed survives to be found afterwards; and a controlled
     * input's value is a DOM property that never appears in the serialised HTML at all.
     */
    await expect(page.getByLabel("Variable value 1")).toHaveValue("hunter2hunter2");

    await button(page, /spin up container/i).click();

    await expect(row(page, "db")).toBeVisible();
    const services = await fixtureServices(page);
    const created = services.find((service) => service.name === "spun-db")!;

    expect(created.variables).toEqual({ POSTGRES_PASSWORD: "hunter2hunter2" });
    // And the row is back to the catalog's blank default, ready for the next container.
    await expect(page.getByLabel("Variable value 1")).toHaveValue("");
  });

  test("refuses a name Railway owns, at the row that caused it", async ({ page }) => {
    await onlyVisible(
      page.getByRole("button", { name: /show preset images/i }),
    ).click();
    await onlyVisible(page.getByRole("option", { name: /^Nginx/ })).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await field(page, "Name").fill("app");
    await addVariable(page, "RAILWAY_TOKEN", "x");
    await button(page, /spin up container/i).click();

    await expect(onlyVisible(page.getByText(/set by Railway itself/))).toBeVisible();
    await expect(page.getByLabel("Variable name 1")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // Nothing was created: a refused row must not leave a service behind.
    const services = await fixtureServices(page);
    expect(services.find((service) => service.name === "spun-app")).toBeUndefined();
  });

  test("says a service was created when only its environment failed", async ({
    page,
  }) => {
    /*
     * Deliberately not deployed: the service exists, is prefixed and is destroyable, and
     * that is strictly better than a running container in a restart loop nobody can
     * diagnose. Reporting a bare failure would leave the user hunting for something they
     * were never told had been created.
     */
    await injectFaults(page, { variablesFail: true });

    await spinUp(page, "db", "PostgreSQL");

    await expect(toast(page, /Created db/)).toBeVisible();
  });

  test("settles a failed build into Failed rather than spinning forever", async ({
    page,
  }) => {
    await injectFaults(page, { deploymentsFail: true });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });
  });

  test("reads the other log phase when a failure showed nothing", async ({ page }) => {
    /*
     * The row picks its log phase from the status it can see, and a failed deployment is
     * sent to deploy logs — so a build-phase failure on a row that was *already* failed
     * when the page rendered asked Railway for the half of the output that is empty and
     * reported "No log output for this deployment." The reload below is what creates that
     * row: without it the stream follows the deployment through BUILDING and the wrong
     * phase is never chosen.
     */
    await injectFaults(page, { deploymentsFail: true, logPhase: "build" });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await settled(page);

    const reloaded = row(page, "broken");
    await disclosure(page, "broken").click();
    await expect(reloaded.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });
  });

  test("points a failure with no output at all towards Railway", async ({ page }) => {
    /*
     * The genuine image-pull shape: no build, no deploy logs, and an API that answers
     * with the enum FAILED and nothing else. The pane is legitimately empty — what must
     * not be empty is the route to the reason, which only Railway's own page has.
     */
    await injectFaults(page, { deploymentsFail: true, logPhase: "none" });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });

    await disclosure(page, "broken").click();

    await expect(broken.getByRole("log")).toContainText(
      "No log output for this deployment.",
    );
    await expect(
      broken.getByRole("link", { name: /open in railway/i }),
    ).toHaveAttribute(
      "href",
      /railway\.com\/project\/proj_demo\/service\/svc_\d+\?environmentId=env_prod/,
    );
  });

  test("names the step and the reason Railway gave for a failure", async ({ page }) => {
    /*
     * The pane is legitimately empty here — no build, no deploy logs — so the reason has
     * nothing else on screen carrying it. That is the case the ticket opens with: a red
     * badge over an empty pane whose only route to an explanation was a link out.
     */
    await injectFaults(page, { deploymentsFail: true, logPhase: "none" });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });

    await disclosure(page, "broken").click();

    const alert = broken.getByRole("alert");
    await expect(alert).toContainText("failed at the build image step", {
      timeout: 20_000,
    });
    await expect(alert).toContainText(FAILURE_TEXT);
    // One bounded line is not Railway's page, so the link stays whatever else is shown.
    await expect(alert.getByRole("link", { name: /open in railway/i })).toBeVisible();
  });

  for (const failureField of ["reason", "detail"] as const) {
    test(`reads the reason off payload.${failureField} too`, async ({ page }) => {
      /*
       * Which member Railway populates has never been observed on a real failed
       * deployment — only introspected — so the app tries error, then reason, then
       * detail. These two specs are the only mechanical evidence that the other branches
       * work; `pnpm probe:deployment` against a real failure settles which one is real.
       */
      await injectFaults(page, {
        deploymentsFail: true,
        logPhase: "none",
        failureField,
      });

      await spinUp(page, "broken");

      const broken = row(page, "broken");
      await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });

      await disclosure(page, "broken").click();

      await expect(broken.getByRole("alert")).toContainText(FAILURE_TEXT, {
        timeout: 20_000,
      });
    });
  }

  test("still points at Railway when the event feed is refused too", async ({
    page,
  }) => {
    /*
     * The degradation is silent by design: the user is already reading one failure, and a
     * banner saying the app could not explain it is worse than the sentence it falls back
     * to. The absence assertions are the point of this spec — a version that only checked
     * the happy path would not notice the day this starts shouting.
     */
    await injectFaults(page, {
      deploymentsFail: true,
      logPhase: "none",
      deploymentEventsFail: true,
    });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });

    await disclosure(page, "broken").click();

    const alert = broken.getByRole("alert");
    await expect(alert).toContainText("Its API returns the status and nothing else", {
      timeout: 20_000,
    });
    await expect(alert.getByRole("link", { name: /open in railway/i })).toBeVisible();
    await expect(broken.getByText(FAILURE_TEXT)).toHaveCount(0);
    // No second thing on screen: the failed block is the only alert in this row.
    await expect(alert).toHaveCount(1);
  });

  test("surfaces a Railway rate limit instead of failing silently", async ({
    page,
  }) => {
    /*
     * The watcher polls once a second in this suite and draws from the same fault queue,
     * so it would spend the 429s before the button is ever pressed. Hiding the tab closes
     * that connection — the app's own documented behaviour, asserted in watch.spec.ts —
     * which leaves the queued faults for the request this spec is actually about.
     */
    await setTabVisibility(page, "hidden");

    // Three attempts are made per request, so four queued 429s outlast the retries.
    await injectFaults(page, { rateLimit: 4 });

    await spinUp(page, "cache");

    await expect(toast(page, /rate limit/i)).toBeVisible();
  });

  test("switches project and environment through the URL", async ({ page }) => {
    await onlyVisible(page.getByRole("combobox", { name: "Environment" })).click();
    await onlyVisible(page.getByRole("option", { name: "staging" })).click();

    await expect(page).toHaveURL(/environment=env_staging/);
    // postgres lives in production only.
    await expect(row(page, "postgres")).toHaveCount(0);

    await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
    await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();

    await expect(page).toHaveURL(/project=proj_other/);
    await expect(page).not.toHaveURL(/environment=/);
  });

  test("keeps the selection across a reload", async ({ page }) => {
    await onlyVisible(page.getByRole("combobox", { name: "Environment" })).click();
    await onlyVisible(page.getByRole("option", { name: "staging" })).click();
    await expect(page).toHaveURL(/environment=env_staging/);

    await page.reload();

    await expect(
      onlyVisible(page.getByRole("combobox", { name: "Environment" })),
    ).toContainText("staging");
  });

  test("shows an empty state rather than a blank panel", async ({ page }) => {
    await onlyVisible(page.getByRole("combobox", { name: "Environment" })).click();
    await onlyVisible(page.getByRole("option", { name: "staging" })).click();

    await expect(
      onlyVisible(page.getByText("Nothing running in this environment")),
    ).toBeVisible();
    /*
     * And no count above it. The heading row used to carry "0 of no containers created
     * here" here — ICU resolving a zero branch that replaced the count and left the
     * sentence built around it — directly on top of the empty state that says this.
     */
    await expect(onlyVisible(page.getByText(/\d+ of /))).toHaveCount(0);
  });
});

/**
 * The two refusals a user can act on, neither of which had a spec.
 *
 * Both were asserted server-side or in a component test, which proves the response is
 * right and says nothing about whether the person ever sees it — and in both cases the
 * whole point of the design is that a refusal explains itself instead of presenting as
 * silence.
 */
test.describe("refusals the user is told about", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("names the open-panel limit rather than leaving a pane connecting", async ({
    page,
  }) => {
    /*
     * STREAM.MAX_CONCURRENT_PER_USER is 4, and the number is not arbitrary: browsers
     * allow six connections per origin over HTTP/1.1, one goes to the project watcher
     * and one is reserved for navigation. A seventh EventSource does not fail — it
     * queues, silently, forever. That is the failure this message exists to replace,
     * and until now nothing checked that it reaches the screen.
     */
    /*
     * Exactly five, and transitioning, which is the only arrangement that reaches the
     * cap. Two other numbers do not work, and both took a run to find out:
     *
     * Settled rows release their slot almost immediately — the monitor sees a terminal
     * status and ends the stream — so expanding five of those never holds more than one
     * or two at once.
     *
     * Six transitioning rows overshoot the *browser's* limit instead of the server's.
     * Chrome allows six connections per origin over HTTP/1.1; the project watcher holds
     * one, so the sixth stream is queued by the browser and never reaches the server at
     * all. That is a pane stuck on "Connecting…", which is precisely the silent failure
     * MAX_CONCURRENT_PER_USER was lowered to 4 to avoid, and it would make this spec
     * assert the opposite of what it is for.
     *
     * Five transitioning rows attach without being expanded, all five requests are sent,
     * the server grants four and refuses the fifth.
     */
    await seedServices(page, { name: "spun-svc", count: 5, status: "BUILDING" });
    await page.reload();
    await settled(page);

    // Seeded as `spun-svc-N`, zero-indexed; rows render with the managed prefix stripped.
    const names = Array.from({ length: 5 }, (_, i) => `svc-${i}`);
    for (const name of names) await disclosure(page, name).click();

    /*
     * errors.streamLimit, the sentence the SERVER sends — not containers.streamUnavailable,
     * which is the row's fallback for a refusal that named nothing. Getting those two the
     * wrong way round is easy and the difference is the whole design: a 200 carrying a
     * named error exists precisely because a 429 reaches EventSource as an unlabelled
     * failure with no action attached to it.
     *
     * Which row loses the race is not fixed, so the assertion is that one of them says
     * so — as opposed to silence, which is what this message replaced.
     */
    await expect(
      onlyVisible(page.getByText(/too many log panels/i)).first(),
    ).toBeVisible();
  });

  test("raises a toast when Railway refuses the create outright", async ({ page }) => {
    /*
     * The non-field failure path in spin-up-form: a duplicate name and a malformed
     * image both attach to a field and are covered above, but a Railway refusal has no
     * field to attach to and surfaces as a toast. That branch had no e2e at all.
     */
    await injectFaults(page, { rateLimit: 20 });

    await field(page, "Image reference").fill("redis:7-alpine");
    await field(page, "Name").fill("doomed");
    await button(page, /spin up container/i).click();

    await expect(toast(page, /could not spin up/i)).toBeVisible();
    // And nothing was created behind the failure.
    await expect(row(page, "doomed")).toHaveCount(0);
  });
});
