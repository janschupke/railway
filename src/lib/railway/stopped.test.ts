import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetStopped,
  applyStopped,
  applyStoppedToHistory,
  clearStopped,
  markStopped,
} from "./stopped";
import type { Container, DeploymentHistoryEntry } from "./types";

/**
 * The memory that makes a stopped container read as stopped.
 *
 * Every case here is one Railway behaviour measured against the live API, or one way the
 * obvious implementation of this module goes wrong. Neither is visible from the e2e suite
 * alone: the fake used to set REMOVED on stop, so the spec that asserted a stopped row
 * reads "Removed" passed for years against a shape Railway has never produced.
 */

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deployedAt: "2026-08-01T00:00:00.000Z",
  url: null,
  managed: true,
  ...over,
});

/** The reading a stop is taken against, for the container above. */
const atStop = {
  deploymentId: "dep_1",
  rawStatus: "SUCCESS",
  deployedAt: "2026-08-01T00:00:00.000Z",
};

const entry = (over: Partial<DeploymentHistoryEntry> = {}): DeploymentHistoryEntry => ({
  id: "dep_1",
  state: "running",
  rawStatus: "SUCCESS",
  createdAt: "2026-08-01T00:00:00.000Z",
  canRollback: true,
  ...over,
});

beforeEach(() => {
  __resetStopped();
});

describe("what a stop is remembered as", () => {
  it("renders a container Railway still calls SUCCESS as removed", () => {
    /*
     * The whole defect in one assertion. Railway answers `deploymentStop` with `true`,
     * stops the container, and leaves the status at SUCCESS forever — so without this the
     * row reads Running, counts uptime through the downtime, and offers Stop and Restart
     * while withholding the Redeploy that is the only control that would bring it back.
     */
    markStopped("svc_1", atStop);

    expect(applyStopped([container()])[0]?.state).toBe("removed");
  });

  it("leaves Railway's own word on the badge alone", () => {
    // `rawStatus` is read out to screen readers as "Railway status: …", and Railway really
    // did say SUCCESS. The app's reading changes; its report of Railway's does not.
    markStopped("svc_1", atStop);

    expect(applyStopped([container()])[0]?.rawStatus).toBe("SUCCESS");
  });

  it("touches nothing it was not asked about", () => {
    markStopped("svc_1", atStop);

    const others = [container({ serviceId: "svc_2", deploymentId: "dep_2" })];
    expect(applyStopped(others)[0]?.state).toBe("running");
  });

  it("costs nothing when nothing has been stopped", () => {
    // Identity, not merely equality: this runs on every dashboard render and every watcher
    // poll, and an empty map must not mint a new array for the fingerprint to hash.
    const list = [container()];
    expect(applyStopped(list)).toBe(list);
  });

  it("does not mutate the list it was handed", () => {
    // `toContainers`' output is handed to a fingerprint and to React, both of which
    // compare — neither should be reading an object something else edited underneath.
    markStopped("svc_1", atStop);
    const original = container();

    applyStopped([original]);

    expect(original.state).toBe("running");
  });
});

describe("when the memory stands down", () => {
  it("drops it the moment Railway reports a different status", () => {
    /*
     * A crash loop is the case that matters: the container this app stopped came back and
     * fell over, Railway says CRASHED, and a memory that outlived that would mask a failure
     * behind a state the user chose.
     */
    markStopped("svc_1", atStop);

    expect(
      applyStopped([container({ rawStatus: "CRASHED", state: "failed" })])[0]?.state,
    ).toBe("failed");
    // And it is gone, not merely skipped — a later read at SUCCESS must not resurrect it.
    expect(applyStopped([container()])[0]?.state).toBe("running");
  });

  it("drops it when a different deployment is running", () => {
    // A redeploy from Railway's own dashboard. The service is the key, so the entry is
    // found; the deployment id is what proves it is no longer the one that was stopped.
    markStopped("svc_1", atStop);

    expect(
      applyStopped([
        container({ deploymentId: "dep_2", deployedAt: "2026-08-02T00:00:00.000Z" }),
      ])[0]?.state,
    ).toBe("running");
  });

  it("drops it when the same id names a different deployment", () => {
    /*
     * Railway's ids are UUIDs and never recycle, so this can only happen against the e2e
     * fixture — which resets its id counter every spec while the process holding this map
     * does not. Without the timestamp in the match, a stop recorded by one spec would
     * render another spec's first container as Removed.
     */
    markStopped("svc_1", atStop);

    expect(
      applyStopped([container({ deployedAt: "2026-08-09T00:00:00.000Z" })])[0]?.state,
    ).toBe("running");
  });

  it("forgets on request, which is how a restart is not left stranded", () => {
    /*
     * `restartDeployment` keeps the same deployment id and Railway walks the status back to
     * SUCCESS, so a restarted container reads exactly like a stopped one. Nothing in the
     * response tells them apart — the app knowing it restarted is the only signal there is,
     * and `withManagedContainer` clears on every verb but stop for that reason.
     *
     * Left stranded, `availableActions("removed")` offers only Redeploy: the container
     * could not be stopped again, and pressing Redeploy would mint a second deployment of
     * one that is already running.
     */
    markStopped("svc_1", atStop);
    clearStopped("svc_1");

    expect(applyStopped([container()])[0]?.state).toBe("running");
  });

  it("replaces rather than accumulates when the same service is stopped twice", () => {
    markStopped("svc_1", atStop);
    markStopped("svc_1", {
      ...atStop,
      deploymentId: "dep_9",
      deployedAt: "2026-08-05T00:00:00.000Z",
    });

    // The first stop is gone: this reading matches only the entry that was overwritten.
    expect(applyStopped([container()])[0]?.state).toBe("running");
  });
});

describe("the bound that stands in for an expiry", () => {
  it("evicts the oldest entry rather than growing without limit", () => {
    /*
     * No TTL, deliberately: `watch-fingerprint` hashes `container.state`, so an entry that
     * timed out would flip the fingerprint back and push a `changed` to every open tab,
     * silently returning a still-stopped container to Running. The lie would reverse
     * itself and broadcast the reversal. A size bound is what keeps this from being an
     * unbounded map in a long-lived process instead.
     *
     * 500 is far past what any Railway plan allows in one account, so this is a backstop
     * rather than a behaviour anyone meets.
     */
    markStopped("svc_1", atStop);
    for (let i = 0; i < 500; i += 1) {
      markStopped(`svc_filler_${i}`, atStop);
    }

    expect(applyStopped([container()])[0]?.state).toBe("running");
    expect(applyStopped([container({ serviceId: "svc_filler_499" })])[0]?.state).toBe(
      "removed",
    );
  });

  it("moves a re-stopped service to the back of the queue", () => {
    // Delete-then-set, so eviction is oldest-*written* rather than first-ever-seen: a
    // service being stopped repeatedly is the last one that should fall off the end.
    markStopped("svc_1", atStop);
    for (let i = 0; i < 499; i += 1) markStopped(`svc_filler_${i}`, atStop);
    markStopped("svc_1", atStop);
    markStopped("svc_last", atStop);

    expect(applyStopped([container()])[0]?.state).toBe("removed");
    expect(applyStopped([container({ serviceId: "svc_filler_0" })])[0]?.state).toBe(
      "running",
    );
  });
});

describe("the history panel", () => {
  it("agrees with the row rather than contradicting it one scroll below", () => {
    // `toDeploymentHistory` is a second, independent producer of ContainerState from the
    // same raw status, so without this the badge says Removed and the newest entry in the
    // panel it expands into says Running. Two readings of one deployment.
    markStopped("svc_1", atStop);

    expect(applyStoppedToHistory("svc_1", [entry()])[0]?.state).toBe("removed");
  });

  it("marks only the deployment that was stopped", () => {
    markStopped("svc_1", atStop);

    const entries = [
      entry({ id: "dep_2", createdAt: "2026-08-02T00:00:00.000Z" }),
      entry(),
    ];
    const applied = applyStoppedToHistory("svc_1", entries);

    expect(applied.map((each) => each.state)).toEqual(["running", "removed"]);
  });

  it("evicts nothing, because a history is mostly non-matches by construction", () => {
    /*
     * The container list is the sole authority on when the memory is discarded. Here a
     * mismatch means only "this is some other deployment" — nine of ten entries will be —
     * so eviction on mismatch would throw the entry away every time a panel was opened.
     */
    markStopped("svc_1", atStop);

    applyStoppedToHistory("svc_1", [
      entry({ id: "dep_7", createdAt: "2026-07-01T00:00:00.000Z" }),
    ]);

    expect(applyStopped([container()])[0]?.state).toBe("removed");
  });

  it("leaves a service nothing is remembered about alone", () => {
    const entries = [entry()];
    expect(applyStoppedToHistory("svc_1", entries)).toBe(entries);
  });
});
