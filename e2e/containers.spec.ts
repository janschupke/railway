import {
  button,
  expect,
  field,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  row,
  signIn,
  spinUp,
  test,
  toast,
} from "./support";

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
    await onlyVisible(cache.getByRole("button", { name: /^cache/ })).click();

    const log = cache.getByRole("log");
    await expect(log).toBeVisible();
    await expect(log).toContainText("[fake-railway]", { timeout: 20_000 });
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

  test("refuses to destroy a service it did not create", async ({ page }) => {
    // The fixture seeds `postgres`, which carries no ownership prefix.
    const postgres = row(page, "postgres");
    await expect(postgres).toBeVisible();

    await expect(
      onlyVisible(postgres.getByRole("button", { name: /^destroy$/i })),
    ).toHaveCount(0);
    await expect(postgres).toContainText("Not managed here");
  });

  test("rejects a duplicate name at the field that caused it", async ({ page }) => {
    await spinUp(page, "cache");
    await expect(row(page, "cache")).toBeVisible();

    await spinUp(page, "cache");

    await expect(onlyVisible(page.getByText(/already exists here/))).toBeVisible();
    await expect(field(page, "Name")).toHaveAttribute("aria-invalid", "true");
  });

  test("rejects a malformed image reference before submitting", async ({ page }) => {
    await field(page, "Image reference").fill("redis; rm -rf /");
    await field(page, "Name").fill("bad");
    await button(page, /spin up container/i).click();

    await expect(
      onlyVisible(page.getByText(/does not look like a valid image reference/)),
    ).toBeVisible();
  });

  test("settles a failed build into Failed rather than spinning forever", async ({
    page,
  }) => {
    await injectFaults(page, { deploymentsFail: true });

    await spinUp(page, "broken");

    const broken = row(page, "broken");
    await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });
  });

  test("surfaces a Railway rate limit instead of failing silently", async ({
    page,
  }) => {
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
  });
});
