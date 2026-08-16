# ADR-5 — The app only acts on containers it created

**Status:** accepted · **Decided:** 2026-08-14 · **Last revised:** 2026-08-15

## Context

This tool changes infrastructure in an account it does not own, so ownership is the load-bearing
safety property. The user's own token would happily perform any of these operations on any
service they can see; the constraint has to come from this app.

Railway services carry no arbitrary metadata, and a per-service variable lookup would cost a
round trip per row against a low rate limit.

## Decision

**The name prefix (`spun-` by default) is the ownership marker.** It comes back in the same query
that lists services, and it is visible in Railway's own dashboard rather than hidden.

**Every verb that changes a container is gated by it** — destroy, stop, restart, redeploy,
rollback and edit. Services created elsewhere are listed for context but render as _Not managed
here_ with no controls and no selection checkbox.

**The re-derivation happens server-side, and it is shared rather than repeated.**
`withManagedContainer` parses the ids, re-reads the container list from Railway, and refuses
before any verb's own work runs. Six copies of "find the service, refuse an unmanaged one" would
be six chances to write a subtly weaker one. The callsite test asserts `!target.managed` appears
exactly once, in `src/app/dashboard/action-managed.ts`.

**Deployment ids are derived, never posted.** Stop and restart need one, and it comes off the
container Railway just described — not from the form. Otherwise the ownership check would guard
the service while the mutation acted on an id the browser chose, which is the same hole one layer
down. Rollback is the single exception, because its target is by definition in the past; it
re-reads the deployment list scoped by the service id Railway returned and refuses any id that is
not a member of it.

**Renaming always prefixes rather than validating.** Editing changes the marker itself — a rename
is part of an edit, and the name is the whole of the ownership claim. That could have been a
validation rule: accept a name, refuse one that has lost the prefix. It is not. The submitted name
goes through `toManagedName`, which always prefixes, so a name without `MANAGED_PREFIX` is not a
request shape at all — there is no refusal path because nothing reaches one. A rule would have been
a second place for this decision to live and a first place for it to be got wrong.

**Reversible verbs confirm differently.** Destroy costs a typed container name; stopping does not.
Asking for the same friction on a reversible action would teach people to type container names
without reading the dialog, which is exactly the habit destroy relies on them not having.

## Consequences

- **The marker is cosmetic, so the claim has limits and the copy states them.** A service renamed
  to `spun-…` in Railway's own dashboard is indistinguishable from one this app created — and since
  editing landed, a user can also rename a container they own to any prefixed name they like from
  inside this app. Neither widens the blast radius: both are bounded by the OAuth scopes granted,
  and every mutation carries the user's own token. But "the set of names this app claims" is now
  something it helps write rather than only reads. `managed.test.ts` pins that as deliberate rather
  than leaving it to be "fixed" silently.
- **The guard is a property of the call graph that no type defends**, so two lint rules assert it.
  `no-restricted-imports` allows the mutations to be imported only by the write lane, and
  `local/mutation-inside-ownership-guard` requires each call to sit inside the guard's callback —
  or inside a function that resolves ownership for itself, which is how the batch does it.
  `destroyContainer` itself checks nothing.
- **Projects and environments carry no prefix**, because the prefix gates destroy and there is no
  destroy to gate — see [Limitations](../limitations.md#projects-environments-and-volumes).
- **A volume's owner is its service**, not its own name.
  [ADR-14](0014-a-volume-belongs-to-the-service-that-mounts-it.md) argues why.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
