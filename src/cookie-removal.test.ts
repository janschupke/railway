import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearCookie, cookieOptions } from "@/lib/auth/session";
import { originFromUrl } from "@/lib/origin";

/** A validated origin, minted the only way there is. See session.test.ts for why. */
const servedAt = (url: string) => originFromUrl(url)!;

/**
 * Nothing may remove a cookie the browser will keep, in any jar.
 *
 * Next's `delete` emits `name=; Path=/; Expires=1970` and no `Secure`. A cookie whose
 * name carries the `__Host-` prefix — which every cookie this app sets does, on any https
 * origin — is rejected outright unless it is `Secure`, `Path=/` and has no `Domain`. So
 * the browser discards the removal and keeps the cookie.
 *
 * That is why Sign out did not sign anyone out in production: the session cookie
 * survived, the redirect to `/` found it, and `/` sent the user back to the dashboard
 * they had just left. The same silent failure applied to the PKCE, state and consent
 * cookies, so a sign-in's transients outlived it by their full half hour.
 *
 * Neither development nor the end-to-end suite can see it. Both run on `http://localhost`,
 * where `hostCookieName` returns unprefixed names and a plain delete works — which is
 * exactly the shape of defect a structural test is for, and why 130 e2e specs passed
 * across the whole time this was broken.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

/**
 * Any jar that writes to the response, whatever the variable holding it is called.
 *
 * `request.cookies.delete` is deliberately allowed and is a different operation: it edits
 * the inbound request object so the headers forwarded to the render no longer carry a
 * cookie this layer has just invalidated. It sends nothing to the browser. That exemption
 * is spelled `request.` and nothing else — a scanner that accepted `req.` or any other
 * alias would be one rename away from letting a real removal through, and the one live
 * use (src/proxy.ts) writes it in full.
 *
 * No `g` flag on either: a global regex carries lastIndex between `.test()` calls, so it
 * would report every other file as clean.
 */
const RESPONSE_JAR_DELETE = /(?<!\brequest)\.cookies\.delete\s*\(/;

/**
 * The `next/headers` jar, taken and deleted from in one expression.
 *
 * `cookies()` is read-only in a Server Component but is the *response* jar inside a Server
 * Action or Route Handler, so a delete on it reaches the browser with the same missing
 * `Secure` and meets the same rejection.
 */
const HEADERS_JAR_DELETE = /cookies\s*\(\s*\)\s*\)?\s*\.delete\s*\(/;

/** The same jar held in a variable first — `const jar = await cookies()`. */
const HEADERS_JAR_ALIAS = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+cookies\s*\(/g;

/** Block and line comments removed, so only code is scanned. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function removesACookieUnsafely(source: string): boolean {
  const code = withoutComments(source);
  if (RESPONSE_JAR_DELETE.test(code) || HEADERS_JAR_DELETE.test(code)) return true;

  return [...code.matchAll(HEADERS_JAR_ALIAS)].some((match) =>
    new RegExp(`\\b${match[1]}\\.delete\\s*\\(`).test(code),
  );
}

describe("cookie removal", () => {
  it("writes a removal the browser will accept, with the attributes it was set with", () => {
    const written: unknown[] = [];
    clearCookie(
      { set: (name, value, options) => void written.push({ name, value, options }) },
      "__Host-rc_session",
      servedAt("https://example.up.railway.app"),
    );

    expect(written).toEqual([
      {
        name: "__Host-rc_session",
        value: "",
        // Every attribute the prefix requires, plus the expiry that does the removing.
        options: {
          ...cookieOptions(servedAt("https://example.up.railway.app")),
          maxAge: 0,
        },
      },
    ]);
    expect((written[0] as { options: { secure: boolean } }).options.secure).toBe(true);
  });

  it("leaves an http origin's cookie alone about Secure, which it cannot have", () => {
    const written: { secure: boolean }[] = [];
    clearCookie(
      { set: (_n, _v, options) => void written.push(options) },
      "rc_session",
      servedAt("http://localhost:3100"),
    );

    expect(written[0]!.secure).toBe(false);
  });

  it("deletes a cookie from no jar anywhere in src", () => {
    // Comments are stripped inside the check. session.ts and security.md document the
    // banned call by name, and a scanner that reads prose is a scanner a reword defeats
    // in either direction.
    const offenders = sourceFiles("src").filter((file) =>
      removesACookieUnsafely(readFileSync(file, "utf8")),
    );

    expect(
      offenders,
      "A cookie jar's delete() sends a removal with no Secure, which a browser rejects " +
        "for any __Host- cookie. Use clearCookie(jar, name, appUrl). This covers the " +
        "response jar under any name and the next/headers cookies() jar, which is a " +
        "response jar inside a Server Action or Route Handler; only the inbound edit, " +
        "written in full as request.cookies.delete, is exempt.",
    ).toEqual([]);
  });
});
