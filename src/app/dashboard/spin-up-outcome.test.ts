import { describe, expect, it } from "vitest";

import { spinUpOutcome } from "./spin-up-outcome";

/**
 * A translator that reports which key was chosen rather than what it says.
 *
 * These cases are about the branching — eleven sentences over six outcomes and two
 * independent facts — and the sentences themselves are the catalog's business. Asserting
 * English here would make the test fail on a copy edit and pass on a wrong branch, which is
 * the wrong way round.
 */
const t = ((key: string, values?: Record<string, unknown>) =>
  values && Object.keys(values).length > 0
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : key) as unknown as Parameters<typeof spinUpOutcome>[3];

const created = (over: Partial<Parameters<typeof spinUpOutcome>[0]> = {}) =>
  ({
    serviceId: "svc_1",
    deploymentId: "dep_1",
    url: null,
    outcome: "deployed",
    ...over,
  }) as Parameters<typeof spinUpOutcome>[0];

describe("spinUpOutcome", () => {
  describe("the five ways a service can exist and not be running", () => {
    /*
     * Each has its own sentence because each has its own remedy, and the audit note in
     * service-create.ts says so: collapsing them into a boolean would tell somebody whose
     * plan refused the size to go and look at their variables.
     */
    const cases = [
      ["volume_failed", "actions.createdButNoVolume"],
      ["settings_failed", "actions.createdButNoSettings"],
      ["limits_failed", "actions.createdButNoLimits"],
      ["variables_failed", "actions.createdButNotConfigured"],
      ["deploy_failed", "actions.createdButNotDeployed"],
    ] as const;

    for (const [outcome, key] of cases) {
      it(`${outcome} fails with its own sentence, naming the container`, () => {
        const result = spinUpOutcome(created({ outcome }), "cache", false, t);

        expect(result.value.ok).toBe(false);
        expect(result.value).toMatchObject({ error: `${key}(name=cache)` });
      });
    }

    it("gives all five distinct sentences", () => {
      const errors = cases.map(
        ([outcome]) =>
          spinUpOutcome(created({ outcome }), "cache", false, t).value as {
            error: string;
          },
      );
      expect(new Set(errors.map((e) => e.error)).size).toBe(cases.length);
    });

    it("retains every failure, because the service is already on Railway", () => {
      // The property that stops a replayed submission creating a second container.
      for (const [outcome] of cases) {
        expect(spinUpOutcome(created({ outcome }), "cache", false, t).retain).toBe(
          true,
        );
      }
    });

    it("says nothing about a URL on a failure, even if one came back", () => {
      const result = spinUpOutcome(
        created({ outcome: "deploy_failed", url: "https://cache.up.railway.app" }),
        "cache",
        true,
        t,
      );
      expect(result.value).toMatchObject({
        error: "actions.createdButNotDeployed(name=cache)",
      });
    });
  });

  describe("a deployed container, over two independent facts", () => {
    /*
     * A postgres mints a credential and gets no address; an nginx gets an address and mints
     * nothing; a rabbitmq does both. Four whole sentences rather than fragments composed at
     * runtime — word order and sentence boundaries are the catalog's to choose per language.
     */
    const url = "https://cache.up.railway.app";

    it("names neither when there is neither", () => {
      expect(spinUpOutcome(created(), "cache", false, t).value).toMatchObject({
        ok: true,
        message: "actions.spinningUp(name=cache)",
      });
    });

    it("names the credential when one was minted", () => {
      expect(spinUpOutcome(created(), "db", true, t).value).toMatchObject({
        message: "actions.spinningUpWithCredentials(name=db)",
      });
    });

    it("names the address when there is one", () => {
      expect(spinUpOutcome(created({ url }), "web", false, t).value).toMatchObject({
        message: `actions.spinningUpAtUrl(name=web,url=${url})`,
      });
    });

    it("names both when there are both", () => {
      expect(spinUpOutcome(created({ url }), "queue", true, t).value).toMatchObject({
        message: `actions.spinningUpWithCredentialsAtUrl(name=queue,url=${url})`,
      });
    });

    it("falls back to the no-address sentence when the domain was refused", () => {
      /*
       * `url` is null on a spin-up that asked for a domain and did not get one —
       * `railway.domain_failed` has the record. The user is told about the container,
       * because that is what they asked for and the row now offers the control that fixes
       * the rest.
       */
      expect(
        spinUpOutcome(created({ url: null }), "web", false, t).value,
      ).toMatchObject({
        message: "actions.spinningUp(name=web)",
      });
    });
  });
});
