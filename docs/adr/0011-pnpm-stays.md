# ADR-11 — pnpm stays, and the migration was priced rather than assumed

This is a single package with no workspace. `pnpm-workspace.yaml` has no `packages:` list,
there are no `pnpm.overrides`, no `patchedDependencies`, no catalogs and no `.npmrc`. The
obvious question is why not npm, and the honest answer is that two things would be lost and
neither is replaceable.

**`allowBuilds` is a supply-chain control, not an install-speed tweak.** It is a per-package
allowlist of postinstall scripts:

```yaml
allowBuilds:
  "@parcel/watcher": false
  "@swc/core": false
  esbuild: true
  msw: true
  sharp: false
  unrs-resolver: false
```

Two packages may run install scripts here; four may not. npm's only equivalent is
`ignore-scripts`, which is all-or-nothing — so a migration either executes all six
postinstalls, including native compiles this app never uses, or none, which breaks `tsx`
and msw's service-worker asset. "Which third-party code may execute during install" is
exactly the kind of decision this repo writes down elsewhere; there is no reason to give it
up.

**`pnpm audit --prod` is the shape the CI gate depends on.** The three advisories open today
all sit under `@lhci/cli`, which never runs in a deployment. `--prod` re-evaluates
reachability on every run, so the gate stays honest without an ignore-list of advisory ids
that nobody revisits. npm spells it `--omit=dev`, which is a rename in the command and a
difference in the argument being made — an ignore-list decays, a reachability check does not.

**The rest is a rename, and that is the point.** `packageManager`, `pnpm exec`,
`--frozen-lockfile`, `pnpm <script>` all have direct npm equivalents. The migration is
roughly 140 occurrences across 29 files — six functional, twenty-three of them prose in this
file, `SECURITY.md`, `AGENTS.md` and all nine rule documents. That is a large documentation
change and a small config change, in exchange for losing a security control and weakening a
gate. Priced, and declined.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
