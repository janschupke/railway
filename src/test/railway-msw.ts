import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * The MSW rig every `lib/railway` integration test stands on.
 *
 * One file rather than a copy per suite, because these five things were the whole shared
 * preamble of the 2050-line `api.integration.test.ts` and splitting that along its subjects
 * would otherwise have meant six copies of a `setupServer` dance that must not drift.
 *
 * **Each importing test file gets its own `server`**, which is what makes the split safe:
 * vitest gives every test file its own module registry, so `setupServer()` runs once per
 * file and one suite's handlers can never leak into another's.
 *
 * `onUnhandledRequest: "error"` is the load-bearing setting. A Railway call this app makes
 * and a test did not stub fails the test rather than reaching the network, which is what
 * turns "the mutation ran" into something these suites can actually assert.
 */
export const railwayApi = (url: string) => graphql.link(url);

export const TOKEN = "token";

/**
 * Stands the server up and tears it down, as three vitest hooks.
 *
 * Called at the top level of a test file, not inside a `describe` — the hooks register
 * against whatever scope is current, and file scope is what "reset between every test in
 * this file" means.
 */
export function setupRailwayServer() {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

/**
 * Railway answering `volumeCreate`.
 *
 * Written once because it is part of creating most of the interesting presets: redis,
 * postgres, mysql, mariadb, mongo and rabbitmq all attach a volume before they deploy, so a
 * create test using one of them that does NOT stub this is testing the `volume_failed`
 * branch by accident. `onCall` is for the tests that care where in the sequence it lands.
 */
export const volumeOk =
  (api: ReturnType<typeof railwayApi>) =>
  (onCall?: (input: Record<string, unknown>) => void) =>
    api.mutation("VolumeCreate", ({ variables }) => {
      onCall?.(variables.input as Record<string, unknown>);
      return HttpResponse.json({
        data: { volumeCreate: { id: "vol_1", name: "spun-db-volume" } },
      });
    });

/** A project node as Railway nests it, so the connection shape is written once. */
export const projectNode = (id: string, name: string) => ({
  id,
  name,
  environments: { edges: [{ node: { id: "e1", name: "production" } }] },
});
