# ADR-12 — Idempotency keys on create, and a repeat is replayed rather than rejected

**Status:** accepted · **Decided:** 2026-08-14

## Context

Spin-up creates billable infrastructure, so a form posted twice must not create two containers.
The cheap guard is a name lookup: read the whole container list before every create and refuse a
name already present.

That guard concedes the problem in its own comment — "checking first is not airtight (nothing
short of a lock is)" — because two submissions a millisecond apart both read a list without the
name in it, and both proceed. It also makes one spin-up four Railway round trips against a rate
limit measured in the low thousands per hour.

## Decision

**The form mints a key per submission and sends it.** The server runs the create at most once per
`userId:key`: the entry is inserted before the attempt, so a second submission finds it rather
than a stale list.

**A repeat is replayed, not refused.** The obvious shape — return "you already submitted this" —
is wrong here, because from the user's side the two cases are indistinguishable. Somebody who
double-clicked and somebody whose first response was lost both pressed the button twice, and both
have a container. An error would be a false statement about infrastructure that exists, and on
the two branches that create a service and then fail it would withhold the only sentence naming
the orphan they are being told to destroy.

So the second caller is handed the first caller's answer: it awaits the same attempt if one is in
flight, and reads the retained result if not. The only thing that distinguishes it is a
`container.create_replayed` audit line, and its own `revalidatePath` — revalidation attaches to
the request that responds, so the replayed caller has had none.

**Retention is the caller's judgement, not the store's.** A result is retained only when a service
exists on Railway. That is not something the store can work out — it holds an opaque value — and it
cannot be inferred from success either, since two of the three retained outcomes are failures with
a service behind them.

The inverse matters more: a create Railway refused has to release the key immediately. The form
deliberately keeps its key after a failure so that pressing the button again is the same
submission, and caching that refusal would turn one blip into a form that will not work for the
whole window. This is the rule `grants` in `lib/auth/refresh.ts` already follows for a different
resource, applied here for the same reason.

**In memory with a TTL, not a database.** [ADR-4](0004-no-database.md) says Railway holds the
state and this app stores none of it, and that still holds: a five-minute map of "which submission
produced which answer" is request bookkeeping, not persistence. There is nothing here a database
would be asked to survive.

## Consequences

- **The map is per replica**, so a deploy landing between the two halves of a double submit
  creates two services, and a repeat after `IDEMPOTENCY.RETAIN_SECONDS` does too. Both are much
  narrower than the window a name check leaves open. The stream cap in `lib/stream-slots.ts` is
  per replica for the same reason, and the single-replica constraint behind both is argued in
  [Limitations](../limitations.md#single-replica-and-the-state-that-says-so). If it changes, both
  maps move to shared state together.
- **The duplicate-name message lives in the browser**, checked against the list the page has
  already fetched. It is stale by construction and it is a typo guard rather than a lock, but it
  costs no round trip.
- **`spinDown`'s ownership re-derivation is untouched**: it is a real safety property, and
  [ADR-5](0005-the-app-only-destroys-what-it-created.md) says why.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
