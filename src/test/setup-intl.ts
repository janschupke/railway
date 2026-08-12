import { vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";

/**
 * A real translator for node-side tests.
 *
 * `getTranslations` needs a request scope, which no unit or integration test has — and
 * next-intl's non-server build replaces it with a stub that throws. Rather than assert
 * against a fake that returns its own key, this wires up next-intl's own
 * `createTranslator` over the real `messages/en.json`.
 *
 * That matters: a Server Action test then fails if the key is missing from the
 * catalog, if an ICU argument is misnamed, or if a plural form is malformed — none of
 * which a stub would notice.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) =>
    createTranslator({
      locale: "en",
      messages,
      // The catalog's namespace union is not known to a plain string parameter.
      ...(namespace ? { namespace: namespace as never } : {}),
    }),
  getLocale: async () => "en",
}));
