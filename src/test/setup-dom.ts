import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

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

/*
 * jsdom ships no IntersectionObserver at all, and the container list uses one to page.
 *
 * The stub is a registry rather than an empty class: a test needs to *fire* an
 * intersection to prove the next page loads, which an inert observer cannot do. Each
 * instance registers itself on construction and drops out on disconnect, so
 * `fireIntersection()` reaches whatever the component under test currently observes.
 */
type ObserverEntry = { callback: IntersectionObserverCallback; targets: Element[] };
const observers = new Set<ObserverEntry>();

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class {
    #entry: ObserverEntry;
    constructor(callback: IntersectionObserverCallback) {
      this.#entry = { callback, targets: [] };
      observers.add(this.#entry);
    }
    observe(target: Element) {
      this.#entry.targets.push(target);
    }
    unobserve(target: Element) {
      this.#entry.targets = this.#entry.targets.filter((t) => t !== target);
    }
    disconnect() {
      observers.delete(this.#entry);
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

/** Reports every observed target as on screen, as a real scroll would. */
export function fireIntersection(isIntersecting = true) {
  for (const { callback, targets } of observers) {
    callback(
      targets.map(
        (target) =>
          ({
            target,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
          }) as IntersectionObserverEntry,
      ),
      null as unknown as IntersectionObserver,
    );
  }
}

/*
 * jsdom's window.scrollTo throws "not implemented", which fails the test rather than the
 * assertion. A spy keeps the call assertable — scroll-to-top has to prove it passes
 * `behavior: "auto"` under prefers-reduced-motion.
 */
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/*
 * jsdom implements no async clipboard, and the log pane copies its buffer through one.
 *
 * Exported like routerMock rather than stubbed inertly, because the branch worth testing
 * is the one where the write FAILS: navigator.clipboard is undefined on an insecure
 * origin and rejects on a denied permission, and a test cannot reach the error toast any
 * other way. Note that user-event installs a clipboard stub of its own for the duration
 * of a `setup()` session, so a test asserting on this one must dispatch its clicks with
 * fireEvent — object URLs need no stub at all, since jsdom does implement those.
 *
 * The explicit reset matters: vitest.config.mts sets no clearMocks, so without it one
 * spec's rejection leaks into the next.
 */
export const clipboardMock = { writeText: vi.fn(async () => {}) };

/*
 * Reinstalled per test rather than once, because user-event's stub is never detached: a
 * single `setup()` anywhere earlier in a file leaves its own clipboard on the navigator
 * for every test after it, and the assertions here would then be made against an object
 * nothing writes to.
 */
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboardMock,
    configurable: true,
  });
  clipboardMock.writeText.mockReset();
  clipboardMock.writeText.mockResolvedValue(undefined);
});

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

/*
 * The URL is the app's state (ADR-7), so a component test that cannot set it cannot test
 * a filtered list or a deep link. The mock reads through a mutable holder rather than
 * returning a fresh empty instance, and `setSearchParams` is what a test calls before
 * rendering. Reset after every test alongside cleanup, so one spec cannot leak a filter
 * into the next.
 */
const searchParamsMock = { current: new URLSearchParams() };

export function setSearchParams(init = "") {
  searchParamsMock.current = new URLSearchParams(init);
}

afterEach(() => setSearchParams());

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.current,
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
