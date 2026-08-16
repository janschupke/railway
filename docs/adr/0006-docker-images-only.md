# ADR-6 — Docker images only; GitHub sources are a stated limitation

**Status:** accepted · **Decided:** 2026-08-14

## Context

`serviceCreate` accepts `source.image` or `source.repo`, and a repo source is the more familiar
of the two for anyone who has used Railway directly.

## Decision

**Image sources only.** Repo sources silently require _the signed-in user's_ Railway account to
have the GitHub app installed with access to that repo — something this app cannot provision on
their behalf, and cannot even detect without asking for a scope it does not need for anything
else. A control that succeeds for the person who built it and fails silently for everyone else is
worse than an absent one.

Image sources work for anyone, so that is the product surface.

## Consequences

- **The preset catalog is the product.** Twelve images with known ports, known variables and
  known mount paths, in [src/lib/presets.ts](../../src/lib/presets.ts), plus any reference a user
  types.
- **No build ever runs**, so a failed deployment writes nothing to the build log phase — which is
  why a failed row carries an explanation and a deep link rather than empty output. See
  [Limitations](../limitations.md#failure-reasons).
- **A preset cannot need a command-line argument.** ~~Core NATS is offered and JetStream is
  not, for exactly that reason.~~ **Superseded.** The Advanced panel ships a **Start command**
  that Railway accepts and stores, so this consequence has been false since it did. The NATS
  exclusion stands on its real ground instead: JetStream needs somewhere to persist, and the
  catalog attaches a volume only to the six presets it knows keep state — an image given
  JetStream and no volume is a queue that silently loses what it was handed. That is a
  storage decision, not a command one.
- **Adding GitHub sources is a feature, not a configuration change** — it needs a path through
  the app-installation problem above, not just another source type in the form:
  [Limitations](../limitations.md#sources-and-registries).

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
