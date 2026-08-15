/**
 * Deep links into Railway's own dashboard.
 *
 * Deliberately not `server-only`, and deliberately not in `lib/constants.ts`. Every reader
 * is a client component — the container row, its panel and the detail dialog — so this has
 * to reach the browser; and it is a builder rather than a tuned number, which is what took
 * it out of the constants file. Nothing here talks to Railway, so it carries none of the
 * rest of `lib/railway/`'s server weight.
 */

import { LINKS } from "@/lib/constants";

/**
 * One service on Railway's own dashboard.
 *
 * Built entirely from ids a container row already holds, so this escape hatch costs no
 * API call — which is the only reason it can sit on every row, as the container name.
 *
 * It is repeated inside a failed row's panel, and stays there now that the row asks
 * `deploymentEvents` for a reason. That read is best effort by design — the feed can be
 * empty, refused, or withdrawn — and the deployment query still returns a status and
 * nothing else, so "Failed" over a legitimately empty pane remains a state the app can
 * reach. Railway's own page is where the rest of it lives in every one of those branches,
 * which is why this link is unconditional rather than a fallback the reason replaces.
 *
 * The ids are Railway's rather than the user's, and encoded anyway — a link builder that
 * trusts its inputs is one refactor away from not being able to.
 */
export const railwayServiceUrl = (params: {
  projectId: string;
  serviceId: string;
  environmentId: string;
}): string =>
  `${LINKS.RAILWAY_PROJECT}/${encodeURIComponent(params.projectId)}` +
  `/service/${encodeURIComponent(params.serviceId)}` +
  `?environmentId=${encodeURIComponent(params.environmentId)}`;
