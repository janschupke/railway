"use client";

import { useEffect, useId, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ChevronDown, Info } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useDeploymentStream } from "@/hooks/use-deployment-stream";
import { isTerminal, isTransitioning, type Container } from "@/lib/railway/types";
import { cn, relativeTime } from "@/lib/utils";
import { DestroyContainerDialog } from "./destroy-container-dialog";
import { StatusBadge } from "./status-badge";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

/*
 * The log pane only mounts once a row is expanded, and it drags Radix ScrollArea in
 * with it — so loading it with the dashboard made every visitor pay for a panel most
 * of them never open.
 *
 * `ssr: false` is deliberate: it is gated on `expanded`, which is always false on the
 * server, so there is nothing to hydrate and no flash to avoid.
 *
 * Tooltip is *not* deferred, even though it is also Radix: it wraps the button rather
 * than replacing it, so a lazy version would blank out a visible control while its
 * chunk loaded.
 */
const LogPane = dynamic(() => import("./log-pane").then((m) => m.LogPane), {
  ssr: false,
});

/**
 * One container in the list.
 *
 * Presentation and stream attachment only — confirmation lives in
 * DestroyContainerDialog and log rendering in LogPane, so each has one job.
 */
export function ContainerRow({
  container,
  projectId,
  environmentId,
}: {
  container: Container;
  projectId: string;
  environmentId: string;
}) {
  const t = useTranslations("containers");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  /*
   * Stream while the deployment is moving, or whenever the log pane is open. A settled
   * container nobody is looking at holds no connection.
   */
  const shouldStream =
    Boolean(container.deploymentId) && (expanded || isTransitioning(container.state));
  const phase = container.state === "building" ? "build" : "deploy";

  const stream = useDeploymentStream(container.deploymentId, phase, shouldStream);

  // The stream is fresher than the last server render; prefer it once it has spoken.
  const state = stream.state ?? container.state;

  // Pull the authoritative list once the deployment settles, so sources refresh.
  useEffect(() => {
    if (stream.done && isTerminal(state)) router.refresh();
  }, [stream.done, state, router]);

  return (
    <li className="border-border border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="focus-ring hover:bg-subtle -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "text-text-subtle size-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="min-w-0">
            <span className="text-text block truncate font-medium">
              {container.displayName}
            </span>
            <span className="text-text-subtle block truncate font-mono text-xs">
              {container.image ?? container.repo ?? t("noSource")}
            </span>
          </span>
        </button>

        <StatusBadge
          state={state}
          rawStatus={stream.rawStatus ?? container.rawStatus}
        />

        <time
          className="text-text-subtle w-20 shrink-0 text-right text-xs"
          // Relative time is computed from the client clock; the server's value differs.
          suppressHydrationWarning
        >
          {relativeTime(container.updatedAt ?? container.createdAt, locale) ??
            tCommon("noValue")}
        </time>

        {container.managed ? (
          <DestroyContainerDialog
            serviceId={container.serviceId}
            displayName={container.displayName}
            projectId={projectId}
            environmentId={environmentId}
            disabled={state === "removing"}
          />
        ) : (
          /*
           * No aria-label here. Overriding the name with a differently-worded question
           * left the accessible name sharing no words with the visible text, so voice
           * control could not address the control it can see (WCAG 2.5.3 Label in
           * Name). The tooltip supplies the explanation as a description instead.
           */
          <Tooltip content={t("notManagedTooltip")}>
            <Button variant="ghost" size="sm">
              <Info aria-hidden />
              {t("notManaged")}
            </Button>
          </Tooltip>
        )}
      </div>

      {/*
        Always rendered, toggled with `hidden`: aria-controls must point at an element
        that exists in both states, and the collapsed panel had no node to point at.
      */}
      <div id={panelId} hidden={!expanded} className="space-y-2 px-4 pb-4">
        {expanded && (
          <>
            {stream.error && <Banner tone="error">{stream.error}</Banner>}
            {stream.warning && <Banner tone="info">{stream.warning}</Banner>}
            {container.deploymentId ? (
              <LogPane
                lines={stream.logs}
                connected={stream.connected}
                emptyLabel={
                  isTransitioning(state) ? t("waitingForOutput") : t("noLogOutput")
                }
              />
            ) : (
              <Banner tone="info">{t("noDeployment")}</Banner>
            )}
          </>
        )}
      </div>
    </li>
  );
}
