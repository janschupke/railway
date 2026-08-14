import {
  addVariable,
  button,
  disclosure,
  dismissWithEscape,
  expect,
  field,
  fixtureServices,
  fixtureStats,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  openEditDialog,
  railwayLink,
  row,
  runRowAction,
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
    // Nginx rather than the default Redis: this case is about the typed guard, and Redis
    // keeps state since T-491 — so it would also be exercising the stored-data checkbox and
    // reporting a different sentence. The volume cases below own that.
    await spinUp(page, "cache", "Nginx");
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

  test("gives a stateful preset a volume, and says where its data lives", async ({
    page,
  }) => {
    /*
     * The whole of T-491 in one pass: a database spun up here used to accept data and lose
     * it the next time the container moved, with nothing in the UI saying so.
     */
    await spinUp(page, "db", "PostgreSQL");

    // Said before it is created, on the form, rather than discovered afterwards.
    await expect(
      page.getByText(/\/var\/lib\/postgresql\/data is kept on a volume/),
    ).toBeVisible();

    await disclosure(page, "db").click();
    await expect(
      row(page, "db").getByText("/var/lib/postgresql/data · 0 MB of 500 MB"),
    ).toBeVisible();
  });

  test("says nothing about a volume for an image that keeps nothing", async ({
    page,
  }) => {
    // The catalog has checked that nginx keeps nothing worth keeping, so it says so by
    // saying nothing — a warning here is noise that teaches people to skip the real one.
    await spinUp(page, "web", "Nginx");

    await disclosure(page, "web").click();
    await expect(row(page, "web").getByText("Volume")).toHaveCount(0);
  });

  test("takes the stored data with the container by default", async ({ page }) => {
    await spinUp(page, "db", "PostgreSQL");

    const dialog = await openDestroyDialog(page, "db");
    const box = dialog.getByRole("checkbox", { name: /stored data/i });
    await expect(box).toBeChecked();
    await expect(box).toHaveAccessibleName(/500 MB/);

    await dialog.getByLabel(/type .db. to confirm/i).fill("db");
    await dialog.getByRole("button", { name: /destroy permanently/i }).click();

    await expect(toast(page, "Destroyed db and its stored data")).toBeVisible();
    await expect(row(page, "db")).toHaveCount(0);
  });

  test("keeps the volume when the box is unchecked, and says it is still billed", async ({
    page,
  }) => {
    /*
     * The sentence is the assertion. A kept volume disappears from this UI along with its
     * row — the app lists containers, and an orphan volume is not one — so a destroy that
     * said only "Destroyed db" would be declining to mention a charge it caused.
     */
    await spinUp(page, "db", "PostgreSQL");

    const dialog = await openDestroyDialog(page, "db");
    await dialog.getByRole("checkbox", { name: /stored data/i }).uncheck();
    await dialog.getByLabel(/type .db. to confirm/i).fill("db");
    await dialog.getByRole("button", { name: /destroy permanently/i }).click();

    await expect(toast(page, /data volume was kept and is still billed/)).toBeVisible();
    await expect(row(page, "db")).toHaveCount(0);
  });

  test("refuses to deploy a database whose volume Railway would not give it", async ({
    page,
  }) => {
    /*
     * The one branch where not deploying is the feature. A postgres that came up here would
     * look healthy, accept writes and lose all of them — which is the defect being fixed, so
     * shipping it on this path would reintroduce it knowingly.
     */
    await injectFaults(page, { volumeCreateFail: true });
    await spinUp(page, "db", "PostgreSQL");

    await expect(toast(page, /refused the volume its data needs/)).toBeVisible();
    // The service exists and is destroyable, which is the point of not throwing it away.
    await expect(row(page, "db")).toBeVisible();
  });

  test("deletes nothing, and claims nothing, when it cannot see the volume", async ({
    page,
  }) => {
    /*
     * EnvironmentVolumes degrades rather than throwing, and the destroy stays correct
     * through it in two halves. Nothing is deleted — no checkbox is offered, so nothing is
     * posted — and the toast says only "Destroyed", because with the read refused this app
     * does not know a volume exists and must not claim one was kept.
     */
    await spinUp(page, "db", "PostgreSQL");
    await injectFaults(page, { volumesFail: true });
    await page.reload();

    const dialog = await openDestroyDialog(page, "db");
    await expect(dialog.getByRole("checkbox", { name: /stored data/i })).toHaveCount(0);

    await dialog.getByLabel(/type .db. to confirm/i).fill("db");
    await dialog.getByRole("button", { name: /destroy permanently/i }).click();

    await expect(toast(page, "Destroyed db")).toBeVisible();
    await expect(row(page, "db")).toHaveCount(0);
  });

  test("stops a running container and brings it back with Redeploy", async ({
    page,
  }) => {
    /*
     * The round trip the whole feature exists for, and the only place it can be proven end
     * to end: the controls a row offers are derived from a status that arrives over SSE,
     * so a component test can assert the derivation but never that the status the browser
     * actually receives drives it.
     *
     * Stopping settles the deployment at REMOVED in the fixture, which is what Railway's
     * own dashboard reports for a stopped deployment — and it is terminal in this app's
     * state machine, so the stream closes rather than polling for the duration ceiling.
     */
    await spinUp(page, "cache");
    const cache = row(page, "cache");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });

    await runRowAction(page, "cache", "Stop");

    await expect(toast(page, "Stopped cache")).toBeVisible();
    await expect(cache.getByText("Removed")).toBeVisible({ timeout: 20_000 });

    // The row survives the stop — that is the difference from Destroy — and the control it
    // now offers is the way back.
    await expect(
      onlyVisible(cache.getByRole("button", { name: /^stop$/i })),
    ).toHaveCount(0);

    await runRowAction(page, "cache", "Redeploy");

    await expect(toast(page, "Redeploying cache")).toBeVisible();
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
  });

  test("restarts a running container without leaving its log stream", async ({
    page,
  }) => {
    /*
     * Restart keeps the deployment id, which is what separates it from Redeploy — so the
     * panel the user already has open keeps filling rather than being stranded on a
     * deployment nobody is watching. Asserted through the pane rather than through the id,
     * because the id is not on screen and the output is what the person actually sees.
     */
    await spinUp(page, "cache");
    const cache = row(page, "cache");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });

    await disclosure(page, "cache").click();
    await expect(cache.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });

    await runRowAction(page, "cache", "Restart");

    await expect(toast(page, "Restarting cache")).toBeVisible();
    await expect(cache.getByRole("log")).toBeVisible();
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
  });

  test("confirms a reversible action without asking for the container name", async ({
    page,
  }) => {
    /*
     * The second confirm path, stated as the difference it is meant to be. Stopping is
     * reversible and carries a sentence and two buttons; destroying is not and still costs
     * a typed name. If these two dialogs ever converge, one of them is wrong.
     */
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    await onlyVisible(
      row(page, "cache").getByRole("button", { name: /^stop$/i }),
    ).click();

    const dialog = onlyVisible(page.getByRole("alertdialog"));
    await expect(dialog).toContainText("Stop cache?");
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /^stop container$/i }),
    ).toBeEnabled();

    await dismissWithEscape(page, dialog);
    await expect(dialog).toBeHidden();
    // Dismissed means nothing happened: the container is still running.
    await expect(row(page, "cache").getByText("Running")).toBeVisible();
  });

  test("offers no lifecycle controls for a service it did not create", async ({
    page,
  }) => {
    /*
     * The ownership rule covers every verb now, not just destroy, and this is its UI half.
     * The server half — that a forged serviceId reaches no mutation — is proven per verb in
     * actions.integration.test.ts.
     */
    const postgres = row(page, "postgres");
    await expect(postgres).toBeVisible();

    for (const action of [/^stop$/i, /^restart$/i, /^redeploy$/i]) {
      await expect(
        onlyVisible(postgres.getByRole("button", { name: action })),
      ).toHaveCount(0);
    }
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
    /*
     * Checked in the browser now, against the list this page already loaded — the action
     * used to re-read the whole project before every create to answer this, which is a
     * Railway round trip spent on a typo. Waiting for the row is what makes the check
     * sound here: it is proof the refreshed list has reached the form.
     */
    await spinUp(page, "cache");
    await expect(row(page, "cache")).toBeVisible();

    await spinUp(page, "cache");

    await expect(onlyVisible(page.getByText(/already exists here/))).toBeVisible();
    await expect(field(page, "Name")).toHaveAttribute("aria-invalid", "true");
  });

  test("creates one container when the form is submitted twice", async ({ page }) => {
    /*
     * The property the idempotency key exists for, and the only place it is observable
     * end to end. A slow fixture holds the first submission open; the second is posted
     * underneath it with the same key, and the key is what makes that harmless.
     *
     * `requestSubmit` rather than a second click: the submit button is inert while
     * pending, deliberately, so a click would be swallowed by the UI and this would pass
     * without exercising anything.
     */
    const before = (await fixtureStats(page)).operations.ServiceCreate ?? 0;
    await injectFaults(page, { slowMs: 1500 });

    await spinUp(page, "cache");
    await page.evaluate(() => {
      document
        .querySelector<HTMLInputElement>('input[name="name"]')
        ?.form?.requestSubmit();
    });
    // Cleared as soon as both are posted. The delay is only needed to keep the first
    // submission open long enough for the second to carry the same key — every Server
    // Action here re-renders the dashboard on the way back, so leaving it on makes the
    // rest of this test cost six delayed reads for nothing.
    await injectFaults(page, { slowMs: 0 });

    await expect(row(page, "cache")).toBeVisible({ timeout: 20_000 });
    await settled(page);
    const after = (await fixtureStats(page)).operations.ServiceCreate ?? 0;
    // One create, so one container — the fixture would happily have made two.
    expect(after - before).toBe(1);
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

  test("warns that an image is not available, and spins it up anyway", async ({
    page,
  }) => {
    /*
     * The whole point of the feature, and of its restraint. The reference is well-formed,
     * so nothing refuses it — the registry simply has no such repository, which on Docker
     * Hub is the same answer as "private" and is why one sentence covers both.
     *
     * Everything asserted after the warning is the non-blocking half: no aria-invalid, no
     * disabled submit, and a container at the end of it. A check that stopped a spin-up
     * would be worse than the failed deployment it is warning about.
     */
    await field(page, "Image reference").fill("nonexistent/image:tag");
    // The portalled list covers the submit button while it is open.
    await page.keyboard.press("Escape");

    const warning = onlyVisible(page.getByRole("status"));
    await expect(warning).toContainText(/no public image matches this reference/i);
    await expect(field(page, "Image reference")).not.toHaveAttribute("aria-invalid");

    await field(page, "Name").fill("typo");
    await button(page, /spin up container/i).click();

    await expect(row(page, "typo")).toBeVisible();
  });

  test("says nothing when the registry cannot answer", async ({ page }) => {
    /*
     * The failure mode this feature was nearly not built to avoid: a registry having a bad
     * day must not put anything on the form, least of all something that reads as a
     * problem with what the user typed.
     *
     * Waiting for the response rather than waiting out the debounce, and the difference is
     * the whole test. `toHaveCount(0)` passes the instant it is evaluated, so an absence
     * asserted before the check has fired proves nothing at all — this version passed in
     * 329ms with no `image.checked` record anywhere, which is a test asserting that a
     * warning had not appeared yet. Waiting for the answer makes it an assertion that one
     * arrived and said nothing.
     */
    await injectFaults(page, { registryStatus: 503 });

    /*
     * A different reference from the test above, and that is not incidental. The answer
     * cache lives in the app process, not in the fixture, so `/__test/reset` does not
     * touch it — probing `nonexistent/image:tag` again here would be served the previous
     * spec's `unavailable` from cache and never reach the 503 at all. That is the cache
     * working as designed (shared across users, ten-minute TTL); it just means a spec
     * about a registry failure has to ask about something nothing else asked about.
     */
    const answered = page.waitForResponse((response) =>
      response.url().includes("/api/image-check"),
    );
    await field(page, "Image reference").fill("nonexistent/unreachable:tag");
    await page.keyboard.press("Escape");
    await answered;

    await expect(onlyVisible(page.getByRole("status"))).toHaveCount(0);
    await expect(field(page, "Image reference")).not.toHaveAttribute("aria-invalid");
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

    /*
     * PGDATA rides along with the credential because postgres now takes a volume: the
     * official image refuses to initdb into a directory that is not empty, and a freshly
     * provisioned volume has `lost+found` in it. The catalog says why the two travel
     * together; what matters here is that the password is still the only secret.
     */
    expect(Object.keys(created.variables)).toEqual(["POSTGRES_PASSWORD", "PGDATA"]);
    expect(created.variables.PGDATA).toBe("/var/lib/postgresql/data/pgdata");
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

    expect(created.variables).toEqual({
      POSTGRES_PASSWORD: "hunter2hunter2",
      PGDATA: "/var/lib/postgresql/data/pgdata",
    });
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

/**
 * What the containers cost, in the two currencies Railway will actually report.
 *
 * A tool whose whole purpose is creating billable infrastructure said nothing about what
 * was running or what it was costing. These are the two halves of that: per-row usage,
 * which Railway gives per service, and spend, which it only gives per workspace.
 */
test.describe("usage and spend", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("shows what a running container is using, beside its logs", async ({ page }) => {
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
    await disclosure(page, "cache").click();

    /*
     * The fixture's usage is a deterministic function of the service id, so this asserts a
     * rendered figure rather than a shape. A regex here would pass against a readout that
     * had lost its units or its decimals.
     */
    const readout = cache.getByLabel(/Resource use for cache/);
    await expect(readout).toBeVisible();
    await expect(readout).toContainText("vCPU");
    await expect(readout).toContainText(/\d+ (MB|GB)/);
    // Uptime is derived from the deployment's own createdAt. The fixture used to report
    // epoch zero here, which would have rendered as fifty-six years.
    await expect(readout).toContainText("Uptime");
    await expect(readout).not.toContainText(/\d{4}d/);
  });

  test("keeps the list usable when Railway refuses metrics", async ({ page }) => {
    /*
     * The whole reason Query.metrics is an OPTIONAL_FIELDS entry rather than a required
     * one: a refusal degrades the row, it does not blank the dashboard. This is what a
     * token whose scope does not cover metrics sees on every render.
     */
    await injectFaults(page, { metricsFail: true });
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
    await disclosure(page, "cache").click();

    const readout = cache.getByLabel(/Resource use for cache/);
    await expect(readout).toContainText("—");
    // The row, its logs and its destroy control are all untouched.
    await expect(cache.getByRole("log")).toBeVisible();
    await expect(cache.getByRole("button", { name: "Destroy" })).toBeVisible();
  });

  test("says whose spend it is showing, and points elsewhere when it has none", async ({
    page,
  }) => {
    // The scope clause is the answer to "why does this not match my container list",
    // written into the copy once instead of asked repeatedly.
    await expect(
      page.getByText(/The Acme workspace has used .* so far this billing period/),
    ).toBeVisible();
    await expect(
      page.getByText(/including ones this app did not create/),
    ).toBeVisible();

    // A personal project has no workspace at all, which is not an error — the figure
    // simply lives on Railway.
    await injectFaults(page, { noWorkspace: true });
    await page.reload();

    await expect(page.getByText(/Railway reports spend per workspace/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open billing on Railway" }),
    ).toBeVisible();
  });
});

test.describe("editing a container", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("changes the image and streams the deployment that starts", async ({ page }) => {
    /*
     * The ticket in one test. Moving an image used to mean destroying the container and
     * making a new one, which for a database means losing it.
     *
     * The second half is the part with a mechanism behind it: changing the image redeploys,
     * and the row has to re-key its log stream onto a deployment id it does not yet know.
     * Nothing does that explicitly — `useDeploymentStream` keys on the id alone, and the
     * refreshed server render is what delivers the new one.
     */
    await spinUp(page, "cache");
    const cache = row(page, "cache");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });

    await disclosure(page, "cache").click();
    await expect(cache.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });

    const dialog = await openEditDialog(page, "cache");
    await dialog.getByLabel("Image reference").fill("redis:8-alpine");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(toast(page, "Updating cache")).toBeVisible();
    await expect(dialog).toBeHidden();

    // The row shows the new source, and settles again on the deployment the edit started.
    await expect(cache).toContainText("redis:8-alpine");
    await expect(cache.getByText("Running")).toBeVisible({ timeout: 20_000 });
    await expect(cache.getByRole("log")).toContainText("[fake-railway]", {
      timeout: 20_000,
    });

    const services = await fixtureServices(page);
    expect(services.find((s) => s.name === "spun-cache")?.image).toBe("redis:8-alpine");
  });

  test("keeps the ownership prefix when a container is renamed", async ({ page }) => {
    /*
     * The name is the ownership marker (ADR-5), so a rename that dropped the prefix would
     * make the app unable to destroy what it created. Asserted against the fixture's own
     * record rather than the screen, because the screen shows the name with the prefix
     * stripped — which is exactly the value that gets posted back.
     */
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    const dialog = await openEditDialog(page, "cache");
    await dialog.getByLabel("Name").fill("renamed");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(toast(page, "Updating renamed")).toBeVisible();
    await expect(row(page, "renamed")).toBeVisible();

    const services = await fixtureServices(page);
    expect(services.map((s) => s.name)).toContain("spun-renamed");

    // Still ours, so the destroy control is still offered.
    await expect(
      row(page, "renamed").getByRole("button", { name: "Destroy" }),
    ).toBeVisible();
  });

  test("adds and removes a variable without ever showing a stored value", async ({
    page,
  }) => {
    /*
     * The write-only rule, end to end. A postgres spin-up mints a password this app never
     * shows; reopening the editor must list the name and leave the cell empty, and saving an
     * untouched form must not change what is set.
     */
    await spinUp(page, "db", "PostgreSQL");
    await expect(row(page, "db").getByText("Running")).toBeVisible({ timeout: 20_000 });

    const before = await fixtureServices(page);
    const minted = before.find((s) => s.name === "spun-db")?.variables
      .POSTGRES_PASSWORD;
    expect(minted).toBeTruthy();

    const dialog = await openEditDialog(page, "db");

    /*
     * Listed by name, with an empty cell that says what empty means.
     *
     * Two rows rather than one, and PGDATA first: postgres carries it alongside the
     * credential since it took a volume, and `readServiceVariableNames` sorts. The secret is
     * the second row, which is the one whose cell has to be empty.
     */
    await expect(dialog.getByLabel("Variable name 1")).toHaveValue("PGDATA");
    const existing = dialog.getByLabel("Variable name 2");
    await expect(existing).toHaveValue("POSTGRES_PASSWORD");
    await expect(dialog.getByLabel("Variable value 2")).toHaveValue("");
    // The credential canary, at the one moment it is most likely to have leaked.
    expect(await page.content()).not.toContain(minted);

    await addVariable(page, "EXTRA", "value", dialog);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, "Updating db")).toBeVisible();

    const added = await fixtureServices(page);
    const variables = added.find((s) => s.name === "spun-db")?.variables ?? {};
    expect(variables.EXTRA).toBe("value");
    // Untouched, not rewritten and not re-minted — the blank cell meant "leave it alone".
    expect(variables.POSTGRES_PASSWORD).toBe(minted);

    const reopened = await openEditDialog(page, "db");
    await reopened.getByRole("button", { name: "Remove EXTRA" }).click();
    await reopened.getByRole("button", { name: "Save changes" }).click();
    /*
     * Polled against the fixture rather than awaited on a second toast. Both saves produce
     * the same sentence, and the first is still on screen when the second arrives — so a
     * toast assertion here is a strict-mode violation that says nothing about the removal.
     */
    await expect(reopened).toBeHidden();
    await expect
      .poll(async () => {
        const services = await fixtureServices(page);
        return services.find((s) => s.name === "spun-db")?.variables ?? {};
      })
      .toEqual({
        POSTGRES_PASSWORD: minted,
        // Untouched throughout, like the credential: the editor listed it, nobody edited
        // it, and an edit must not rewrite what it only displayed.
        PGDATA: "/var/lib/postgresql/data/pgdata",
      });
  });

  test("never offers to remove a variable the environment shares", async ({ page }) => {
    /*
     * A shared variable is not the service's to delete, and `variableDelete` scoped to a
     * service could not remove it anyway — so it must not appear in the editor at all. The
     * fixture seeds one for exactly this assertion.
     */
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    const dialog = await openEditDialog(page, "cache");

    await expect(dialog.getByText("SHARED_TOKEN")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Remove SHARED_TOKEN/ }),
    ).toHaveCount(0);
  });

  test("lets the name and image be edited when the variables cannot be read", async ({
    page,
  }) => {
    // A refused read degrades the dialog rather than closing it: the other two fields came
    // off the row and need nothing from Railway.
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    await injectFaults(page, { variablesFail: true });
    await onlyVisible(
      row(page, "cache").getByRole("button", { name: /^Edit$/ }),
    ).click();

    const dialog = onlyVisible(page.getByRole("dialog"));
    await expect(
      dialog.getByText(/could not read this container's variables/i),
    ).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("cache");
  });

  test("offers no edit control on a service this app did not create", async ({
    page,
  }) => {
    // The ownership boundary, as the UI expresses it. The action refuses one too — see
    // actions.integration.test.ts — but a control that is never rendered is the first line.
    await expect(
      onlyVisible(row(page, "postgres").getByRole("button", { name: /^edit$/i })),
    ).toHaveCount(0);
    // The slot still offers Railway's own page, which is the row's one action.
    await expect(
      onlyVisible(row(page, "postgres").getByRole("link", { name: "Open in Railway" })),
    ).toBeVisible();
  });

  test("dismisses with Escape without saving", async ({ page }) => {
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    const dialog = await openEditDialog(page, "cache");
    await dialog.getByLabel("Name").fill("abandoned");
    await dismissWithEscape(page, dialog);

    await expect(row(page, "cache")).toBeVisible();
    const services = await fixtureServices(page);
    expect(services.map((s) => s.name)).not.toContain("spun-abandoned");
  });
});
