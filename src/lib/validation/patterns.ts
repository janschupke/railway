/**
 * The shapes this app will accept, as regular expressions and one prefix.
 *
 * **Zod-free, and that is the entire reason this file exists.** Importing anything from
 * `./schemas` drags zod into the importer's bundle — the constraint that already pushed
 * `IMAGE_PATTERN` out to `lib/registry/reference.ts` — and these five constants are pure
 * data that several modules want without any of that. `lib/railway/service-edit.ts` was
 * reaching into a zod form-schema module to read one string prefix.
 *
 * Nothing here validates. The rules that apply these live in `./schemas`, and the route
 * handlers apply `RAILWAY_ID_PATTERN` themselves before a session is even read.
 */

/**
 * Deployment id, as it arrives from the URL of the stream route.
 *
 * Bounds charset and length rather than asserting a format. Used for every Railway
 * identifier that arrives on a URL — deployments, projects, environments.
 * Railway's ids look like
 * UUIDs today, but this app has no way to prove that — and a validator that guesses
 * wrong turns every log pane into a 400. What matters is that path separators, dots and
 * unbounded input cannot reach the GraphQL layer; the concurrency cap and the
 * missing-deployment timeout are what bound the abuse, and neither depends on the shape.
 */
export const RAILWAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The token the spin-up form mints to name one submission of itself.
 *
 * Not exported: nothing outside this file decides what a key may look like, and the
 * generator in lib/random-id.ts sits comfortably inside these bounds rather than at them.
 *
 * Both ends of the length matter, and for unrelated reasons. The floor is the security
 * one — a short key is a guessable key, and guessing one replays somebody else's result
 * instead of creating what they asked for. The ceiling is a memory one: this string
 * becomes half of a key in a process-global map, so unbounded is a growth surface. The
 * charset is the same one every Railway identifier uses here, which keeps it greppable
 * in a log line.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * An environment variable name: POSIX's own definition.
 *
 * Underscore or letter, then letters, digits and underscores. Deliberately not
 * uppercase-only — lowercase names are legal everywhere they matter, and a validator that
 * guesses stricter than the platform turns a working variable into a form error.
 *
 * Linear, with no nested quantifier and disjoint atom classes, so it is not ReDoS-able for
 * the same reason IMAGE_PATTERN is not. SECURITY.md makes that claim about the image regex
 * and a reviewer will ask it of this one.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Everything a value may hold: any character except the C0 controls and DEL, with tab
 * allowed through.
 *
 * The exclusion is the whole rule. A line break is invisible in a single-line input — the
 * browser's own value-sanitization algorithm strips it from a pasted string, so the user's
 * secret is silently truncated — and it survives to whatever downstream reads an
 * environment block line by line, which is the one character class that changes the shape
 * of what is being set rather than its content. NUL is refused at the other end of the
 * range for the same reason, and doubles as what a non-string FormData entry is coerced to
 * before it gets here.
 */
export const VARIABLE_VALUE_PATTERN = /^[^\u0000-\u0008\u000A-\u001F\u007F]*$/;

/**
 * The namespace Railway sets itself.
 *
 * Railway injects a RAILWAY_* block into every service — environment, project id, service
 * name, the private and public domains. `variableCollectionUpsert` runs with
 * `replace: false`, so a collision is a silent merge in one direction or the other and the
 * loser is invisible. Refusing the namespace is cheaper than explaining it.
 *
 * Exported so presets.test.ts can prove no catalog entry is unsubmittable by its own form,
 * which is the failure mode this rule would otherwise create.
 */
export const RESERVED_VARIABLE_PREFIX = "RAILWAY_";
