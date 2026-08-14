# ADR-5 — The app only destroys what it created

This tool deletes infrastructure, so ownership is the load-bearing safety property.

Railway services carry no arbitrary metadata, and a per-service variable lookup would
cost a round-trip per row against a low rate limit. So the **name prefix** (`spun-` by
default) is the marker: it comes back in the same query that lists services, and it is
visible in Railway's own dashboard rather than hidden.

Services created elsewhere are listed for context but render as _Not managed here_ with
no destroy control — and `spinDown` re-derives ownership **server-side** before deleting,
so a forged request fails even though the user's own token would happily perform it.

The marker is cosmetic, so the claim has limits and the copy states them: a service
renamed to `spun-…` in Railway's dashboard is indistinguishable from one this app
created. `managed.test.ts` pins that as deliberate rather than leaving it to be
"fixed" silently.

`destroyContainer` itself checks nothing — the guard lives in its one caller, which is a
property of the call graph that no type defends. `destroy-callsites.test.ts` asserts it:
one caller, and the ownership check above the delete inside it.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
