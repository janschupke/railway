# syntax=docker/dockerfile:1

# The build, pinned end to end.
#
# This replaced NIXPACKS because of one failure that two attempts at configuring the
# builder could not reach. Nixpacks resolves `pnpm` to the corepack shim inside its Node
# derivation; corepack reads `packageManager` from package.json, downloads pnpm 11.9.0,
# and runs its entry point through `Module._compile`. pnpm 11 ships an ESM binary with a
# three-line CJS shim whose only statement is `import('./pnpm.mjs')`, and a corepack older
# than 0.25 compiles that shim without a dynamic-import callback:
#
#   TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]
#       at .../corepack/pnpm/11.9.0/bin/pnpm.cjs:3:1
#       at Module2._compile (.../corepack/dist/lib/corepack.cjs)
#
# The version of corepack is the whole cause, and it belongs to the base image rather than
# to anything in this repository — which is why declaring `engines.node` moved the Node in
# the trace from 18.20.5 to 22.14.0 and changed nothing else. Reproduced by version:
# corepack 0.20.0 and 0.24.1 fail exactly this way and cache to `corepack/pnpm/11.9.0`,
# which is the path the deploy log printed; 0.31.0 and later succeed and cache to
# `corepack/v1/pnpm/11.9.0`, which it did not.
#
# So corepack is not upgraded here, it is removed from the path entirely: pnpm is
# installed from npm at the version package.json pins, and nothing consults
# `packageManager` at all. `engines.node` still exists — pnpm and Next both read it — but
# the deployed Node is now the FROM line, which is a version this file states rather than
# one a builder infers.

FROM node:22.14.0-alpine AS base
# Pinned to the same version as `packageManager`, and asserted equal to it by
# src/toolchain.test.ts — two literals that must agree, in a repo where nothing else
# would notice if they stopped.
RUN npm install --global --no-fund --no-audit pnpm@11.9.0
WORKDIR /app


# Dependencies, in their own stage so the layer survives a source-only change.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --frozen-lockfile so a lockfile that disagrees with package.json fails the build rather
# than being quietly resolved into something no one has run tests against.
RUN pnpm install --frozen-lockfile


FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# src/env.ts validates at import and `next build` imports it while collecting page data,
# so the build needs values for these four. It does not need real ones, and here it cannot
# have them: they are set inline on this one command rather than as ARG or ENV, so no
# value is overridable from outside and none is recorded in any layer's configuration.
#
# That is the same rule ci.yml states at workflow level — "the build and the E2E fixture
# must not need real credentials, and if the env schema starts demanding them that is a
# legitimate CI failure" — enforced here rather than restated. A build that starts needing
# a real secret now fails loudly at this line instead of quietly baking one into an image.
#
# Nothing about them survives into the runtime stage, which copies only .next, the
# production node_modules and three files, and reads its own environment at startup.
# APP_URL in particular is a placeholder and stays one: in production it is derived from
# Railway's injected RAILWAY_PUBLIC_DOMAIN per request (see inferredAppUrl in src/env.ts).
RUN RAILWAY_CLIENT_ID=build-placeholder \
    RAILWAY_CLIENT_SECRET=build-placeholder \
    SESSION_SECRET=build-placeholder-at-least-32-characters \
    APP_URL=http://localhost:3000 \
    pnpm build
# The same gate the CI build job runs, in the place that produces the artefact being
# measured. A route that grew past its budget should not reach a deployment.
RUN pnpm size

# 76 MB of Turbopack's incremental build cache, which `next start` never opens. Removed
# here rather than in the runner: a COPY that brings it in and a RUN that deletes it leave
# it sitting in the layer underneath, which is the whole trap with trimming an image.
# `pnpm size` runs first — it reads .next/diagnostics, so the order is not arbitrary.
RUN rm -rf .next/cache


# Production dependencies only, resolved from the same lockfile as the build's.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod


FROM node:22.14.0-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Next writes a telemetry notice on first run and phones home from a build server that
# has no one to read it.
ENV NEXT_TELEMETRY_DISABLED=1

# `next start` is a Node process, so it needs no shell, no package manager and no build
# toolchain. pnpm is deliberately not installed in this stage — see CMD.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/package.json ./package.json
# next-intl resolves the catalog with a runtime `import()` of ../../messages/<locale>.json
# (src/i18n/request.ts), so the file is read from disk on every render rather than bundled.
# Without this the app builds, starts, serves a health check, and 500s on the first page.
COPY --from=build /app/messages ./messages

# Not root. Alpine's node image ships a `node` user; the app writes nothing, so read-only
# ownership is all it needs.
USER node

EXPOSE 3000

# Railway sets PORT and `next start` reads it — measured, with PORT=8080 answering on
# 8080. 3000 is the fallback for a plain `docker run`.
#
# Deliberately no HOSTNAME. The usual Next Docker recipe sets it, and `next start` does
# not read it: with HOSTNAME=127.0.0.1 this container still listens on `:::3000`. Only
# Next's standalone `server.js` consults it, and this image does not use standalone output.
# `::` is the IPv6 wildcard bound dual-stack — `ipv6Only` is false by default — so it takes
# IPv4 connections too, which is what a platform routing over either will find.
ENV PORT=3000

# `next start` directly rather than `pnpm start`. Going through pnpm would mean installing
# a package manager into the runtime image to read one line of package.json, and it would
# put a process between the container and the signal that stops it.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
