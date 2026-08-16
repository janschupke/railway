# Tests

Five tiers — unit, component, integration, lint-rules and e2e — each answering something the
others cannot. The first four are Vitest projects in `vitest.config.mts`; e2e is Playwright.
What each tier is for, where a test lives and how the coverage gate works is in
[`.ai/rules/testing.md`](../.ai/rules/testing.md); the enforced numbers are in
`vitest.config.mts`. Neither is restated here. What follows is the part that is specific to
this app rather than to the policy.

**The coverage gate counts uncovered lines, branches, functions and statements rather than a
percentage**, globally and per directory, with one per-file exception:
`src/lib/railway/subscribe.ts` is pinned at 100%. A count is stable when the denominator moves,
which a percentage is not. Framework shells (`page.tsx`, `layout.tsx`, `loading.tsx`,
`error.tsx`, `not-found.tsx`) are excluded and covered end-to-end instead — counting them would
either inflate the number or invite render tests that assert nothing. E2E does not feed the
figure, so component tests have to carry the UI.

**Log records are asserted, not printed past.** [src/test/log-capture.ts](../src/test/log-capture.ts)
is installed globally from `src/test/setup.ts`, so every tier can read what was actually
written — including the credential canary, which runs over the real OAuth callback handler and
searches the raw serialized bytes rather than a parsed record.

## The fake Railway

[e2e/fixtures/fake-railway/](../e2e/fixtures/fake-railway/) is a stand-in Railway on one port:
an OIDC provider whose `id_token` is genuinely **ES256**-signed and served through a real JWKS, a
GraphQL API over an in-memory store, and a hand-rolled `graphql-transport-ws` endpoint.
Deployments advance `QUEUED → BUILDING → DEPLOYING → SUCCESS` on a timer, so status transitions
and log streaming are real rather than snapshots.

**The signing algorithm has to match production.** Railway signs with ES256; oauth4webapi
defaults to requiring RS256, so an RS256 fixture agrees with that default, passes, and leaves
real sign-ins failing. The fixture also models Railway's condition for issuing a refresh token —
both `offline_access` and `prompt=consent` on the authorization request, or the exchange returns
none. Without that, a login flow that cannot sustain a session past an hour looks green here.

The app runs unmodified against it, so PKCE, the token exchange and refresh-token rotation are
all exercised rather than stubbed away by seeding a session cookie. What
[playwright.config.ts](../playwright.config.ts) changes is four upstream URLs —
`RAILWAY_ISSUER`, `RAILWAY_API_URL`, `RAILWAY_WS_URL` and `REGISTRY_PROBE_URL`, the last so the
image check never reaches a real registry — plus `WATCH_POLL_MS` and `METRICS_POLL_MS`, tuned
down to seconds so a spec does not wait out a production interval.

`POST /__test/faults` injects rate limits, revoked authorizations, failed builds and a `slowMs`
delay — busy state only exists while a request is in flight, so a spec that means to assert on it
slows the API down rather than racing it.

Playwright runs `workers: 1`: the fixture holds shared state that each spec resets.

## One spec runs at phone width, not the whole suite

`playwright.config.ts` declares a second `mobile` project scoped by `testMatch` to
[e2e/responsive.spec.ts](../e2e/responsive.spec.ts). `workers: 1` is not negotiable, so a second
full project would roughly double CI wall-clock — and the app declares two `sm:` utilities in
all of `src/` and adapts by wrapping everywhere else, leaving no viewport-conditional code to
regress. That spec asserts what a phone viewport does prove: on the dashboard, nothing overflows
sideways with the list filtered and paged, the tab strip and status chips wrap rather than clip,
the whole status list stays reachable, the search field takes the line, Load more keeps a
tappable target, and the back-to-top button does not cover the last row's controls. A second
block covers the landing page at the same width, where the canvas has to stay inside the content
column and the sign-in card has to stay usable over it.

## One deliberate split

The sign-in button's busy state is a component test, not an e2e one. It exists only between the
click and the browser committing the next document, and against the fixture that whole OAuth
chain finishes in under 120 ms — while forcing a window open, by holding or aborting the
request, makes Chrome tear down the document and destroy the state under test.

## Known non-issues

**"The resource … was preloaded using link preload but not used within a few seconds from the
window's load event."** Development only, and not this app's. `next dev` emits exactly one
`<link rel=preload>`, and it is Turbopack's HMR client — which the dev runtime loads through its
own machinery rather than as a plain script, so the browser reports it unused. A production
build emits one preload (Next's error-boundary chunk, at `fetchPriority=low`) and the browser
does not complain about that one at all.

[e2e/console.spec.ts](../e2e/console.spec.ts) is what keeps this bounded: it captures the console
over CDP — `page.on("console")` never receives engine-generated messages like this one — with an
empty allow-list, so any _new_ warning fails CI. It does not pin the preload count or its
`fetchPriority`; those are the explanation, and the gate is only that nothing new appears.

**A 200 response carrying `{"message":"Not Authorized"}`.** Railway answers an unauthorized field
with HTTP 200 and `extensions.code: "INTERNAL_SERVER_ERROR"` rather than `UNAUTHENTICATED` or
`FORBIDDEN`. The client maps that upstream shape explicitly — see
[Schema verification](schema.md#when-the-dashboard-says-there-are-no-projects).

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
