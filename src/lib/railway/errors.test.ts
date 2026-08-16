import { describe, expect, it } from "vitest";
import { RailwayApiError, toApiError } from "./errors";

/**
 * The classification, asserted by name.
 *
 * Every branch in this file was already covered — by eleven other test files. `data.test.ts`,
 * `client.test.ts`, `logger.test.ts`, `serialize-error.test.ts`, `deployment-monitor.test.ts`
 * and six more each construct one of these on the way to asserting something else, and
 * between them they happened to visit all 33. So the coverage gate was green and the
 * property was held by nobody: delete any one of those files and the number falls somewhere
 * that does not explain why, and no assertion anywhere says what was lost.
 *
 * What was lost is the rule `errors-and-logging.md` states outright — "a rejected credential,
 * a withheld scope, a rate limit and an outage each map to their own sentence … **Keep the
 * branches**" — because a user who cannot tell those apart cannot tell whether to retry,
 * re-authorize, or stop. That is the first redaction pass's bug, which collapsed them into
 * one message. This file is the thing that fails when they collapse again.
 */

const error = (
  options: ConstructorParameters<typeof RailwayApiError>[1],
  message = "x",
) => new RailwayApiError(message, options);

describe("the three faces of an auth failure", () => {
  it("tells a dead credential from a live one that does not reach far enough", () => {
    // Different advice: sign in again, versus approve a resource at consent. The whole
    // reason the "re-authorize" button used to be the one that never worked.
    expect(error({ kind: "auth", status: 401 }).describe().key).toBe("errors.api.auth");
    expect(error({ kind: "auth", status: 403 }).describe().key).toBe("errors.api.auth");
    expect(error({ kind: "auth", code: "UNAUTHENTICATED" }).describe().key).toBe(
      "errors.api.auth",
    );
  });

  it("names the scope a refused path implies, so re-authorizing is not a guess", () => {
    /*
     * Railway's refusal says only "Not Authorized"; the path is the only thing that
     * distinguishes "you did not grant workspace access" from "your token is dead".
     */
    const workspace = error({ kind: "auth", path: ["me", "workspaces", 0] });
    expect(workspace.missingScope).toBe("workspace:viewer");
    expect(workspace.describe()).toMatchObject({
      key: "errors.api.missingScope",
      values: { scope: "workspace:viewer" },
    });

    for (const field of ["project", "projects", "service"]) {
      expect(error({ kind: "auth", path: [field, "id"] }).missingScope).toBe(
        "project:admin",
      );
    }
  });

  it("falls back to the narrower sentence when the path implies nothing", () => {
    // Railway's own "Not Authorized" says neither, so it is read as the narrower case
    // rather than sending someone to a consent screen that will not help.
    expect(error({ kind: "auth" }).describe().key).toBe("errors.api.notAuthorized");
    expect(error({ kind: "auth", path: [] }).missingScope).toBeUndefined();
    expect(error({ kind: "auth", path: [0, 1] }).missingScope).toBeUndefined();
    expect(error({ kind: "auth", path: ["deployment"] }).describe().key).toBe(
      "errors.api.notAuthorized",
    );
  });

  it("implies no scope at all for a failure that is not about authorization", () => {
    expect(
      error({ kind: "server", path: ["workspaces"] }).missingScope,
    ).toBeUndefined();
  });
});

describe("a plan ceiling", () => {
  it("is classified from the wording, because the code says nothing", () => {
    /*
     * Measured live: a free account refused a sixth service with this sentence and
     * `extensions.code: "INTERNAL_SERVER_ERROR"` — the same code every other Railway
     * refusal carries. Before this, it fell to `graphqlUnexpected`, which told the user
     * the app did not recognise the reason. Railway had said exactly what to do.
     */
    expect(
      toApiError(
        {
          message:
            "Free plan resource provision limit exceeded. Please upgrade to provision more resources!",
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        },
        "ServiceCreate",
        200,
      ).kind,
    ).toBe("plan_limit");

    for (const message of [
      "Hobby plan limit reached",
      "Service limit exceeded for this workspace",
      "Please upgrade your plan to add more services",
    ]) {
      expect(toApiError({ message }, "ServiceCreate", 200).kind, message).toBe(
        "plan_limit",
      );
    }
  });

  it("never steals a rate limit or an authorization failure", () => {
    // A rate limit carries a retry delay this sentence must not suggest, and a dead
    // credential is the more specific diagnosis — both are classified before this one.
    expect(toApiError({ message: "Rate limit exceeded" }, "Project", 200).kind).toBe(
      "graphql",
    );
    expect(toApiError({ message: "Not Authorized" }, "Project", 200).kind).toBe("auth");
    expect(
      toApiError(
        {
          message: "Cannot query field limit on type Plan",
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
        "Project",
        200,
      ).kind,
    ).toBe("graphql");
  });

  it("names the remedy rather than offering a retry", () => {
    expect(error({ kind: "plan_limit" }).describe().key).toBe("errors.api.planLimit");
  });
});

describe("the other four kinds", () => {
  it("says how long to wait when Railway said so, and not when it did not", () => {
    expect(
      error({ kind: "rate_limit", retryAfterSeconds: 30 }).describe(),
    ).toMatchObject({
      key: "errors.api.rateLimitRetry",
      values: { seconds: 30 },
    });
    expect(error({ kind: "rate_limit" }).describe().key).toBe("errors.api.rateLimit");
  });

  it("keeps a transport failure and an outage apart", () => {
    expect(error({ kind: "network" }).describe().key).toBe("errors.api.network");
    expect(error({ kind: "server", status: 503 }).describe().key).toBe(
      "errors.api.server",
    );
  });

  it("tells a wrong document from a refused operation", () => {
    /*
     * A schema rejection means the API is not what this code was written against, and the
     * answer is a different query rather than a retry or a re-authorization — so the user
     * gets a different sentence, not just the log a different tag.
     */
    expect(
      error({ kind: "graphql", code: "GRAPHQL_VALIDATION_FAILED" }).describe().key,
    ).toBe("errors.api.graphqlSchema");

    // Railway does not always set a code, so the wording is the only other signal.
    for (const message of [
      'Cannot query field "volumes" on type "Project"',
      "Unknown argument: sourceEnvironmentId",
      "Unknown field foo",
      "Unknown type Bar",
      'Did you mean "serviceDomains"?',
    ]) {
      expect(error({ kind: "graphql" }, message).isSchemaRejection(), message).toBe(
        true,
      );
    }

    expect(error({ kind: "graphql" }, "Service not found").describe().key).toBe(
      "errors.api.graphqlUnexpected",
    );
  });

  it("reads schema wording only on a graphql failure", () => {
    // A network error whose cause happens to say "cannot query field" is still a network
    // error; the kind decides first.
    expect(error({ kind: "network" }, "Cannot query field x").isSchemaRejection()).toBe(
      false,
    );
  });
});

describe("the incident id", () => {
  it("is minted once, so the sentence and the log line name the same failure", () => {
    /*
     * Minted in the constructor rather than in `describe()`, which is what ties the
     * reference a user reads to the line `reportError` already wrote — however many
     * layers later the sentence is composed.
     */
    const failure = error({ kind: "network" });
    const first = failure.describe().values?.incident;

    expect(first).toBe(failure.incidentId);
    expect(failure.describe().values?.incident).toBe(first);
    expect(error({ kind: "network" }).incidentId).not.toBe(first);
  });

  it("reaches every sentence this class can produce", () => {
    // An id on some branches and not others is worse than none: the user is told to quote
    // a reference that is only sometimes in the log.
    const cases = [
      error({ kind: "auth", status: 401 }),
      error({ kind: "auth", path: ["workspace"] }),
      error({ kind: "auth" }),
      error({ kind: "plan_limit" }),
      error({ kind: "rate_limit", retryAfterSeconds: 5 }),
      error({ kind: "rate_limit" }),
      error({ kind: "network" }),
      error({ kind: "server" }),
      error({ kind: "graphql" }, "Cannot query field x"),
      error({ kind: "graphql" }, "boom"),
    ];

    // Every branch of `describe`, and each one distinct — a switch that fell through
    // would show up here as a duplicate rather than as a missing case.
    expect(new Set(cases.map((each) => each.describe().key)).size).toBe(cases.length);
    for (const each of cases) {
      expect(each.describe().values?.incident, each.describe().key).toBe(
        each.incidentId,
      );
    }
  });
});

describe("what it carries", () => {
  it("keeps Railway's own fields verbatim for the log, and off the sentence", () => {
    const failure = error(
      {
        kind: "graphql",
        status: 200,
        operation: "Project",
        code: "INTERNAL_SERVER_ERROR",
        path: ["project", "volumes"],
        cause: new Error("Not Authorized"),
      },
      "Not Authorized",
    );

    expect(failure.name).toBe("RailwayApiError");
    expect(failure.operation).toBe("Project");
    expect(failure.code).toBe("INTERNAL_SERVER_ERROR");
    expect(failure.path).toEqual(["project", "volumes"]);
    expect(failure.cause).toBeInstanceOf(Error);

    // None of it reaches the user: describe() returns a key and an incident id, and the
    // values object is where upstream text would have leaked in.
    expect(JSON.stringify(failure.describe())).not.toContain("Not Authorized");
    expect(JSON.stringify(failure.describe())).not.toContain("volumes");
  });
});

/*
 * Moved here from actions.integration.test.ts, which it had been sitting at the bottom
 * of without ever calling an action: it constructs a RailwayApiError and asserts on what
 * describe() returns, which is this module's job and no Server Action's.
 */
describe("the user-facing descriptor", () => {
  it("keeps RailwayApiError's user-facing descriptor free of its internal message", () => {
    const error = new RailwayApiError("HTTP 429 from backboard", {
      kind: "rate_limit",
      retryAfterSeconds: 30,
    });

    const descriptor = error.describe();
    expect(descriptor).toEqual({
      key: "errors.api.rateLimitRetry",
      // The id travels with every descriptor now: it was already being written to the
      // log for these kinds, and a sentence that cannot name it points at nothing.
      values: { seconds: 30, incident: error.incidentId },
    });
    // The upstream text names an internal host; it must not travel with the message.
    expect(JSON.stringify(descriptor)).not.toContain("backboard");
  });
});
