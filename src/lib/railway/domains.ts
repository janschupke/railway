/**
 * A public domain for a service.
 *
 * Its own module rather than a member of the lifecycle: a domain is the one thing here that
 * changes what the outside world can reach, and it is created on a service that already
 * exists rather than as a step of building one.
 */

import "server-only";

import { gql } from "./client";
import { SERVICE_DOMAIN_CREATE_MUTATION } from "./operations";

/**
 * Put a service on the public internet, and hand back the address.
 *
 * Two callers, and the difference between them is where the port comes from rather than
 * anything about the call: `createContainer` above sends the port the catalog or the form
 * supplied, and the row's domain action sends the catalog's port when it knows the image and
 * omits it otherwise, letting Railway infer one from the running deployment.
 *
 * Returns the URL with its scheme, so that the one place `https://` is decided is the
 * mapper's `toPublicUrl` and this — the two paths a URL can reach a row by.
 *
 * Uncaught, unlike the call inside `createContainer`: this one is the whole of what its
 * action does, so there is no partial success to describe and nothing to report but the
 * failure itself.
 */
export async function createServiceDomain(
  accessToken: string,
  params: { environmentId: string; serviceId: string; targetPort?: number },
  signal?: AbortSignal,
): Promise<string> {
  const created = await gql(
    SERVICE_DOMAIN_CREATE_MUTATION,
    {
      input: {
        environmentId: params.environmentId,
        serviceId: params.serviceId,
        /*
         * Omitted rather than sent as null when the caller has no port. The schema accepts
         * both, and they mean the same thing to Railway — but an explicit null reads as a
         * decision the caller made, and this one is an absence of information.
         */
        ...(params.targetPort === undefined ? {} : { targetPort: params.targetPort }),
      },
    },
    { accessToken, signal },
  );

  return `https://${created.serviceDomainCreate.domain}`;
}
