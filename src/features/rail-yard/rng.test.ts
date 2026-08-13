import { describe, expect, it } from "vitest";
import { createRng, pick, range, rangeInt, weightedPick, type NonEmpty } from "./rng";

/** Widened on purpose: `as const` alone binds NonEmpty<T> to the first entry's type. */
type Candidate = { readonly id: string; readonly weight: number };

describe("createRng", () => {
  it("gives the same sequence for the same seed", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const draw = (rng: () => number) => Array.from({ length: 50 }, () => rng());
    expect(draw(a)).toEqual(draw(b));
  });

  it("gives different sequences for different seeds", () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  it("stays inside [0, 1)", () => {
    const rng = createRng(7);
    for (let index = 0; index < 5_000; index++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("does not collapse to a constant", () => {
    const rng = createRng(99);
    const seen = new Set(Array.from({ length: 200 }, () => rng()));
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe("pick", () => {
  it("reaches every member", () => {
    const rng = createRng(3);
    const items = ["a", "b", "c"] as const;
    const seen = new Set(Array.from({ length: 200 }, () => pick(rng, items)));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to the first member when the source returns 1", () => {
    // Specified over [0, 1), but a stub can hand back 1 — and under
    // noUncheckedIndexedAccess the alternative is `undefined` reaching the renderer.
    expect(pick(() => 1, ["a", "b"])).toBe("a");
  });
});

describe("range", () => {
  it("stays within its bounds", () => {
    const rng = createRng(11);
    for (let index = 0; index < 1_000; index++) {
      const value = range(rng, [5, 9]);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(9);
    }
  });

  it("returns the lower bound for a zero-width range", () => {
    expect(range(createRng(1), [4, 4])).toBe(4);
  });
});

describe("rangeInt", () => {
  it("reaches both ends inclusively", () => {
    const rng = createRng(5);
    const seen = new Set(Array.from({ length: 500 }, () => rangeInt(rng, [2, 4])));
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });

  it("never exceeds the upper bound when the source returns 1", () => {
    expect(rangeInt(() => 1, [2, 4])).toBe(4);
  });
});

describe("weightedPick", () => {
  const items: NonEmpty<Candidate> = [
    { id: "heavy", weight: 3 },
    { id: "light", weight: 1 },
  ];

  it("honours the weights", () => {
    const rng = createRng(17);
    let heavy = 0;
    const draws = 10_000;
    for (let index = 0; index < draws; index++) {
      if (weightedPick(rng, items, (item) => item.weight).id === "heavy") heavy += 1;
    }
    expect(heavy / draws).toBeGreaterThan(0.7);
    expect(heavy / draws).toBeLessThan(0.8);
  });

  it("clamps a negative weight rather than letting it eat the total", () => {
    const withNegative: NonEmpty<Candidate> = [
      { id: "never", weight: -50 },
      { id: "always", weight: 1 },
    ];
    const rng = createRng(2);
    for (let index = 0; index < 200; index++) {
      expect(weightedPick(rng, withNegative, (item) => item.weight).id).toBe("always");
    }
  });

  it("falls back to the first entry when every weight is zero", () => {
    // A config typo should give a boring yard, not an exception on the landing page.
    const zeroed: NonEmpty<Candidate> = [
      { id: "first", weight: 0 },
      { id: "second", weight: 0 },
    ];
    expect(weightedPick(createRng(1), zeroed, (item) => item.weight).id).toBe("first");
  });

  it("returns the last entry when the roll lands on the total", () => {
    expect(
      weightedPick(
        () => 1,
        items,
        (item) => item.weight,
      ).id,
    ).toBe("light");
  });
});
