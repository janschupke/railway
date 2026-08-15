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
- **A preset cannot need a command-line argument.** Core NATS is offered and JetStream is not,
  for exactly that reason.
- **This is the entry the limitations list opens with**, and closing it is a real feature rather
  than a line of code: [Limitations](../limitations.md#sources-and-registries).

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
