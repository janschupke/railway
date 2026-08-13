/**
 * Mints a real session cookie for Lighthouse.
 *
 * The dashboard is the page worth measuring — it holds the list, the dialogs and the
 * stream — but it sits behind OAuth. Rather than teach Lighthouse to authenticate, this
 * drives the actual sign-in once with Playwright (already a dependency, and already the
 * thing that knows how to talk to the fake Railway) and writes the resulting cookie to
 * disk for `lighthouserc.cjs` to send as a header.
 *
 * One browser, one page. Never a pool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";

const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;
/*
 * Under .lighthouseci/ rather than at the repo root.
 *
 * The file holds a live sealed session. It is only ever the fake Railway's, and it was
 * always gitignored — but a bare dotfile at the root is inside every `docker build`
 * context and every `npm pack`, and "it is only the fixture's" is a property of today's
 * usage rather than of the file. The directory it moves into is already ignored whole,
 * so the ignore rule cannot be forgotten for a sibling later.
 */
const OUTPUT = process.env.LH_COOKIE_FILE ?? ".lighthouseci/cookie";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(APP_URL);
  await page.getByRole("link", { name: /sign in with railway/i }).click();
  await page.waitForURL("**/dashboard**");

  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "rc_session");
  if (!session) {
    console.error(
      "Signed in but no session cookie was set — cannot measure /dashboard.",
    );
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${session.name}=${session.value}`, "utf8");
  console.log(`Wrote session cookie to ${OUTPUT}`);
} finally {
  await browser.close();
}
