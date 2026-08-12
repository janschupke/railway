import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, generateNonce } from "./security-headers";

const production = (nonce = "n") =>
  contentSecurityPolicy(nonce, { https: true, dev: false });

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((d) => d === name || d.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();

describe("generateNonce", () => {
  it("is unpredictable and per-call", () => {
    // A reused nonce authorizes whatever an attacker manages to inject next.
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
  });

  it("survives the CSP grammar without quoting", () => {
    // getScriptNonceFromHeader matches /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/; a value
    // outside that alphabet parses as no nonce at all, silently.
    for (let i = 0; i < 50; i++) {
      expect(generateNonce()).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
  });
});

describe("contentSecurityPolicy", () => {
  it("authorizes scripts by nonce and origin, never inline", () => {
    const script = directive(production("abc123"), "script-src");

    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'self'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("omits strict-dynamic, which would break Turbopack's chunk loader", () => {
    // 'strict-dynamic' disables the 'self' host-source, and Next's runtime injects
    // <script src="/_next/static/…"> without propagating a nonce.
    expect(production()).not.toContain("strict-dynamic");
  });

  it("allows inline styles, which no nonce can cover", () => {
    /*
     * Deliberate and unavoidable: `style=` attributes are governed by style-src-attr,
     * which has no nonce concept, and Radix writes them onto popper content. This is a
     * CSS-exfiltration concession, not a code-execution one — see the module comment.
     */
    expect(directive(production(), "style-src")).toContain("'unsafe-inline'");
  });

  it("locks down the directives that stop this page being framed or repointed", () => {
    const policy = production();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  it("keeps connect-src to same-origin in production", () => {
    // The only browser-initiated request is the EventSource; Railway is server-to-server.
    expect(directive(production(), "connect-src")).toBe("'self'");
  });

  it("upgrades insecure requests only when served over https", () => {
    expect(production()).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("n", { https: false, dev: true })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("relaxes only what the dev server needs, and only in dev", () => {
    const dev = contentSecurityPolicy("n", { https: false, dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
  });

  it("never names a directive that shadows script-src", () => {
    /*
     * Next finds the nonce with `directives.find(d => d.startsWith("script-src"))`, so
     * a `script-src-elem` placed earlier would be matched instead and the real nonce
     * would never reach the injected scripts. Nothing else would look wrong.
     */
    const names = production()
      .split("; ")
      .map((d) => d.split(" ")[0]);
    const shadowing = names.filter(
      (name) => name!.startsWith("script-src") && name !== "script-src",
    );
    expect(shadowing).toEqual([]);
    expect(names.indexOf("script-src")).toBeGreaterThan(-1);
  });
});
