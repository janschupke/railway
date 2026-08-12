import type messages from "./messages/en.json";
import type { DEFAULT_LOCALE } from "./src/i18n/config";

/**
 * Makes `t("…")` keys type-checked against the English catalog.
 *
 * Without this a renamed or misspelled key renders a missing-message marker at runtime,
 * which nothing in CI would catch. With it, the catalog and the call sites cannot drift
 * apart without `tsc` failing.
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof messages;
    Locale: typeof DEFAULT_LOCALE;
  }
}
