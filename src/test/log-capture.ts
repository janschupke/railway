import { vi } from "vitest";

/**
 * Captures the logger's output so tests can assert on records rather than on a spy's
 * argument list.
 *
 * Deliberately imports nothing from `src/lib`. `knip.jsonc` ignores `src/test/**`, which
 * removes these files from the module graph — so an import *from* here does not register
 * as usage of the imported symbol, and anything consumed only from here is reported
 * unused and fails CI. Zero coupling, zero knip risk. The trade is one literal below that
 * has to match `logger.ts`'s `base.service`.
 */
const SIGNATURE = '"service":"container-console"';

const captured: string[] = [];

export function installLogCapture(): void {
  const original = process.stdout.write.bind(process.stdout);

  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (text.includes(SIGNATURE)) {
      captured.push(...text.split("\n").filter(Boolean));
      return true;
    }
    /*
     * Everything else is passed through. Without this, vitest's own reporter writes to
     * the same stream and the terminal goes dark — which reads as a hung suite.
     */
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
}

/** The raw serialized lines, before parsing — what a canary assertion should search. */
export function rawLogLines(): readonly string[] {
  return captured;
}

export function logRecords(): Record<string, unknown>[] {
  return captured.map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function clearLogRecords(): void {
  captured.length = 0;
}
