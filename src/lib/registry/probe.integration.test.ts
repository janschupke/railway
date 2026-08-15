import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { REGISTRY } from "@/lib/constants";
import { __resetEnv } from "@/env";
import { __resetRegistryCache } from "./answer-cache";
import { checkImage } from "./probe";

const ORIGINAL = { ...process.env };
const server = setupServer();

/*
 * `onUnhandledRequest: "error"` is what turns "no request was made" from a claim into an
 * assertion. Every case below that matters — the allowlist refusal, the cache hit, the
 * cool-off — is proved by the absence of a handler rather than by a spy.
 */
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  process.env.RAILWAY_CLIENT_ID = "id";
  process.env.RAILWAY_CLIENT_SECRET = "secret";
  process.env.SESSION_SECRET = "a-session-secret-of-at-least-32-chars";
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.REGISTRY_PROBE_URL;
  __resetEnv();
  __resetRegistryCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  __resetEnv();
});

const HUB_TOKEN = "https://auth.docker.io/token";
const HUB = "https://registry-1.docker.io/v2/:owner/:name/manifests/:ref";
const GHCR_TOKEN = "https://ghcr.io/token";
const GHCR = "https://ghcr.io/v2/:owner/:name/manifests/:ref";
const QUAY_TOKEN = "https://quay.io/v2/auth";
const QUAY = "https://quay.io/v2/:owner/:name/manifests/:ref";

const token = (url: string) =>
  http.get(url, () => HttpResponse.json({ token: "anonymous" }));

describe("checkImage", () => {
  it("reports an image the registry will show us", async () => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () => new HttpResponse(null, { status: 200 })),
    );
    await expect(checkImage("redis:7-alpine")).resolves.toMatchObject({
      status: "available",
      registry: "docker.io",
    });
  });

  it("asks for the manifest with HEAD, not GET", async () => {
    /*
     * The measurement this whole feature rests on: a HEAD leaves Docker Hub's anonymous
     * pull budget untouched (ratelimit-remaining held at 100;w=3600 across two of them)
     * while a GET decrements it. A refactor that reached for GET would cost a pull per
     * keystroke against an IP every user of a deployed instance shares, which is the
     * exact failure docs/limitations.md argues this feature could not avoid.
     */
    const methods: string[] = [];
    server.use(
      token(HUB_TOKEN),
      http.all(HUB, ({ request }) => {
        methods.push(request.method);
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await checkImage("redis:7-alpine");
    expect(methods).toEqual(["HEAD"]);
  });

  it("sends the list media types, without which a multi-arch image reads as missing", async () => {
    let accept = "";
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, ({ request }) => {
        accept = request.headers.get("accept") ?? "";
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await checkImage("redis:7-alpine");
    expect(accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(accept).toContain(
      "application/vnd.docker.distribution.manifest.list.v2+json",
    );
  });

  it("scopes the token to the repository it is about to read", async () => {
    let scope: string | null = null;
    let service: string | null = null;
    server.use(
      http.get(HUB_TOKEN, ({ request }) => {
        const url = new URL(request.url);
        scope = url.searchParams.get("scope");
        service = url.searchParams.get("service");
        return HttpResponse.json({ token: "anonymous" });
      }),
      http.head(HUB, () => new HttpResponse(null, { status: 200 })),
    );
    await checkImage("traefik/whoami");
    expect(scope).toBe("repository:traefik/whoami:pull");
    expect(service).toBe("registry.docker.io");
  });

  it("prefixes library/ for an official image, as Docker Hub requires", async () => {
    let path = "";
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, ({ request }) => {
        path = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await checkImage("redis");
    expect(path).toBe("/v2/library/redis/manifests/latest");
  });

  it("reports a tag the registry does not have", async () => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () => new HttpResponse(null, { status: 404 })),
    );
    await expect(checkImage("redis:nope-xyz")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  /*
   * The ticket's own example, and the case a naive mapping loses.
   *
   * Docker Hub issues a token for any scope — with an empty `access` claim — and then
   * refuses the manifest with 401 `insufficient_scope`. So "no such repository" and
   * "private repository" are one answer, verified against the live API. Treating 401 as
   * `unknown` would have made `nonexistent/image:tag` render nothing at all, which is the
   * whole thing this feature exists to catch.
   */
  it("reports a repository it is not allowed to see, which is also how absent looks", async () => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () => new HttpResponse(null, { status: 401 })),
    );
    await expect(checkImage("nonexistent/image:tag")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("treats a 403 at the manifest the same way", async () => {
    server.use(
      token(QUAY_TOKEN),
      http.head(QUAY, () => new HttpResponse(null, { status: 403 })),
    );
    await expect(checkImage("quay.io/owner/app")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  /*
   * ghcr.io refuses at the token endpoint rather than the manifest — 403 DENIED — so a
   * nonexistent package never reaches a manifest request at all. Verified live. Without
   * this branch the token failure would read as an outage and say nothing.
   */
  it("reports a ghcr package refused at the token endpoint, with no manifest request", async () => {
    server.use(
      http.get(GHCR_TOKEN, () =>
        HttpResponse.json({ errors: [{ code: "DENIED" }] }, { status: 403 }),
      ),
    );
    await expect(checkImage("ghcr.io/nonexistent/imagexyz")).resolves.toMatchObject({
      status: "unavailable",
      registry: "ghcr.io",
    });
  });

  it("reads a ghcr package it is allowed to see", async () => {
    server.use(
      token(GHCR_TOKEN),
      http.head(GHCR, () => new HttpResponse(null, { status: 200 })),
    );
    await expect(checkImage("ghcr.io/astral-sh/uv:latest")).resolves.toMatchObject({
      status: "available",
    });
  });

  it.each([
    ["a server error", 500],
    ["a bad gateway", 502],
    ["an unexpected status", 418],
  ])("says nothing about %s", async (_label, status) => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () => new HttpResponse(null, { status })),
    );
    await expect(checkImage("owner/app")).resolves.toMatchObject({ status: "unknown" });
  });

  /*
   * The one place a registry could still choose a URL for this app, and it does not get to.
   * A manifest HEAD has no legitimate reason to redirect — blob GETs do, and none are made
   * — so a `location` is an instruction to fetch somewhere nobody allowlisted. Not
   * followed, not read, and the bearer token is never re-sent off-origin.
   */
  it("does not follow a redirect, whatever it points at", async () => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () =>
        HttpResponse.redirect("http://169.254.169.254/latest/meta-data/", 302),
      ),
    );
    await expect(checkImage("owner/app")).resolves.toMatchObject({ status: "unknown" });
  });

  it("says nothing when the token endpoint fails", async () => {
    server.use(http.get(HUB_TOKEN, () => new HttpResponse(null, { status: 500 })));
    await expect(checkImage("owner/app")).resolves.toMatchObject({ status: "unknown" });
  });

  it("says nothing when the token response carries no token", async () => {
    server.use(http.get(HUB_TOKEN, () => HttpResponse.json({ nope: true })));
    await expect(checkImage("owner/app")).resolves.toMatchObject({ status: "unknown" });
  });

  it("says nothing when the registry cannot be reached at all", async () => {
    server.use(http.get(HUB_TOKEN, () => HttpResponse.error()));
    await expect(checkImage("owner/app")).resolves.toMatchObject({ status: "unknown" });
  });

  describe("the allowlist", () => {
    /*
     * No handlers are registered for any of these, so `onUnhandledRequest: "error"` fails
     * the test if a single byte leaves. That is the assertion: the SSRF docs/limitations.md refuses
     * to create is refused by never dereferencing the host, not by inspecting it.
     */
    it.each([
      ["cloud metadata", "169.254.169.254/foo/bar"],
      ["an unlisted registry", "registry.example.com/owner/app"],
      ["a lookalike host", "ghcr.io.evil.example/owner/app"],
    ])("refuses %s without a request", async (_label, image) => {
      await expect(checkImage(image)).resolves.toMatchObject({
        status: "unsupported",
        registry: "other",
      });
    });

    it("refuses a reference it cannot parse without a request", async () => {
      await expect(checkImage("Owner/App")).resolves.toMatchObject({
        status: "unsupported",
        registry: "none",
      });
    });
  });

  describe("the answer cache", () => {
    it("answers a repeated reference without asking again", async () => {
      server.use(
        token(HUB_TOKEN),
        http.head(HUB, () => new HttpResponse(null, { status: 404 })),
      );
      await expect(checkImage("owner/app:1")).resolves.toMatchObject({ cached: false });

      server.resetHandlers();
      await expect(checkImage("owner/app:1")).resolves.toMatchObject({
        status: "unavailable",
        cached: true,
      });
    });

    it("keys on the normalized reference, so two spellings are one entry", async () => {
      server.use(
        token(HUB_TOKEN),
        http.head(HUB, () => new HttpResponse(null, { status: 200 })),
      );
      await checkImage("redis:latest");

      server.resetHandlers();
      // `redis`, `library/redis` and `docker.io/library/redis:latest` are the same image.
      await expect(checkImage("docker.io/library/redis")).resolves.toMatchObject({
        status: "available",
        cached: true,
      });
    });

    it("holds a real answer far longer than an outage", async () => {
      vi.useFakeTimers();
      try {
        server.use(
          token(HUB_TOKEN),
          http.head(HUB, () => new HttpResponse(null, { status: 200 })),
        );
        await checkImage("owner/good");

        server.use(http.get(HUB_TOKEN, () => new HttpResponse(null, { status: 500 })));
        await checkImage("owner/bad");

        // Past the outage TTL, inside the answer TTL.
        vi.advanceTimersByTime(REGISTRY.UNKNOWN_TTL_MS + 1);
        server.resetHandlers();

        await expect(checkImage("owner/good")).resolves.toMatchObject({ cached: true });
        // The unknown has expired, so this one has to ask — and there is no handler.
        await expect(checkImage("owner/bad")).resolves.toMatchObject({
          status: "unknown",
          cached: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("expires a real answer eventually", async () => {
      vi.useFakeTimers();
      try {
        server.use(
          token(HUB_TOKEN),
          http.head(HUB, () => new HttpResponse(null, { status: 200 })),
        );
        await checkImage("owner/app");
        vi.advanceTimersByTime(REGISTRY.ANSWER_TTL_MS + 1);
        await expect(checkImage("owner/app")).resolves.toMatchObject({ cached: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("evicts the oldest entry rather than growing without a ceiling", async () => {
      server.use(
        token(HUB_TOKEN),
        http.head(HUB, () => new HttpResponse(null, { status: 200 })),
      );

      // The key is a form field, so an unbounded map here is reachable from the browser.
      await checkImage("owner/first");
      for (let i = 0; i < REGISTRY.CACHE_MAX_ENTRIES; i += 1) {
        await checkImage(`owner/fill${i}`);
      }

      server.resetHandlers();
      await expect(checkImage("owner/first")).resolves.toMatchObject({
        status: "unknown",
        cached: false,
      });
    });
  });

  describe("the rate-limit cool-off", () => {
    it("stops asking a registry that answered 429, for every reference on it", async () => {
      server.use(
        token(HUB_TOKEN),
        http.head(HUB, () => new HttpResponse(null, { status: 429 })),
      );
      await expect(checkImage("owner/one")).resolves.toMatchObject({
        status: "unknown",
      });

      // A different reference, so the answer cache cannot be what answers it.
      server.resetHandlers();
      await expect(checkImage("owner/two")).resolves.toMatchObject({
        status: "unknown",
        cached: false,
      });
    });

    it("leaves the other registries alone", async () => {
      server.use(
        token(HUB_TOKEN),
        http.head(HUB, () => new HttpResponse(null, { status: 429 })),
        token(GHCR_TOKEN),
        http.head(GHCR, () => new HttpResponse(null, { status: 200 })),
      );
      await checkImage("owner/one");
      await expect(checkImage("ghcr.io/owner/app")).resolves.toMatchObject({
        status: "available",
      });
    });

    it("tries again once the cool-off is over", async () => {
      vi.useFakeTimers();
      try {
        server.use(
          token(HUB_TOKEN),
          http.head(HUB, () => new HttpResponse(null, { status: 429 })),
        );
        await checkImage("owner/one");

        vi.advanceTimersByTime(REGISTRY.COOLOFF_MS + 1);
        server.resetHandlers();
        server.use(
          token(HUB_TOKEN),
          http.head(HUB, () => new HttpResponse(null, { status: 200 })),
        );
        await expect(checkImage("owner/two")).resolves.toMatchObject({
          status: "available",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("gives up rather than hanging when the caller does", async () => {
    server.use(
      token(HUB_TOKEN),
      http.head(HUB, () => new HttpResponse(null, { status: 200 })),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(checkImage("owner/app", controller.signal)).resolves.toMatchObject({
      status: "unknown",
    });

    /*
     * And it is not cached. An abort is the browser hanging up, not an answer about the
     * image — caching it would hold `unknown` over a reference nobody ever got a verdict
     * on, for the whole outage TTL.
     */
    await expect(checkImage("owner/app")).resolves.toMatchObject({
      status: "available",
      cached: false,
    });
  });

  it("sends its requests to the fixture when the E2E override is set", async () => {
    process.env.REGISTRY_PROBE_URL = "http://localhost:4010";
    __resetEnv();

    server.use(
      http.get("http://localhost:4010/token", () =>
        HttpResponse.json({ token: "anonymous" }),
      ),
      http.head(
        "http://localhost:4010/v2/:owner/:name/manifests/:ref",
        () => new HttpResponse(null, { status: 200 }),
      ),
    );

    await expect(checkImage("ghcr.io/owner/app")).resolves.toMatchObject({
      status: "available",
    });
  });
});
