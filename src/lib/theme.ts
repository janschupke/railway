/**
 * Where the reader's theme choice is remembered, and what it may say.
 *
 * Its own module, and small on purpose. It is read from two places that cannot share
 * code: `ThemeToggle`, and the inline `<script>` in layout.tsx that applies the stored
 * value before first paint. That script runs before any module does, so it cannot import
 * — but it is built from a template literal, so it can interpolate these.
 *
 * Not in lib/constants.ts, where a reader would look for it first. `ThemeToggle` renders
 * in the root layout, so importing that module here would pull every constant in it into
 * the shared client graph of every route — measured at +1.5 kB gzip on / and /_not-found,
 * and enough to put /dashboard over its budget. `lib/registry/reference.ts` exists for
 * exactly this reason relative to lib/validation/schemas.ts; constants.ts carries a note pointing
 * here.
 *
 * Before this, both sites spelled `"theme"` and `"light"|"dark"` out by hand. Renaming the
 * key in the toggle alone would have left every visitor a permanent theme flash on every
 * load — the choice written under one name and read under another — with nothing failing.
 */
export const THEME = {
  STORAGE_KEY: "theme",
  /** The two explicit choices. Absent means "follow the OS", which stores nothing. */
  VALUES: ["light", "dark"],
} as const;
