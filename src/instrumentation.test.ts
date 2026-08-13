import { beforeEach, describe, expect, it, vi } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { onRequestError } from "./instrumentation";

/** The two Next supplies beyond the error itself; only their shape matters here. */
const request = (path: string) => ({ path, method: "GET", headers: {} });
const context = {
  routerKind: "App Router" as const,
  routePath: "/dashboard",
  routeType: "render" as const,
  renderSource: "react-server-components" as const,
  revalidateReason: undefined,
  renderType: "dynamic" as const,
};

describe("onRequestError", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the digest, which is what the reference on screen refers to", () => {
    // Without this field the digest shown to the user joins to nothing.
    const error = Object.assign(new Error("render blew up"), { digest: "3141592" });

    onRequestError(error, request("/dashboard"), context);

    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "render.failed",
        level: "error",
        digest: "3141592",
        route_group: "/dashboard",
      }),
    );
  });

  it("drops a browser that navigated away to debug", () => {
    /*
     * Next reports an abandoned render through the same hook as a genuine throw. At
     * `error` it fires on ordinary fast navigation, which is the false positive that
     * teaches people to ignore the level.
     */
    onRequestError(
      new Error("The destination stream closed early."),
      request("/dashboard"),
      context,
    );

    expect(logRecords()).toContainEqual(
      expect.objectContaining({ msg: "render.failed", level: "debug" }),
    );
  });

  it("groups the path instead of echoing it", () => {
    /*
     * `request.path` is the concrete URL path, chosen by whoever sent it. A 404 sweep
     * across /aaa, /aab, /aac wrote a new value per request into a field whose entire
     * purpose is to be grouped on — and Next's context carries no matched route pattern
     * to use instead.
     */
    onRequestError(new Error("boom"), request("/aaa-CANARY/bbb?q=CANARY"), context);
    onRequestError(new Error("boom"), request("/api/streams/dep_CANARY"), context);
    onRequestError(new Error("boom"), request("/"), context);

    const groups = logRecords()
      .filter((r) => r.msg === "render.failed")
      .map((r) => r.route_group);

    expect(groups).toEqual(["other", "/api", "/"]);
    expect(rawLogLines().join("")).not.toContain("CANARY");
  });
});
