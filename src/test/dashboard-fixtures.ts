import { logRecords } from "@/test/log-capture";
import { newIdempotencyKey } from "@/lib/random-id";

/**
 * The fixtures every dashboard action's integration test builds on.
 *
 * Shared because they were one 200-line preamble in front of a 2,951-line file, and
 * splitting that file along the seams the source now has would otherwise have meant five
 * copies of `projectWith` drifting apart.
 *
 * Only the pure builders live here. The `vi.mock` calls and the dynamic imports of the
 * actions cannot: a mock registry is per test file, so each one still declares what it is
 * standing in for, which is also the honest place for it to be stated.
 *
 * Under src/test/, which knip ignores and coverage excludes — a fixture module should not
 * carry a coverage floor of its own.
 */

/** One project, one environment, one managed service and one that this app did not create. */
export function projectWith(
  services: Array<{
    id: string;
    name: string;
    /**
     * A service Railway reports with no deployment at all.
     *
     * The orphan a refused first deploy leaves behind, which is a real row on the dashboard
     * and the one the redeploy action exists to rescue — so it has to be expressible here.
     */
    undeployed?: boolean;
    /** What the service runs, when a case needs the catalog to recognise it or not. */
    image?: string;
    /** The host Railway already minted for it, for the branch that must not mint a second. */
    domain?: string;
  }> = [
    { id: "svc_managed", name: "spun-cache" },
    { id: "svc_foreign", name: "postgres" },
  ],
) {
  return {
    project: {
      id: "p1",
      name: "Demo",
      environments: { edges: [{ node: { id: "e1", name: "production" } }] },
      services: {
        edges: services.map((s) => ({
          node: {
            id: s.id,
            name: s.name,
            createdAt: "2026-08-01T00:00:00Z",
            serviceInstances: {
              edges: [
                {
                  node: {
                    id: `si_${s.id}`,
                    environmentId: "e1",
                    source: { image: s.image ?? "redis:7-alpine", repo: null },
                    domains: {
                      serviceDomains: s.domain ? [{ domain: s.domain }] : [],
                    },
                    latestDeployment: s.undeployed
                      ? null
                      : {
                          id: `dep_${s.id}`,
                          status: "SUCCESS",
                          createdAt: "2026-08-01T00:00:00Z",
                          updatedAt: "2026-08-01T00:00:00Z",
                        },
                  },
                },
              ],
            },
          },
        })),
      },
    },
  };
}

export const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};

/*
 * A fresh key per call, before the spread so a case can pin one deliberately.
 *
 * Fresh matters: a shared constant would make every case in this file a replay of the
 * previous one's result, which is exactly the behaviour under test and would hide it
 * everywhere else.
 */
export const spinUpForm = (over: Record<string, string> = {}) =>
  form({
    projectId: "p1",
    environmentId: "e1",
    name: "cache",
    image: "redis:7-alpine",
    idempotencyKey: newIdempotencyKey(),
    ...over,
  });

/**
 * The spin-up form with environment rows on it, as the editor posts them.
 *
 * Two parallel repeated fields rather than one structured value: index i of `variableKey`
 * and index i of `variableValue` are one row, which is the wire format the schema and the
 * row-attributed errors both depend on.
 */
export const spinUpFormWith = (
  rows: Array<[string, string]>,
  over: Record<string, string> = {},
) => {
  const data = spinUpForm(over);
  for (const [key, value] of rows) {
    data.append("variableKey", key);
    data.append("variableValue", value);
  }
  return data;
};

/** The one record carrying an event name, so an assertion names the event it means. */
export const record = (event: string) => logRecords().find((r) => r.msg === event);
