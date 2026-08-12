import { expect, signIn, test } from "./support";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * The browser console, asserted rather than glanced at.
 *
 * `page.on("console")` is not enough: the messages worth catching here — unused
 * preloads, blocked resources, CSP violations — are emitted by the rendering engine
 * rather than by a `console.*` call, and never reach that event. CDP's Log domain does.
 *
 * The allow-list is empty, and that is the finding rather than an oversight. The
 * reported "preloaded using link preload but not used" warning does not occur in a
 * production build at all: the only `<link rel=preload>` `next start` emits is Next's
 * own error-boundary chunk, at fetchPriority=low, and the browser does not complain
 * about it. In `next dev` there is exactly one preload and it is Turbopack's HMR client
 * — dev-only, framework-emitted, and never shipped. See "Known non-issues" in the README.
 *
 * So the value of this file is not what it tolerates; it is that any *new* console
 * warning fails CI.
 */
const ALLOWED: Array<{ pattern: RegExp; reason: string }> = [];

type Entry = { level: string; text: string; url?: string };

async function collect(page: Page, context: BrowserContext) {
  const entries: Entry[] = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send("Log.enable");
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "warning" || entry.level === "error") {
      entries.push({ level: entry.level, text: entry.text, url: entry.url });
    }
  });
  page.on("pageerror", (error) =>
    entries.push({ level: "error", text: error.message }),
  );
  return entries;
}

/** Printed on failure, so the next reader does not have to reproduce this by hand. */
async function preloads(page: Page) {
  return page.$$eval('link[rel="preload"]', (links) =>
    links.map((link) => ({
      href: (link as HTMLLinkElement).href,
      as: link.getAttribute("as"),
      fetchPriority: link.getAttribute("fetchpriority"),
    })),
  );
}

function unexpected(entries: Entry[], declared: unknown[]): Entry[] {
  const survivors = entries.filter(
    (entry) => !ALLOWED.some(({ pattern }) => pattern.test(entry.text)),
  );
  if (survivors.length) {
    // e2e specs are allowed to log; the diagnostic is the point of this file.
    console.log("declared preloads:", JSON.stringify(declared, null, 2));
  }
  return survivors;
}

/** Long enough for "not used within a few seconds from the window's load event". */
const SETTLE_MS = 4_000;

test.describe("the browser console", () => {
  test("/ logs no warnings or errors", async ({ page, context }) => {
    const entries = await collect(page, context);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);

    expect(unexpected(entries, await preloads(page))).toEqual([]);
  });

  test("/dashboard logs no warnings or errors", async ({ page, context }) => {
    const entries = await collect(page, context);

    await signIn(page);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);

    expect(unexpected(entries, await preloads(page))).toEqual([]);
  });

  test("a missing route logs nothing beyond its own 404", async ({ page, context }) => {
    /*
     * The 404 document *is* a 404 response, and Chrome reports that as a resource error.
     * Filtering it here rather than allow-listing it globally keeps the other two routes
     * strict — a real 404 for a chunk or a font on the dashboard must still fail.
     */
    const entries = await collect(page, context);

    await page.goto("/definitely-not-a-route");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);

    const beyond = unexpected(entries, await preloads(page)).filter(
      (entry) => !/status of 404/.test(entry.text),
    );
    expect(beyond).toEqual([]);
  });
});
