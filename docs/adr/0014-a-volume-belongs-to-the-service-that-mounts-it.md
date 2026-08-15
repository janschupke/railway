# ADR-14 — A volume belongs to the service that mounts it

**Status:** accepted · **Decided:** 2026-08-14

## Context

Six of the twelve presets keep state, and until T-491 every one of them was handed a generated
credential and then wrote to a container filesystem that is discarded whenever the container
moves. A user spun up postgres, put data in it, came back, and it was gone — with nothing anywhere
in the UI having said that would happen. T-491 named five; rabbitmq is the sixth, because it keeps
its durable queues and Mnesia schema on disk too.

So the stateful presets carry a mount path in the catalog and get a volume at create time. That
part is not the decision. The decision is what destroy does with it.

## Decision

### Railway does not cascade, so destroy has to ask

This was probed against the live API rather than assumed: create a service, attach a volume,
`serviceDelete`, read `environment.volumeInstances`. The volume survives, with a `serviceId` that
no longer resolves to anything.

That makes both available answers wrong on their own. Deleting only the service leaves billable
storage behind that **this app can never show again** — it lists containers, and an orphan volume
is not one — so the charge continues out of sight of the only UI that knew about it. Deleting both
silently makes destroy far more destructive than a dialog saying "the service and its deployment
history" implies: a deployment can be recreated, and the contents of a volume cannot.

**The dialog asks, with the box checked.** Checked because the volume was created by this app, as
a step of creating this container, and holds only what that container wrote — so the default is the
outcome that leaves nothing invisible behind. Asked, because the difference between the two
outcomes is the user's data and not this app's judgement. And whichever way it goes **the toast
names it**, including the case nobody chose: a kept volume says it is still billed and where to
remove it. Silence there would be the app declining to mention a charge it had caused.

### The ownership marker is the service, not the volume's name

[ADR-5](0005-the-app-only-destroys-what-it-created.md) makes the name prefix the ownership marker
because Railway services carry no arbitrary metadata. The obvious extension was to stamp `spun-`
onto the volume too — create it, then `volumeUpdate` its name.

Probing removed the need. `volumeCreate` already names a volume after the service it attaches to:
`spun-pg` gets `spun-pg-volume`. The prefix reaches the volume for free, it is visible in
Railway's own dashboard exactly as ADR-5 argues it should be, and the second mutation buys
nothing. `volumeUpdate` stays listed in `OPTIONAL_FIELDS` because that is a Railway behaviour
rather than a documented guarantee — if the auto-name changes, that is the call that would put the
prefix back.

But the name is a readability aid and **not** the gate. The gate is the service: this app creates
a volume only as a step of creating a service, and `withManagedContainer` has already re-derived
that service's ownership from Railway's own response before `volumeDelete` is reachable. Matching
on the volume's own name instead would be the same claim read through one more indirection, and
would make a volume undeletable from here the moment somebody renamed its service in Railway's
dashboard.

The client is trusted with none of it. The confirmation posts a boolean — `deleteData`, a field
named for the user's intent rather than for the mutation — and the volume id is read back from
Railway inside the action. A form that could name the volume to delete would be a form that could
name somebody else's.

## Consequences

**What the app still gets wrong, on purpose.** `environment.volumeInstances` lists a volume a few
seconds after `volumeCreate` returns (about three, measured; `project.volumes` sees it in under
one). A container destroyed inside that window has a volume the read cannot see, so the data is
kept. That is the conservative outcome and the toast states it, which is what makes it acceptable:
wrong and visible, rather than a silent orphan. Closing it properly would mean matching on
`project.volumes` by name, which is the weaker ownership claim this ADR just rejected.

The same reasoning makes `EnvironmentVolumes` safe to put in `DEGRADING_OPERATIONS`. A refused
read means no readout and no checkbox, which means no field posted, which means the data is kept
and said so. Every consequence of not knowing is the cautious one.

The remaining volume gaps — no size choice, no mount-path change, no backups — are in
[Limitations](../limitations.md#projects-environments-and-volumes).

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
