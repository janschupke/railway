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

# Pinned by digest as well as by tag. A tag is a pointer its owner can move, so
# `node:22.23.2-alpine` alone means "whatever that repository publishes under that name
# next" — the same mutable-reference shape the actions in ci.yml were pinned out of. The
# digest is what the CI image scan actually measured; the tag is kept so the line still
# reads as a version. src/toolchain.test.ts holds both FROM lines to the same reference,
# because a build stage and a runtime stage on different base images is a difference
# nothing else here would notice. Dependabot's `docker` ecosystem bumps it.
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
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
# Nothing about them survives into the runtime stage, which copies one directory and reads
# its own environment at startup. APP_URL in particular is a placeholder and stays one: in
# production it is derived from Railway's injected RAILWAY_PUBLIC_DOMAIN per request (see
# inferredAppUrl in src/env.ts).
#
# `pnpm build` also runs `postbuild` — scripts/pack-standalone.ts — which copies
# .next/static into .next/standalone and refuses to finish if the message catalog was not
# traced. Both are silent failures at build time and page-shaped ones at run time.
RUN RAILWAY_CLIENT_ID=build-placeholder \
    RAILWAY_CLIENT_SECRET=build-placeholder \
    SESSION_SECRET=build-placeholder-at-least-32-characters \
    APP_URL=http://localhost:3000 \
    pnpm build
# The same gate the CI build job runs, in the place that produces the artefact being
# measured. A route that grew past its budget should not reach a deployment.
RUN pnpm size

# No stage installing production dependencies. There used to be one, and it was the largest
# thing in the image by an order of magnitude: 480 MB of node_modules against 4.6 MB of
# compiled app. `output: "standalone"` traces what the server actually reaches instead, and
# the answer is 38 MB.
#
# The gap was not waste in the usual sense. pnpm resolves optional peer dependencies at
# lockfile time and writes them into the resolved package's identity —
# `next@16.3.0(@babel/core@7.29.7)(@playwright/test@1.62.1)(@types/node@20.19.43)…` — so
# `pnpm install --prod` could not remove them: it prunes root devDependencies, and these
# were part of the name of a production one. Playwright, TypeScript, `@types/node` and the
# whole Babel closure shipped to production because they are devDependencies of the same
# package.json. Tracing asks what the code imports, and none of them answer.
#
# .next/cache is not deleted here any more either. It never enters the image: the runtime
# stage copies .next/standalone, and the build cache is not in it.


FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
WORKDIR /app

ENV NODE_ENV=production
# Next writes a telemetry notice on first run and phones home from a build server that
# has no one to read it.
ENV NEXT_TELEMETRY_DISABLED=1

# Railway injects RAILWAY_GIT_COMMIT_SHA and src/lib/logger.ts reads it at runtime, emitting
# the first seven characters as `version` on every log line. Declaring it here puts the same
# commit on the image itself, which is the only place a deployed artefact can say what
# produced it — a log line tells you what a running process thinks it is, a label tells you
# what the thing on disk actually is.
#
# It defaults to empty, so `docker build .` on a laptop works unchanged and a builder that
# does not pass the variable produces an empty label rather than a failure. This is not a
# credential and the ban in src/toolchain.test.ts is scoped to the ones that are.
ARG RAILWAY_GIT_COMMIT_SHA=""
LABEL org.opencontainers.image.title="Railway Freight Loader" \
      org.opencontainers.image.description="Create and destroy Docker-image services in your own Railway account, with live build and deploy logs." \
      org.opencontainers.image.source="https://github.com/janschupke/railway" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${RAILWAY_GIT_COMMIT_SHA}"

# The standalone server is a Node process, so it needs no shell, no package manager and no
# build toolchain. pnpm is deliberately not installed in this stage — see CMD.
#
# npm, corepack and yarn are here for a different reason: the base image ships all three,
# this file does not ask for any of them, and the app invokes none of them. They are the
# same unwanted thing, so they go too.
#
# That is not housekeeping. Every finding the CI image scan reports against this image
# without this line sits inside npm's own bundled dependency tree — tar, brace-expansion,
# sigstore, picomatch — which nothing in this repository can upgrade and which the node
# images carry until their next rebuild. Eight HIGH and CRITICAL findings, in a package that
# never runs. Removing it is what lets that scan gate on zero rather than on a permanently
# amber baseline nobody reads. yarn 1.22 is end-of-life and will eventually earn the same
# treatment with no upgrade available at all.
#
# corepack goes for the reason at the top of this file. It is the whole cause of the failure
# that replaced NIXPACKS, and leaving it one PATH lookup away from a deployment while the
# header claims it was removed from the path entirely is the kind of gap that gets found
# during an incident.
#
# This is not a size measure, and it is the exact trap the .next/cache comment above
# describes, arriving from the other direction: these files are in the base image's layer,
# so removing them here writes whiteouts and leaves the bytes underneath. Measured, the RUN
# adds 28.7 kB and removes nothing. What changes is what the filesystem presents and what a
# scanner walking it finds, which is the entire point — the layer cannot be trimmed without
# building the base image, and nothing here is going to do that.
#
# The yarn directory is version-stamped, so the glob is the part that survives a base image
# bump; `docker run --rm <image> sh -c 'ls /usr/local/bin'` is how to check after one.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# One directory, and everything in it was put there by the trace rather than by a list kept
# here. It carries server.js, the traced node_modules, the compiled routes, package.json,
# .next/static (copied in by postbuild) and messages/ (pulled in by
# outputFileTracingIncludes, since src/i18n/request.ts imports the catalog with a template
# literal that static analysis cannot follow).
#
# next.config.ts is deliberately not copied. `next start` read it at every boot and compiled
# it, which is why this image used to need a native SWC binary; standalone inlines the
# resolved config into server.js, and headers() is already baked into
# .next/routes-manifest.json at build time.
COPY --from=build /app/.next/standalone ./

# Not root. Alpine's node image ships a `node` user; the app writes nothing, so read-only
# ownership is all it needs.
USER node

EXPOSE 3000

# Railway sets PORT and the standalone server reads it — `parseInt(process.env.PORT, 10) ||
# 3000`. 3000 is the fallback for a plain `docker run`.
#
# Still deliberately no HOSTNAME, but for the opposite reason to the one that used to be
# written here. This image now does use standalone output, and server.js does consult
# HOSTNAME — with a default of `0.0.0.0`, so it already binds every interface. Setting it
# could only narrow that. The usual Next Docker recipe sets `HOSTNAME=0.0.0.0` to restate
# the default; earlier Next versions defaulted to localhost, which is where that line comes
# from and why it is not needed here.
ENV PORT=3000

# server.js, which the build traced and wrote. `pnpm start` would mean installing a package
# manager into the runtime image to read one line of package.json, and it would put a
# process between the container and the signal that stops it.
#
# server.js does `process.chdir(__dirname)` before listening, so relative reads — the
# message catalog among them — resolve against /app rather than wherever the process
# started.
CMD ["node", "server.js"]
