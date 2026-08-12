import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE } from "./config";

/**
 * Resolves the locale and its messages for every server render.
 *
 * With a single locale there is no negotiation to do, so this stays a constant — but
 * routing it through next-intl rather than importing the JSON directly means the
 * components never learn which locale they are in, and adding a second one later is a
 * change to this file alone.
 */
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: (await import(`../../messages/${DEFAULT_LOCALE}.json`)).default,
}));
