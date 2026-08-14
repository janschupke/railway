# Decisions

Twelve architectural decision records, extracted from
[the README](../../README.md#decisions), which carries the summary table.

1. [ADR-1 — Railway OIDC directly, not an auth vendor](0001-railway-oidc-directly-not-an-auth-vendor.md)
2. [ADR-2 — Token refresh runs in the proxy layer](0002-token-refresh-runs-in-the-proxy-layer.md)
3. [ADR-3 — SSE downstream, WebSocket upstream](0003-sse-downstream-websocket-upstream.md)
4. [ADR-4 — No database](0004-no-database.md)
5. [ADR-5 — The app only destroys what it created](0005-the-app-only-destroys-what-it-created.md)
6. [ADR-6 — Docker images only; GitHub sources are a stated limitation](0006-docker-images-only.md)
7. [ADR-7 — The URL is the state; there is no client store](0007-the-url-is-the-state.md)
8. [ADR-8 — A hand-rolled GraphQL client, not Apollo](0008-a-hand-rolled-graphql-client-not-apollo.md)
9. [ADR-9 — Structured logs on stdout, with the OTel seam cut but not used](0009-structured-logs-on-stdout.md)
10. [ADR-10 — The dashboard watches; it does not poll from the browser](0010-the-dashboard-watches.md)
11. [ADR-11 — pnpm stays, and the migration was priced rather than assumed](0011-pnpm-stays.md)
12. [ADR-12 — Idempotency keys on create, and a repeat is replayed rather than rejected](0012-idempotency-keys-replay-rather-than-reject.md)
