import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  execute,
  operationCounts,
  operationNameOf,
  resetOperationCounts,
} from "./graphql";
import {
  authorize,
  discoveryDocument,
  getKeys,
  resetOidc,
  stats,
  token,
  userinfo,
} from "./oidc";
import { Store, TICK_MS } from "./store";

/**
 * Stand-in Railway for the end-to-end suite: OIDC provider, GraphQL API and
 * graphql-transport-ws endpoint on one port.
 *
 * The app points at it through RAILWAY_ISSUER / RAILWAY_API_URL / RAILWAY_WS_URL, so
 * every line of production code — the OAuth flow, the client's retry and error
 * handling, the log subscription — runs unmodified against it.
 *
 * `POST /__test/faults` injects failures (rate limits, revoked authorizations, failed
 * builds) so the unhappy paths are testable rather than aspirational.
 */

const PORT = Number(process.env.FAKE_RAILWAY_PORT ?? 4010);
const CLIENT_ID = process.env.RAILWAY_CLIENT_ID ?? "e2e-client";
const ISSUER = `http://localhost:${PORT}`;

const store = new Store();

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

/** Returns a fault response to serve instead of the real one, if one is queued. */
function takeFault(): { status: number; body: unknown } | null {
  if (store.faults.unauthorized > 0) {
    store.faults.unauthorized -= 1;
    return { status: 401, body: { errors: [{ message: "Not authorized" }] } };
  }
  if (store.faults.rateLimit > 0) {
    store.faults.rateLimit -= 1;
    return { status: 429, body: { errors: [{ message: "Rate limited" }] } };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", ISSUER);

  if (url.pathname === "/oauth/.well-known/openid-configuration") {
    return json(res, 200, discoveryDocument(ISSUER));
  }

  if (url.pathname === "/oauth/jwks") {
    return json(res, 200, (await getKeys()).jwks);
  }

  if (url.pathname === "/oauth/auth") {
    const result = authorize(url);
    if ("error" in result) return json(res, 400, { error: result.error });
    res.writeHead(302, { location: result.location });
    return res.end();
  }

  if (url.pathname === "/oauth/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const result = await token(params, { issuer: ISSUER, clientId: CLIENT_ID, store });
    return result.ok
      ? json(res, 200, result.body)
      : json(res, result.status, result.body);
  }

  if (url.pathname === "/oauth/me") {
    return json(res, 200, userinfo());
  }

  if (url.pathname === "/graphql/v2" && req.method === "POST") {
    if (store.faults.slowMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, store.faults.slowMs));
    }

    const fault = takeFault();
    if (fault) return json(res, fault.status, fault.body);

    const body = JSON.parse((await readBody(req)) || "{}") as {
      query?: string;
      variables?: Record<string, unknown>;
      operationName?: string;
    };
    const name = operationNameOf(body.query ?? "", body.operationName);
    return json(res, 200, execute(name, body.variables ?? {}, store));
  }

  // ---- test control plane ----
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    store.reset();
    resetOidc();
    resetOperationCounts();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/__test/stats") {
    return json(res, 200, { ...stats, operations: operationCounts });
  }

  /*
   * Service records, including the environment each was created with.
   *
   * Read out of band rather than off the page on purpose: a spec needs to prove that a
   * generated credential reached Railway *and* that it never reached the browser, and it
   * cannot do both if the only way to see it is to render it.
   */
  if (url.pathname === "/__test/services" && req.method === "POST") {
    /*
     * Creates a service the way Railway's own dashboard would — behind this app's back.
     * That is exactly the case the project watcher exists for, and there is no other way
     * to produce it from a spec: driving the app's own form would be the app noticing
     * its own change.
     */
    const input = JSON.parse((await readBody(req)) || "{}") as {
      name: string;
      projectId?: string;
      environmentId?: string;
      image?: string;
      /**
       * How many to make, named `${name}-${i}`. One request rather than forty, because a
       * paged list needs more services than the seed holds and forty round trips per
       * spec is the kind of setup cost that gets a suite abandoned.
       */
      count?: number;
      /** Parks each deployment at this status; see Store.addService. */
      status?: string;
    };

    const make = (name: string) =>
      store.addService({
        name,
        projectId: input.projectId ?? "proj_demo",
        environmentId: input.environmentId ?? "env_prod",
        image: input.image ?? "redis:7-alpine",
        deployed: true,
        ...(input.status ? { status: input.status } : {}),
      });

    if (input.count && input.count > 1) {
      // Zero-padded, so "service-2" cannot also match "service-20" in a spec's locator.
      const width = String(input.count - 1).length;
      return json(
        res,
        200,
        Array.from({ length: input.count }, (_, i) =>
          make(`${input.name}-${String(i).padStart(width, "0")}`),
        ),
      );
    }

    return json(res, 200, make(input.name));
  }

  if (url.pathname === "/__test/services") {
    return json(res, 200, [...store.services.values()]);
  }

  if (url.pathname === "/__test/faults" && req.method === "POST") {
    const patch = JSON.parse((await readBody(req)) || "{}");
    store.faults = { ...store.faults, ...patch };
    /*
     * The one fault that is a state change rather than a response filter. `projectsEmpty`
     * means the account holds nothing — so it empties the store here, once, instead of
     * being consulted on every read. That is what lets a project created later in the same
     * spec show up: the create pushes into the list this cleared, and both sources answer
     * with it exactly as Railway would.
     */
    if (patch.projectsEmpty === true) store.projects = [];
    return json(res, 200, store.faults);
  }

  json(res, 404, { error: "not_found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    json(res, 500, { error: String(error) });
  });
});

/**
 * graphql-transport-ws, hand-rolled.
 *
 * Only connection_init/ack, subscribe, next and complete are needed. Log frames are
 * pushed as the store's timer advances the deployment, so the client sees a genuine
 * push stream rather than a poll dressed up as one.
 */
const wss = new WebSocketServer({ server, path: "/graphql/v2" });

wss.on("connection", (socket: WebSocket) => {
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as {
      id?: string;
      type: string;
      payload?: { query?: string; variables?: Record<string, unknown> };
    };

    if (message.type === "connection_init") {
      socket.send(JSON.stringify({ type: "connection_ack" }));
      return;
    }

    if (message.type === "subscribe" && message.id) {
      const id = message.id;
      const deploymentId = String(message.payload?.variables?.deploymentId ?? "");
      const isBuild = /buildLogs/.test(message.payload?.query ?? "");
      const field = isBuild ? "buildLogs" : "deploymentLogs";
      const phase = isBuild ? "build" : "deploy";

      // Per subscription, so the two phases advance independently — which is the point
      // of the split: a subscription to the empty phase must stay empty.
      let sent = 0;
      const push = () => {
        const deployment = store.deployments.get(deploymentId);
        if (!deployment) return;
        const lines = deployment.logs[phase];
        const fresh = lines.slice(sent);
        if (fresh.length === 0) return;
        sent = lines.length;
        socket.send(
          JSON.stringify({ id, type: "next", payload: { data: { [field]: fresh } } }),
        );
      };

      const timer = setInterval(push, TICK_MS / 2);
      timer.unref?.();
      timers.set(id, timer);
      push();
      return;
    }

    if (message.type === "complete" && message.id) {
      const timer = timers.get(message.id);
      if (timer) clearInterval(timer);
      timers.delete(message.id);
    }
  });

  socket.on("close", () => {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
  });
});

store.start();
server.listen(PORT, () => {
  console.log(`fake-railway listening on ${ISSUER}`);
});

const shutdown = () => {
  store.stop();
  wss.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
