import { describe, expect, it, vi } from "vitest";
import catalog from "../../messages/en.json";
import { DEFAULT_LOCALE } from "./config";

/*
 * The shared setup mocks next-intl/server for the components that consume translations;
 * this file tests the module that *configures* it, so it needs the one export the real
 * package uses to register a resolver. `getRequestConfig` hands back the function it was
 * given, so identity is the faithful stand-in rather than a convenience.
 */
vi.mock("next-intl/server", () => ({
  getRequestConfig: (resolver: unknown) => resolver,
}));

const request = (await import("./request")).default;

/**
 * The locale seam, asserted rather than assumed.
 *
 * There is one locale, which is a deliberate stopping point rather than an unfinished
 * job — every user-facing string is already in messages/, so a second locale is a
 * translation task. What makes that claim true is that nothing hardcodes "en": the app
 * reads it from here. A module nothing tested is a promise nothing checks.
 */
describe("the request config", () => {
  it("resolves the default locale and its catalog", async () => {
    // getRequestConfig hands back the function it was given, which is what next-intl
    // calls per render; invoking it directly is the same path with no server around it.
    const resolve = request as unknown as (params: unknown) => Promise<{
      locale: string;
      messages: Record<string, unknown>;
    }>;

    const config = await resolve({ requestLocale: Promise.resolve(undefined) });

    expect(config.locale).toBe(DEFAULT_LOCALE);
    // The real catalog, not a stub: a config that resolved an empty object would satisfy
    // a shape assertion and leave every string in the app blank.
    expect(config.messages).toEqual(catalog);
  });

  it("names a locale the catalog actually exists for", () => {
    // DEFAULT_LOCALE is interpolated into a dynamic import, so a typo here is a runtime
    // module-not-found on the first render rather than anything a type could catch.
    expect(DEFAULT_LOCALE).toBe("en");
  });
});
