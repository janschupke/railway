/**
 * A recording stand-in for CanvasRenderingContext2D.
 *
 * jsdom implements no 2D context at all — `getContext("2d")` returns null — so without
 * this the entire renderer would be reachable only from a real browser, which is the most
 * expensive place to find a regression in it. Recording calls rather than rasterising
 * also gives better assertions than a pixel diff would: "every colour it ever set came
 * from the palette" is a property, and a screenshot cannot state it.
 *
 * Lives in src/test/ deliberately: knip.jsonc ignores that directory and vitest's
 * coverage excludes it, which is the same slot setup-dom.ts occupies.
 */

export type Op = { readonly op: string; readonly args: readonly unknown[] };

export type FakeContext = {
  readonly ctx: CanvasRenderingContext2D;
  readonly ops: readonly Op[];
  /** Every value ever assigned to fillStyle or strokeStyle, in order. */
  readonly styles: readonly string[];
  opsOf(name: string): readonly Op[];
  indexOf(name: string): number;
  reset(): void;
};

/** Methods that record and do nothing else. */
const VOID_METHODS = [
  "save",
  "restore",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "quadraticCurveTo",
  "bezierCurveTo",
  "arc",
  "ellipse",
  "rect",
  "roundRect",
  "fill",
  "stroke",
  "fillRect",
  "strokeRect",
  "clearRect",
  "translate",
  "rotate",
  "scale",
  "setTransform",
  "resetTransform",
  "clip",
  "drawImage",
  "setLineDash",
] as const;

/** Properties whose assignment is worth recording. */
const TRACKED = [
  "fillStyle",
  "strokeStyle",
  "lineWidth",
  "globalAlpha",
  "lineCap",
  "lineJoin",
  "font",
] as const;

export function createFakeContext(): FakeContext {
  const ops: Op[] = [];
  const styles: string[] = [];
  const target: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const stack: Array<Record<string, unknown>> = [];

  for (const name of VOID_METHODS) {
    target[name] = (...args: unknown[]) => {
      ops.push({ op: name, args });
    };
  }

  /*
   * save/restore actually stack the tracked properties, rather than only recording that
   * they were called.
   *
   * Without it "the renderer restores the alpha it borrows" is unassertable: the last
   * recorded *assignment* is whatever the final puff asked for, and a real context would
   * have put it back on restore. A fake that cannot tell a balanced borrow from a leak
   * would pass the leak, which is the bug worth catching — a globalAlpha left at 0.2
   * fades the next frame's locomotive and nothing else notices.
   */
  target.save = (...args: unknown[]) => {
    ops.push({ op: "save", args });
    stack.push({ ...state });
  };
  target.restore = (...args: unknown[]) => {
    ops.push({ op: "restore", args });
    const previous = stack.pop();
    if (previous) Object.assign(state, previous);
  };

  // The gradient records its stops so a test can assert the sky has two of them.
  target.createLinearGradient = (...args: unknown[]) => {
    ops.push({ op: "createLinearGradient", args });
    return {
      addColorStop: (offset: number, colour: string) => {
        ops.push({ op: "addColorStop", args: [offset, colour] });
        styles.push(colour);
      },
    };
  };

  for (const name of TRACKED) {
    state[name] = name === "globalAlpha" ? 1 : "";
    Object.defineProperty(target, name, {
      get: () => state[name],
      set: (next: unknown) => {
        state[name] = next;
        ops.push({ op: `set:${name}`, args: [next] });
        if (
          (name === "fillStyle" || name === "strokeStyle") &&
          typeof next === "string"
        ) {
          styles.push(next);
        }
      },
      enumerable: true,
      configurable: true,
    });
  }

  return {
    // The cast is the point of the file: production code speaks the real DOM type, and
    // only the test harness pretends. Widening the renderer's own parameter types to fit
    // a fake would put the fake's shape into shipped code.
    ctx: target as unknown as CanvasRenderingContext2D,
    ops,
    styles,
    opsOf: (name) => ops.filter((entry) => entry.op === name),
    indexOf: (name) => ops.findIndex((entry) => entry.op === name),
    reset: () => {
      ops.length = 0;
      styles.length = 0;
    },
  };
}
