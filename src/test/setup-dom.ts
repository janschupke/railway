import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

/*
 * jsdom implements neither of these, and Radix uses both for positioning and for
 * pointer-capture on dismissable layers. Without the stubs every Select, Tooltip and
 * Dialog test throws before it can assert anything.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Next's router is not present in a component test; components only ever call refresh
// and push, so a spy pair is enough and keeps assertions on navigation possible.
export const routerMock = {
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
  redirect: vi.fn(),
}));

/*
 * Client components read copy through `useTranslations`, which needs a provider that no
 * component test mounts. Rather than wrap every render, this swaps the hook for
 * next-intl's own `createTranslator` over the real `messages/en.json`.
 *
 * The point is that assertions keep matching real catalog copy: a renamed key, a
 * misnamed ICU argument or a broken plural fails the component test, which a
 * key-echoing stub would sail straight past.
 */
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../messages/en.json")).default;

  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: "en",
        messages,
        // The catalog's namespace union is not known to a plain string parameter.
        ...(namespace ? { namespace: namespace as never } : {}),
      }),
  };
});
