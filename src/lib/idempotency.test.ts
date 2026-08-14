import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY } from "@/lib/constants";
import { __resetIdempotency, runOnce, type Retainable } from "./idempotency";

/** The ordinary case: something happened and a repeat may be told about it. */
const kept = <T>(value: T): Retainable<T> => ({ value, retain: true });

describe("runOnce", () => {
  // Braces matter: clear() returns undefined here, but a beforeEach hook that returns a
  // function has that function invoked as teardown.
  beforeEach(() => {
    // The map is process-global and every case below spends the same handful of keys, so
    // without this each one would be served the previous case's answer.
    __resetIdempotency();
  });

  it("runs once for two callers holding the same key", async () => {
    /*
     * The defect this module exists for. The form posted twice — a double click, a
     * retried POST — reached the action twice, and both submissions read a container
     * list without the name in it and created a container. Reading a list is not holding
     * a lock; this is the lock.
     */
    let settle: (value: Retainable<string>) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<Retainable<string>>((resolve) => {
          settle = resolve;
        }),
    );

    const callers = [runOnce("u1:k", run, () => 0), runOnce("u1:k", run, () => 0)];
    settle(kept("created"));
    const [first, second] = await Promise.all(callers);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ value: "created", replayed: false });
    // Same answer, and told it is a replay — the caller needs that to log it and to
    // revalidate a route nothing revalidated on its behalf.
    expect(second).toEqual({ value: "created", replayed: true });
  });

  it("serves a caller that arrives after the first one finished", async () => {
    // A repeat does not have to overlap to be a repeat: somebody who thought it had
    // failed and pressed the button again is slower than the wire.
    const run = vi.fn(async () => kept("created"));

    await runOnce("u1:k", run, () => 0);
    const late = await runOnce("u1:k", run, () => 30_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(late).toEqual({ value: "created", replayed: true });
  });

  it("stops serving a retained result once the window closes", async () => {
    // Retention is a courtesy to somebody pressing the button twice, not a record of
    // every container this replica ever made.
    const run = vi.fn(async () => kept("created"));

    await runOnce("u1:k", run, () => 0);
    await runOnce("u1:k", run, () => IDEMPOTENCY.RETAIN_SECONDS * 1000 + 1);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases a key whose attempt left nothing behind", async () => {
    /*
     * The caller's own judgement, and the reason `retain` is on the result rather than
     * decided here: only the caller knows whether anything now exists on Railway. A
     * create that was refused has to stay retryable with the key the form still holds.
     */
    const run = vi
      .fn<() => Promise<Retainable<string>>>()
      .mockResolvedValueOnce({ value: "refused", retain: false })
      .mockResolvedValueOnce(kept("created"));

    const first = await runOnce("u1:k", run, () => 0);
    const second = await runOnce("u1:k", run, () => 1);

    expect(run).toHaveBeenCalledTimes(2);
    expect(first.value).toBe("refused");
    expect(second).toEqual({ value: "created", replayed: false });
  });

  it("does not cache a rejection, so the next attempt is a real one", async () => {
    // Caching a failure would turn one refusal from Railway into five minutes of a form
    // that will not work.
    const run = vi
      .fn<() => Promise<Retainable<string>>>()
      // Thrown lazily inside the call: mockRejectedValue would construct the rejected
      // promise before anything awaits it, which registers as an unhandled rejection.
      .mockImplementationOnce(async () => {
        throw new Error("Not Authorized");
      })
      .mockImplementationOnce(async () => kept("created"));

    await expect(runOnce("u1:k", run, () => 0)).rejects.toThrow("Not Authorized");
    await expect(runOnce("u1:k", run, () => 1)).resolves.toEqual({
      value: "created",
      replayed: false,
    });
  });

  it("hands a joined caller the same rejection", async () => {
    // Both halves of a double-submit have to hear the same thing. The second one being
    // told it succeeded because it was "already handled" would be worse than the failure.
    const run = vi.fn(async () => {
      throw new Error("Not Authorized");
    });

    const callers = [
      runOnce("u1:k", run, () => 0).catch((e: unknown) => e),
      runOnce("u1:k", run, () => 0).catch((e: unknown) => e),
    ];

    expect((await Promise.all(callers)).map(String)).toEqual([
      "Error: Not Authorized",
      "Error: Not Authorized",
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keys one caller's submission apart from another's", async () => {
    // The key half is client-supplied, so two browsers can mint the same one. Only the
    // user half makes an entry unclaimable by anybody else.
    const run = vi.fn(async () => kept("created"));

    await runOnce("u1:k", run, () => 0);
    await runOnce("u2:k", run, () => 0);
    await runOnce("u1:other", run, () => 0);

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("leaves nothing behind when the entry it inserted is already gone", async () => {
    // The identity check in the settle handlers. Unreachable through the public API,
    // which is the point of having it: it is what stops a settling attempt from
    // resurrecting a key that something else has since cleared.
    let settle: (value: Retainable<string>) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<Retainable<string>>((resolve) => {
          settle = resolve;
        }),
    );

    const inFlight = runOnce("u1:k", run, () => 0);
    __resetIdempotency();
    settle(kept("created"));
    await inFlight;

    // The entry that settle handler would have retained is gone, so this is a real
    // attempt rather than a replay of the one that resolved into an empty map.
    const second = runOnce("u1:k", run, () => 0);
    settle(kept("created"));

    await expect(second).resolves.toEqual({ value: "created", replayed: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves nothing behind when a rejected entry is already gone", async () => {
    // The same check on the other handler, which would otherwise delete an entry a later
    // submission had legitimately claimed.
    let fail: (error: Error) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<Retainable<string>>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const inFlight = runOnce("u1:k", run, () => 0).catch(() => undefined);
    __resetIdempotency();
    fail(new Error("Not Authorized"));
    await inFlight;

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("sweeps an expired entry it was not asked about", async () => {
    // Lazily, on whatever call comes next, so no timer runs to keep the map tidy. What
    // is resident is the last few minutes of spin-ups, not every one this replica made.
    const run = vi.fn(async () => kept("created"));

    await runOnce("u1:stale", run, () => 0);
    await runOnce("u1:fresh", run, () => IDEMPOTENCY.RETAIN_SECONDS * 1000 + 1);
    const revisited = await runOnce(
      "u1:stale",
      run,
      () => IDEMPOTENCY.RETAIN_SECONDS * 1000 + 2,
    );

    expect(revisited.replayed).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
