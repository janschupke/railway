/**
 * The Content-Security-Policy, built per request so it can carry a nonce.
 *
 * Kept out of proxy.ts so the directive set can be asserted on its own — a policy that
 * is only ever exercised through a browser is a policy nobody dares change.
 */

/** 128 bits, base64. Per request: a reused nonce authorizes an injected script. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(
  nonce: string,
  { https, dev }: { https: boolean; dev: boolean },
): string {
  /*
   * script-src: 'self' plus a nonce, and deliberately no 'strict-dynamic'.
   *
   * 'strict-dynamic' would *disable* the 'self' host-source, and Turbopack's client
   * runtime loads route chunks by injecting <script src="/_next/static/…"> without
   * propagating a nonce — so it would break navigation, silently, only in production.
   *
   * The inline theme script in layout.tsx carries this nonce explicitly. React 19 does
   * not auto-nonce an author-written dangerouslySetInnerHTML script; its nonce option
   * covers only Next's own bootstrap and hoisted resources.
   */
  const script = ["'self'", `'nonce-${nonce}'`];
  // Turbopack's dev runtime and react-refresh evaluate generated code.
  if (dev) script.push("'unsafe-eval'");

  /*
   * style-src has to allow inline, for two independent reasons that are worth knowing
   * before anyone tries to tighten it:
   *
   *   1. A nonce cannot authorize a `style=` attribute — those are governed by
   *      style-src-attr, which has no nonce concept at all — and Radix writes inline
   *      styles onto popper content and Select's viewport and scroll buttons. Without
   *      this, Select, Tooltip and AlertDialog render at 0,0.
   *   2. Opening a dialog makes react-remove-scroll inject a <style> element at
   *      runtime, and its nonce hook is not reachable through Radix's public API.
   *
   * This is a materially weaker concession than script-src 'unsafe-inline': it enables
   * CSS-based exfiltration, not code execution.
   */
  const style = ["'self'", "'unsafe-inline'"];

  // Same-origin EventSource is the only network call the browser makes; the Railway
  // GraphQL and WebSocket connections are server-to-server and outside CSP entirely.
  const connect = ["'self'"];
  if (dev) connect.push("ws:", "wss:");

  const img = ["'self'", "data:"];
  if (dev) img.push("blob:");

  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `style-src ${style.join(" ")}`,
    `img-src ${img.join(" ")}`,
    // next/font self-hosts every woff2 under /_next/static/media.
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // The only form POST is sign-out. Sign-in is a link, which this does not govern.
    "form-action 'self'",
  ];

  if (https) directives.push("upgrade-insecure-requests");

  return directives.join("; ");
}
