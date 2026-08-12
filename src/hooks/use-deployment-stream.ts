"use client";

import { useEffect, useState } from "react";
import { STREAM } from "@/lib/constants";
import type { ContainerState, LogLine } from "@/lib/railway/types";

export type StreamState = {
  state: ContainerState | null;
  rawStatus: string | null;
  logs: LogLine[];
  connected: boolean;
  done: boolean;
  warning: string | null;
  error: string | null;
};

const INITIAL: StreamState = {
  state: null,
  rawStatus: null,
  logs: [],
  connected: false,
  done: false,
  warning: null,
  error: null,
};

/**
 * Subscribes to /api/streams/[deploymentId].
 *
 * EventSource reconnects on its own after a transport drop, which is what we want
 * mid-build — the server backfills recent logs on every attach, so a reconnect closes
 * the gap rather than leaving a hole. It must be closed explicitly on `done`, though,
 * or the browser would keep redialling a stream the server intends to end.
 *
 * State is stored tagged with the stream it belongs to, and a mismatched tag reads as
 * INITIAL. That way switching containers needs no reset-on-change effect: every
 * setState here happens inside an EventSource callback, never in the effect body.
 */
export function useDeploymentStream(
  deploymentId: string | null,
  phase: "build" | "deploy",
  enabled: boolean,
): StreamState {
  const key = enabled && deploymentId ? `${deploymentId}:${phase}` : null;

  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    state: StreamState;
  }>({ key: null, state: INITIAL });

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
      update((s) => ({ ...s, connected: true, error: null }));
    });

    source.addEventListener("log", (event) => {
      // The event name carries the type; the payload is the rest of the monitor
      // event, so a log line arrives wrapped as { line }.
      const line = parse<{ line: LogLine }>(event)?.line;
      if (!line) return;
      update((s) => ({
        ...s,
        logs: [...s.logs, line].slice(-STREAM.MAX_BUFFERED_LINES),
      }));
    });

    source.addEventListener("status", (event) => {
      const payload = parse<{ state: ContainerState; rawStatus: string | null }>(event);
      if (!payload) return;
      update((s) => ({ ...s, state: payload.state, rawStatus: payload.rawStatus }));
    });

    source.addEventListener("warning", (event) => {
      const payload = parse<{ message: string }>(event);
      update((s) => ({ ...s, warning: payload?.message ?? null }));
    });

    source.addEventListener("error", (event) => {
      const payload = parse<{ message: string }>(event);
      // A payload means the server reported a real error; a bare event is a transport
      // blip that EventSource will retry on its own.
      if (payload?.message) {
        update((s) => ({ ...s, error: payload.message, connected: false }));
        source.close();
      } else {
        update((s) => (s.done ? s : { ...s, connected: false }));
      }
    });

    source.addEventListener("done", () => {
      update((s) => ({ ...s, done: true, connected: false }));
      source.close();
    });

    return () => {
      source.close();
      /*
       * Detaching discards this stream's state.
       *
       * The tag is stable across a collapse and re-expand of the same row, so without
       * this the previous attachment's state came back on the way in: the server's
       * 200-line backfill was appended to logs that were already there, and `done`
       * flipped false → true again, firing the settle-refresh in container-row.tsx a
       * second time. Guarded on the key so a teardown that has already been superseded
       * by the next stream cannot clobber it.
       */
      setSnapshot((prev) => (prev.key === key ? { key: null, state: INITIAL } : prev));
    };
  }, [key, deploymentId, phase]);

  return snapshot.key === key ? snapshot.state : INITIAL;
}
