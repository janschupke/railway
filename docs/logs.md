# Logs

One JSON object per line on stdout, which is what Railway captures. The decision behind this
shape — pino, stdout only, an OTel seam cut but unused — is
[ADR-9](adr/0009-structured-logs-on-stdout.md); what is never logged and how errors are
reported is [`.ai/rules/errors-and-logging.md`](../.ai/rules/errors-and-logging.md). This file
is the field reference.

Locally, `pnpm dev:pretty` pipes it through `pino-pretty` — a devDependency and a pipe, never a
pino _transport_, because a transport runs in a worker thread and that is precisely the thing
Next externalizes pino to work around.

```
{"level":"info","time":1786543673062,"service":"container-console","env":"production",
 "version":"9f7f505","request_id":"a1b2c3d4e5f60718","subject_id":"user_42",
 "route":"spinUp","project_id":"p_1","environment_id":"e_1",
 "service_name":"spun-api","image":"nginx:1.27","service_id":"svc_9",
 "msg":"container.created"}
```

| Field                       | What it is                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `msg`                       | The event name, from a bounded set — the field to build a Loki label on                                              |
| `level`, `time`             | String label, epoch ms. Both pino defaults, left alone so the OTel bridge reads them                                 |
| `service`, `env`, `version` | Map onto OTel's `service.name` / `deployment.environment.name` / `service.version`                                   |
| `request_id`                | Joins a proxy line to the render and stream lines that follow it                                                     |
| `subject_id`                | The OIDC subject. Never the email or the display name                                                                |
| `route`                     | The static route pattern, not the concrete path — bounded cardinality                                                |
| `incident`                  | The id the user is shown. `jq 'select(.incident=="abc12345")'` finds its line                                        |
| `err.*`                     | `type`, `message`, `stack`, and for a Railway failure `kind`, `status`, `operation`, `code`, `path`, `missing_scope` |

`LOG_LEVEL` is `silent | error | warn | info | debug | trace`, defaulting to `info` in production
and `debug` elsewhere. The Railway client's per-request timing and the steady-state poll failures
sit at `debug` deliberately — at `info` they would be the dominant volume in the system.

A misconfigured deployment says so. `env()` throws in the proxy before `/api/health` can answer,
so the app used to return an unlogged 500; it emits one `proxy.env_invalid` record naming the
variables (never their values), once per process rather than on every healthcheck.

## Getting to Grafana from here

A deployment change and no code change: add the OTel packages, add `register()` to the
[src/instrumentation.ts](../src/instrumentation.ts) this already created, and point Alloy at
Railway's log drain (`stage.json` → labels on `level`/`service`/`env` → structured metadata for
`request_id`/`incident`/`subject_id`).

`trace_id`, `span_id` and `trace_flags` are left unwritten on purpose:
`@opentelemetry/instrumentation-pino` injects exactly those, and hand-rolling them now would mean
two spellings of one concept later.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
