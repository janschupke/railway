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

`destroyContainer` itself checks nothing — the guard lives in its callers, which is a
property of the call graph that no type defends. `mutation-callsites.test.ts` asserts it:
one calling module, and the ownership check above the mutation inside it.

## Amended by T-486: four verbs, one guard

Stop, restart and redeploy change a container that already exists, so each is bounded by
the same rule and the title now reads narrower than the decision. Three consequences worth
recording, because each was a choice rather than a consequence:

- **The re-derivation is shared, not repeated.** `withManagedContainer` parses the ids,
  re-reads the container list and refuses before any verb's own work runs. Four copies of
  "find the service, refuse an unmanaged one" would be four chances to write a subtly
  weaker one, and the weak copy is the one that ships. The callsite test asserts
  `!target.managed` appears exactly once in the actions module.
- **The deployment id is derived rather than posted.** Stop and restart need one, and it
  comes off the container Railway just described — not from the form. Otherwise the
  ownership check would guard the service while the mutation acted on an id the browser
  chose, which is the same hole one layer down.
- **Reversible actions confirm differently.** Destroy still costs a typed container name;
  stopping does not. Friction is priced in what it protects, and spending it on a
  reversible action is how people learn to type container names — which is the habit the
  destroy dialog depends on them not having.

## Amended by T-489: the marker is now something a user can edit

Editing joins the four, through the same `withManagedContainer` guard and with nothing new
to say about it. What is new is that one of the five verbs **changes the marker itself** —
renaming is part of editing, and the name is the whole of the ownership claim.

That could have been a validation rule: accept a name, refuse one that has lost the prefix.
It is not. The submitted name goes through `toManagedName`, which always prefixes, so a name
without `MANAGED_PREFIX` is not a request shape at all — there is no refusal path because
there is nothing that reaches one. A rule would have been a second place for this decision to
live and a first place for it to be got wrong.

It does sharpen the limit this ADR already states. A user could always forge the prefix in
Railway's dashboard; now they can also rename a container they own to any prefixed name they
like, from inside this app. Neither widens the blast radius — both are bounded by the OAuth
scopes they granted, and every mutation carries their own token — but "the set of names this
app claims" is now something it helps write rather than only reads, and `managed.test.ts`
pins that as deliberate.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
