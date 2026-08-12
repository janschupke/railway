/**
 * There is one locale today, and that is a deliberate stopping point rather than an
 * unfinished job: every user-facing string lives in `messages/`, so adding a locale is
 * a translation task, not a refactor. Nothing in the app hardcodes "en" — it reads
 * from here, which is what keeps that promise honest.
 */
export const DEFAULT_LOCALE = "en";
