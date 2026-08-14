# ADR-13 — The origin is the request, not a variable

**Status:** accepted

## Context

The app had one origin. `APP_URL`, or `https://${RAILWAY_PUBLIC_DOMAIN}` when that was
unset, was a single string that five separate decisions read: the OIDC `redirect_uri`,
every browser-visible redirect in a route handler, the cookie `secure` flag and `__Host-`
prefix, the logout CSRF comparison, and the CSP's `upgrade-insecure-requests`.

Two failures follow from that, and both were reported from the deployed app:

- **A custom domain does not work.** Railway injects `RAILWAY_PUBLIC_DOMAIN` naming the
  _generated_ `*.up.railway.app` domain, and keeps naming it after a custom domain is
  added. So a sign-in started at `https://trains.schupke.io` sent the browser to the
  generated domain — a `redirect_uri` the user never typed, a session cookie set on the
  wrong host, and a flow that ends somewhere they have not been. Setting `APP_URL` fixes
  that domain by breaking the other one.
- **Two domains are impossible.** Whichever origin the variable names is the only one auth
  works on. There is no value that serves both.

The `.env` comment claiming Railway "injects `RAILWAY_PUBLIC_DOMAIN` into every
deployment" was also wrong in a third way: it is injected only once a service _has_ a
public domain, so a service without one failed to parse its environment, answered its
healthcheck with 503, and was reported as a broken deploy.

## The measurement this rests on

`request.url` is not the answer, and the reason is recorded rather than assumed. Commit
`561eec1` measured it on the built image: forwarding exactly what Railway's edge sends —
public `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto: https` — a route handler still
emitted `location: https://localhost:8080/…`. Next's standalone `server.js` builds that
URL from its own bind address, so the headers never reach it. The headers themselves are
intact. `src/app/redirect-origin.test.ts` bans `request.url` for that reason and still
does.

## Decision

**Derive the origin from the request's own headers, on every request.**
`x-forwarded-host` else `host`, scheme from `x-forwarded-proto`, in `src/lib/origin.ts`.
The result is a branded `AppOrigin`, minted nowhere else, so the cookie layer cannot be
handed an unvalidated string by a caller in a hurry.

Three rules bound what will be believed:

1. **https, unless the host is loopback.** An explicit `x-forwarded-proto: http` on a
   public host is refused rather than honoured — it is the one header that would otherwise
   strip `Secure` off the session cookie and drop the `__Host-` prefix.
2. **The parse must round-trip.** Interpolating a header into a URL string parses far more
   than a host; requiring the result to be exactly the host it was given rejects
   `evil.example/path`, `user@evil.example`, whitespace and punycode surprises.
3. **`APP_ORIGINS`, when set, is an allowlist.** Unset means any host the edge reports.

`APP_URL` survives as an explicit override and as the fallback for a request carrying no
usable Host. It is no longer required, and a service with no public domain now boots.

### Why the default is open

Trusting the proxy-reported host is what makes a new custom domain need no configuration —
point it at the service, register its callback, done. It is defensible here because
nothing downstream is exploitable by naming a host you already control:

- Railway's OAuth app enforces its registered `redirect_uri`s, so a spoofed origin cannot
  receive an authorization code — the provider rejects the request outright.
- The cookies are `__Host-`, which is host-scoped, so a spoofed `Host` produces a session
  only in the spoofer's own browser.
- There is no shared cache in front of this app to poison.
- There is no email, magic-link or notification path that could carry a spoofed origin to
  a third party.

`APP_ORIGINS` exists for deployments that would rather not rely on that argument.

## Alternatives rejected

- **Keep `APP_URL` required, one per deployment.** This is the status quo and the reported
  bug. It cannot serve two domains at all.
- **Require `APP_ORIGINS`.** A new custom domain would then fail to sign anyone in until
  somebody remembered to edit a service variable — the same class of failure as today's,
  moved one step later and made harder to diagnose, since the symptom is a redirect to a
  domain that _is_ configured.
- **Derive from `RAILWAY_PUBLIC_DOMAIN` alone.** That is precisely what named the wrong
  domain.
- **Have the proxy stamp an `x-app-origin` header** the way it stamps the CSP nonce and
  `x-request-id`. Those are _minted_ in the proxy and have no other channel; the origin is
  a pure function of headers the render already receives. A stamped header would be a
  second source of truth that the proxy-excluded paths (`api/auth/*`, `api/health`) would
  not have, plus one more client-supplied header to remember to overwrite.

## Consequences

- **Sessions are per domain.** `__Host-` cookies are host-scoped, so signing in on one
  domain does not sign you in on another. That is correct, and `e2e/multi-domain.spec.ts`
  asserts it rather than leaving it as prose.
- **Every domain needs its own `/api/auth/callback` registered** on the Railway OAuth app,
  or the provider refuses the authorization request. This is the one manual step left.
- **A route handler may name neither `request.url` nor `APP_URL`.** Both are enforced
  structurally in `src/app/redirect-origin.test.ts`.
- **`/api/health` reports a narrower condition.** "Misconfigured" now means a missing
  secret or a malformed optional value — no longer "this service has no public domain yet",
  which was the most common false healthcheck failure it produced.
- **A refusal never logs the host it refused.** It is caller input; the record carries a
  bounded reason, and `boot` carries the configured allowlist so the other half of the
  question is still answerable.
- **The fallback is the rollback.** If Railway's edge ever stops forwarding the public
  host, the app behaves exactly as it did before and setting `APP_URL` restores the old
  behaviour without a redeploy.
