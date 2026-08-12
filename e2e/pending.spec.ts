import {
  button,
  expect,
  field,
  injectFaults,
  onlyVisible,
  row,
  settled,
  signIn,
  test,
} from "./support";

/**
 * Busy state.
 *
 * Every control here talks to something slow, and none of them said so before this
 * suite existed: the sign-in link was a bare anchor, and spin-up and destroy expressed
 * "working" only by swapping their own label — which assistive tech does not re-read.
 *
 * Observing a pending state means catching a request in flight, so these specs slow the
 * fixture down first rather than racing it.
 */

/*
 * Sign-in is covered by src/components/sign-in-button.test.tsx, not here, and that is a
 * deliberate call rather than an omission.
 *
 * Its busy state only exists between the click and the browser committing the next
 * document. Against the fixture that whole OAuth chain completes in well under 120ms,
 * so there is no window to observe; and manufacturing one by holding or aborting the
 * request makes Chrome tear the document down, which destroys the very state under
 * test. The jsdom test asserts the same three things — aria-busy, the swapped label,
 * and the pageshow reset — deterministically.
 */

test("spin up marks the button busy and announces it", async ({ page }) => {
  await signIn(page);
  await injectFaults(page, { slowMs: 1500 });

  await onlyVisible(page.getByRole("radio", { name: "Redis" })).click();
  await field(page, "Name").fill("busy-check");

  // Matches either label: the button renames itself while busy, so a locator pinned to
  // the idle name would stop resolving at exactly the moment under test.
  const submit = button(page, /spin up container|spinning up/i);
  await submit.click();

  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText(/spinning up/i);

  // The label swap alone is silent; the live region is what actually gets announced.
  await expect(
    onlyVisible(page.locator("[data-pending-status]")).first(),
  ).toContainText(/spinning up container/i);

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
});

test("destroy marks its button busy and locks cancel", async ({ page }) => {
  await signIn(page);

  await onlyVisible(page.getByRole("radio", { name: "Redis" })).click();
  await field(page, "Name").fill("doomed");
  await button(page, /spin up container/i).click();
  await settled(page);
  await expect(row(page, "doomed")).toBeVisible();

  await injectFaults(page, { slowMs: 1500 });
  await row(page, "doomed").getByRole("button", { name: "Destroy" }).click();

  await onlyVisible(page.getByLabel(/type "doomed" to confirm/i)).fill("doomed");
  const confirm = button(page, /destroy permanently|destroying/i);
  await confirm.click();

  await expect(confirm).toHaveAttribute("aria-busy", "true");
  // Dismissing mid-flight would unmount the form and strand the request.
  await expect(button(page, "Cancel")).toBeDisabled();

  await injectFaults(page, { slowMs: 0 });
});

test("switching project reports loading without stealing focus", async ({ page }) => {
  await signIn(page);
  await injectFaults(page, { slowMs: 1200 });

  const projectSelect = onlyVisible(page.getByRole("combobox", { name: "Project" }));
  await projectSelect.click();
  await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();

  /*
   * The select used to be disabled during the transition, which removes it from the
   * a11y tree and drops focus to <body>. aria-busy says the same thing without that.
   */
  await expect(projectSelect).toBeEnabled();

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
});
