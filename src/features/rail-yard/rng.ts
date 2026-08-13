/**
 * The simulation's only source of randomness, and it is seeded.
 *
 * `Math.random()` is banned inside this feature, and the ban is asserted rather than
 * documented — simulation.test.ts spies on it and throws. Two things depend on that:
 * a world advanced from a fixed seed must be identical every run, or the determinism
 * assertions are vacuous; and the reduced-motion still frame must be the same frame for
 * every visitor, or e2e cannot compare two canvas snapshots for equality.
 *
 * mulberry32: 32 bits of state, one multiply and three shifts per draw. Chosen over a
 * bare xorshift because that fails on the low bits, which is exactly where a colour
 * index lands, and over `crypto.getRandomValues` because unseedable is the one thing
 * this must not be.
 */
export type Rng = () => number;

/** A non-empty list. The alternative is `T | undefined` at nine call sites. */
export type NonEmpty<T> = readonly [T, ...T[]];

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A uniform member.
 *
 * The `??` is not dead: `rng()` is specified over [0, 1) but a stubbed one in a test can
 * return 1, and an out-of-range index under `noUncheckedIndexedAccess` is a silent
 * `undefined` flowing into the renderer rather than a crash.
 */
export function pick<T>(rng: Rng, items: NonEmpty<T>): T {
  return items[Math.floor(rng() * items.length)] ?? items[0];
}

/** A value in `[min, max)`, from an inclusive pair written as it reads in the config. */
export function range(rng: Rng, [min, max]: readonly [number, number]): number {
  return min + rng() * (max - min);
}

/** An integer in `[min, max]`, both ends reachable. */
export function rangeInt(rng: Rng, bounds: readonly [number, number]): number {
  const [min, max] = bounds;
  return Math.min(max, min + Math.floor(rng() * (max - min + 1)));
}

/**
 * A member chosen in proportion to its weight.
 *
 * Negative weights are clamped rather than rejected: this drives which duty a train
 * draws, and a typo in the scene config should give a boring yard, not an exception on
 * the landing page. A total of zero falls back to the first entry — scene.test.ts is
 * what actually fails on that.
 */
export function weightedPick<T>(
  rng: Rng,
  items: NonEmpty<T>,
  weightOf: (item: T) => number,
): T {
  const weights = items.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return items[0];

  let roll = rng() * total;
  for (let index = 0; index < items.length; index++) {
    roll -= weights[index] ?? 0;
    if (roll < 0) return items[index] ?? items[0];
  }
  return items[items.length - 1] ?? items[0];
}
