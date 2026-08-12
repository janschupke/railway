"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Lock, Trash2 } from "lucide-react";
import { spinDown, type ActionResult } from "@/app/dashboard/actions";
import { useDeploymentStream } from "@/hooks/use-deployment-stream";
import { isTerminal, isTransitioning, type Container } from "@/lib/railway/types";
import { relativeTime, cn } from "@/lib/utils";
import { LogPane } from "./log-pane";
import { StatusBadge } from "./status-badge";
import { Banner, Button, Input } from "./ui";

export function ContainerRow({
  container,
  projectId,
  environmentId,
}: {
  container: Container;
  projectId: string;
  environmentId: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    spinDown,
    null,
  );
  const panelId = useId();

  /*
   * Stream while the deployment is moving, or whenever the log pane is open. A settled
   * container that nobody is looking at holds no connection.
   */
  const serverState = container.state;
  const shouldStream =
    Boolean(container.deploymentId) && (expanded || isTransitioning(serverState));
  const phase = serverState === "building" ? "build" : "deploy";

  const stream = useDeploymentStream(
    container.deploymentId,
    phase,
    shouldStream,
  );

  // The stream is fresher than the last server render; prefer it once it has spoken.
  const state = stream.state ?? serverState;

  // Pull the authoritative list once the deployment settles, so names/sources refresh.
  useEffect(() => {
    if (stream.done && isTerminal(state)) router.refresh();
  }, [stream.done, state, router]);

  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const confirmMatches = confirmText.trim() === container.displayName;

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="focus-ring -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-subtle"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {container.displayName}
            </span>
            <span className="block truncate font-mono text-xs text-muted">
              {container.image ?? container.repo ?? "no source"}
            </span>
          </span>
        </button>

        <StatusBadge state={state} rawStatus={stream.rawStatus ?? container.rawStatus} />

        <span className="w-20 shrink-0 text-right text-xs text-muted">
          {relativeTime(container.updatedAt ?? container.createdAt)}
        </span>

        {container.managed ? (
          <Button
            variant="danger"
            onClick={() => setConfirming((v) => !v)}
            aria-expanded={confirming}
            disabled={pending || state === "removing"}
          >
            <Trash2 aria-hidden className="size-3.5" />
            {pending ? "Destroying…" : "Destroy"}
          </Button>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted"
            title="Only services created here can be destroyed here."
          >
            <Lock aria-hidden className="size-3.5" />
            Not managed here
          </span>
        )}
      </div>

      {confirming && container.managed && (
        <form
          action={formAction}
          onSubmit={() => setConfirming(false)}
          className="flex flex-wrap items-end gap-3 border-t border-border bg-subtle/50 px-4 py-3"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="environmentId" value={environmentId} />
          <input type="hidden" name="serviceId" value={container.serviceId} />
          <label className="flex flex-col gap-1.5 text-sm">
            <span>
              This permanently deletes the service. Type{" "}
              <code className="font-mono font-semibold">{container.displayName}</code>{" "}
              to confirm.
            </span>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={container.displayName}
              autoComplete="off"
              aria-label={`Type ${container.displayName} to confirm deletion`}
            />
          </label>
          <Button type="submit" variant="danger" disabled={!confirmMatches || pending}>
            {pending ? "Destroying…" : "Destroy permanently"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              setConfirmText("");
            }}
          >
            Cancel
          </Button>
        </form>
      )}

      {result && !result.ok && (
        <div className="px-4 pb-3">
          <Banner tone="error">{result.error}</Banner>
        </div>
      )}

      {expanded && (
        <div id={panelId} className="space-y-2 px-4 pb-4">
          {stream.error && <Banner tone="error">{stream.error}</Banner>}
          {stream.warning && <Banner tone="info">{stream.warning}</Banner>}
          {container.deploymentId ? (
            <LogPane
              lines={stream.logs}
              connected={stream.connected}
              emptyLabel={
                isTransitioning(state)
                  ? "Waiting for output…"
                  : "No log output for this deployment."
              }
            />
          ) : (
            <Banner tone="info">
              This service has no deployment yet, so there is nothing to stream.
            </Banner>
          )}
        </div>
      )}
    </li>
  );
}
