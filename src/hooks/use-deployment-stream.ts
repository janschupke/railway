"use client";

import { useEffect, useRef, useState } from "react";
import { STREAM } from "@/lib/constants";
import type { ContainerState, LogLine } from "@/lib/railway/types";

/**
 * Where the connection stands, as three states rather than one boolean.
 *
 * `connected: boolean` could not tell "the browser has not attached yet" from "the
 * server said its piece and hung up", and the log pane rendered both as "Connecting…".
 * A deployment that succeeded with no log output therefore sat on "Connecting…" forever,
 * with a clean 200, no console error and no failed request to look at.
 */
/**
 * A log line with an identity of its own.
 *
 * `LogLine` is the wire shape and carries nothing stable: two lines can share a timestamp
 * and nothing distinguishes them, so a row could only ever be keyed by its position. That
 * is the one thing a rolling buffer does not preserve. Past MAX_BUFFERED_LINES every
 * arriving line shifts every index, so every key changed, and React discarded and rebuilt
 * a thousand rows — measured at zero of a thousand DOM nodes reused — precisely when the
 * buffer was largest and the pane was busiest.
 *
 * Minted here rather than on the server: nothing on the wire has one, and this is where a
 * line enters the buffer whose ordering the id has to describe. A counter rather than a
 * random id because it is per-attachment and never leaves the browser.
 */
export type BufferedLine = LogLine & { id: number };

export type StreamStatus = "connecting" | "live" | "closed";

export type StreamState = {
  state: ContainerState | null;
  rawStatus: string | null;
  logs: BufferedLine[];
  status: StreamStatus;
  done: boolean;
  warning: string | null;
  error: string | null;
  /**
   * What Railway said about a terminal failure, when it said anything.
   *
   * Free text rather than a catalog key, because nothing on this side chooses the words —
   * the server bounds it before it goes on the wire. Null covers three cases the row
   * deliberately renders identically: the event feed was empty, it was refused, or the
   * deployment never failed. The reader's next step is the same in all three.
   */
  failure: { step: string | null; reason: string | null } | null;
};

const INITIAL: StreamState = {
  state: null,
  rawStatus: null,
  logs: [],
  status: "connecting",
  done: false,
  warning: null,
  error: null,
  failure: null,
};

/**
 * Subscribes to /api/streams/[deploymentId].
 *
 * EventSource reconnects on its own after a transport drop, which is what we want
 * mid-build — the server backfills recent logs on every attach, so a reconnect closes
 * the gap rather than leaving a hole. It must be closed explicitly on `done`, though,
 * or the browser would keep redialling a stream the server intends to end.
 *
 * State is stored tagged with the deployment it belongs to, and a mismatched tag reads
 * as INITIAL. That way switching containers needs no reset-on-change effect: every
 * setState here happens inside an EventSource callback, never in the effect body.
 */
export function useDeploymentStream(
  deploymentId: string | null,
  phase: "build" | "deploy",
  enabled: boolean,
): StreamState {
  /*
   * Identity is the deployment, NOT the phase.
   *
   * A build that finishes flips the row to `deploying`, which re-dials this stream
   * against a different subscription — but the two phases are one continuous log to the
   * person reading it, and tagging the state with the phase discarded everything the
   * build had emitted at exactly the moment it became interesting.
   */
  const key = enabled && deploymentId ? deploymentId : null;

  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    state: StreamState;
  }>({ key: null, state: INITIAL });

  /*
   * Monotonic, and deliberately never reset — not on a phase re-dial, not on a discard.
   *
   * A build that finishes re-dials this stream against the deploy subscription while the
   * accumulated lines stay put, so a counter restarting at 0 would hand the next arrival
   * an id a line already in the buffer is holding. Two rows with one key is a worse defect
   * than the shifting keys this replaces: React reuses the wrong DOM node.
   */
  const nextId = useRef(0);

  /*
   * Discarding this attachment's state is its own effect, keyed on the deployment alone.
   *
   * That is what separates "the row collapsed, throw everything away" from "same
   * deployment, other log phase" without either one having to know about the other:
   * React only runs this cleanup when `key` actually changes, so a phase re-dial leaves
   * the accumulated lines exactly where they are.
   *
   * The discard is needed at all because the tag is stable across a collapse and
   * re-expand of the same row. Without it the previous attachment's state came back on
   * the way in: the server's 200-line backfill was appended to logs that were already
   * there, and `done` flipped false → true again, firing the settle-refresh in
   * container-row.tsx a second time. Guarded on the key so a teardown that has already
   * been superseded by the next attachment cannot clobber it.
   */
  useEffect(
    () => () =>
      setSnapshot((prev) => (prev.key === key ? { key: null, state: INITIAL } : prev)),
    [key],
  );

  useEffect(() => {
    if (!key || !deploymentId) return;

    const source = new EventSource(
      `/api/streams/${encodeURIComponent(deploymentId)}?phase=${phase}`,
    );

    // Always merges onto this stream's own state, never a previous container's.
    const update = (fn: (state: StreamState) => StreamState) =>
      setSnapshot((prev) => ({
        key,
        state: fn(prev.key === key ? prev.state : INITIAL),
      }));

    const parse = <T>(event: Event): T | null => {
      try {
        return JSON.parse((event as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };

    source.addEventListener("ready", () => {
      update((s) => ({ ...s, status: "live", error: null }));
    });

    source.addEventListener("log", (event) => {
      // The event name carries the type; the payload is the rest of the monitor
      // event, so a log line arrives wrapped as { line }.
      const line = parse<{ line: LogLine }>(event)?.line;
      if (!line) return;
      update((s) => ({
        ...s,
        logs: [...s.logs, { ...line, id: nextId.current++ }].slice(
          -STREAM.MAX_BUFFERED_LINES,
        ),
      }));
    });

    source.addEventListener("status", (event) => {
      const payload = parse<{ state: ContainerState; rawStatus: string | null }>(event);
      if (!payload) return;
      update((s) => ({ ...s, state: payload.state, rawStatus: payload.rawStatus }));
    });

    source.addEventListener("failure", (event) => {
      const payload = parse<{ step: string | null; reason: string | null }>(event);
      if (!payload) return;
      /*
       * Deliberately touches neither `done` nor `status`. The server sends this before
       * the drain and `done` a drain later; closing here would cut off the trailing log
       * frames that drain window exists to deliver.
       */
      update((s) => ({
        ...s,
        failure: { step: payload.step ?? null, reason: payload.reason ?? null },
      }));
    });

    source.addEventListener("warning", (event) => {
      const payload = parse<{ message: string }>(event);
      update((s) => ({ ...s, warning: payload?.message ?? null }));
    });

    source.addEventListener("error", (event) => {
      const payload = parse<{ message: string }>(event);
      // A payload means the server reported a real error and will send nothing else.
      if (payload?.message) {
        update((s) => ({ ...s, error: payload.message, status: "closed" }));
        source.close();
        return;
      }

      /*
       * A bare error carries no status code — EventSource does not expose one — but it
       * does expose readyState, and that is the difference that matters. CONNECTING means
       * the transport blipped and the browser is already redialling. CLOSED means the
       * browser gave up, which is what it does for any non-2xx: a 400 from the id
       * validator, a 401 from an expired session, a 429 from the slot cap.
       *
       * Every one of those used to be treated as a retryable blip, so the pane sat on
       * "Connecting…" indefinitely waiting for a reconnection that was never coming.
       */
      if (source.readyState === EventSource.CLOSED) {
        update((s) => (s.done ? s : { ...s, status: "closed" }));
        return;
      }
      update((s) => (s.done ? s : { ...s, status: "connecting" }));
    });

    source.addEventListener("done", () => {
      update((s) => ({ ...s, done: true, status: "closed" }));
      source.close();
    });

    // Only the connection. Whether the accumulated state survives is the effect above's
    // decision, and it is keyed differently on purpose.
    return () => source.close();
  }, [key, deploymentId, phase]);

  return snapshot.key === key ? snapshot.state : INITIAL;
}
