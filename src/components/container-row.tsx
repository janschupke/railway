"use client";

import { useEffect, useId, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ChevronDown, Info } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useDeploymentStream } from "@/hooks/use-deployment-stream";
import {
  isTerminal,
  isTransitioning,
  type Container,
  type ContainerState,
  type LogPhase,
} from "@/lib/railway/types";
import { cn, relativeTime } from "@/lib/utils";
import { DestroyContainerDialog } from "./destroy-container-dialog";
import { LogPaneSkeleton } from "./log-pane-skeleton";
import { StatusBadge } from "./status-badge";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { Text } from "./ui/text";

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
  // Without this the panel is empty until the chunk lands. The fallback is the pane's
  // own first frame, so expanding a row shows one continuous region rather than a gap.
  loading: () => <LogPaneSkeleton />,
});

/** Which of Railway's two log subscriptions a given state should be reading. */
function phaseFor(state: ContainerState): LogPhase {
  return state === "building" || state === "pending" ? "build" : "deploy";
}

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
  /*
   * Outlives `expanded` by one transition, because `hidden` is `display: none` and
   * nothing can be transitioned out of that — while it is also the only thing keeping a
   * collapsed panel out of the tab order and the a11y tree, so it cannot simply be
   * dropped. `expanded` is the user's intent and drives aria-expanded and the grid rows;
   * `mounted` is whether there is still something on screen to collapse.
   */
  const [mounted, setMounted] = useState(false);
  const panelId = useId();

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setMounted(true);
    /*
     * Two frames, not one. The first commits `mounted` — `hidden` comes off at
     * grid-rows 0fr — and the second flips to 1fr with a start value the transition can
     * interpolate from. Collapsing needs no equivalent: the panel is already laid out.
     */
    requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
  };

  /*
   * Backstop for an interrupted transition. Toggling faster than the animation means
   * `transitionend` may never fire, which would leave a zero-height panel mounted and
   * therefore in the tab order — invisible, and focusable.
   */
  useEffect(() => {
    if (expanded || !mounted) return;
    const timer = setTimeout(() => setMounted(false), 400);
    return () => clearTimeout(timer);
  }, [expanded, mounted]);

  /*
   * Stream while the deployment is moving, or whenever the log pane is open. A settled
   * container nobody is looking at holds no connection.
   */
  const shouldStream =
    Boolean(container.deploymentId) && (expanded || isTransitioning(container.state));

  /*
   * Phase follows the *stream's* view of the state, not the server render's.
   *
   * `container.state` is as old as the page. A container that Railway had only queued
   * when this page rendered is `pending`, and nothing re-renders the row from the server
   * mid-flight — so the row subscribed to deployment logs and sat empty through the whole
   * build, which is the output the person watching actually wanted.
   *
   * `pending` counts as build for the same reason: a queued deployment's next stop is
   * BUILDING, and guessing deploy on the strength of a stale queue status is how the row
   * ended up on the wrong subscription to begin with.
   */
  const [phase, setPhase] = useState<LogPhase>(() => phaseFor(container.state));
  const stream = useDeploymentStream(container.deploymentId, phase, shouldStream);

  // The stream is fresher than the last server render; prefer it once it has spoken.
  const state = stream.state ?? container.state;

  /*
   * Adjusted during render rather than in an effect. An effect would commit one render
   * on the wrong phase first, which opens an EventSource — and therefore takes one of a
   * handful of per-origin connections — only to close it on the next tick. React discards
   * this render instead and re-runs with the corrected phase before anything is attached.
   */
  const nextPhase = phaseFor(state);
  if (nextPhase !== phase) setPhase(nextPhase);

  /*
   * Pull the authoritative list once the deployment settles, so sources refresh.
   *
   * Deliberately NOT wrapped in a transition with a pending state, unlike the spin-up
   * and destroy refreshes. Nobody activated this: several rows can settle in the same
   * second, and a refresh suspends above the container boundary, so a busy state here
   * would be a page-wide signal attributable to no control the user touched. The badge
   * has already flipped from the stream by the time this runs, which is the signal that
   * matters.
   */
  useEffect(() => {
    if (stream.done && isTerminal(state)) router.refresh();
  }, [stream.done, state, router]);

  return (
    <li className="border-border border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="focus-ring hover:bg-subtle -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              // Same duration as the panel, so the two read as one gesture.
              "text-text-subtle duration-base size-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="min-w-0">
            {/* The name used to carry no size class at all, so it inherited 16px and
                sat four steps above the 12px source line directly under it. */}
            <Text variant="label" className="block truncate">
              {container.displayName}
            </Text>
            <Text variant="mono" tone="subtle" className="block truncate">
              {container.image ?? container.repo ?? t("noSource")}
            </Text>
          </span>
        </button>

        <StatusBadge
          state={state}
          rawStatus={stream.rawStatus ?? container.rawStatus}
        />

        <Text
          asChild
          variant="caption"
          tone="subtle"
          className="w-20 shrink-0 text-right"
        >
          <time
            // Relative time is computed from the client clock; the server's differs.
            suppressHydrationWarning
          >
            {relativeTime(container.updatedAt ?? container.createdAt, locale) ??
              tCommon("noValue")}
          </time>
        </Text>

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

        The open/close itself is a grid row going 0fr ↔ 1fr, which is the one way to
        transition to an unknown content height that works in every browser today. The
        panel is not a fixed size — the log pane is 256px, but stream error and warning
        banners sit above it — so a hardcoded max-height would either clip or ease from
        the wrong place. `interpolate-size: allow-keywords` would say this more directly
        and is a drop-in replacement here, but it is Chrome-only, and two mechanisms means
        two behaviours to test for a 200ms flourish.
      */}
      <div
        id={panelId}
        hidden={!mounted}
        data-panel-open={expanded}
        onTransitionEnd={(event) => {
          if (event.propertyName === "grid-template-rows" && !expanded) {
            setMounted(false);
          }
        }}
        className={cn(
          "duration-base grid transition-[grid-template-rows] ease-out",
          "data-[panel-open=false]:grid-rows-[0fr] data-[panel-open=true]:grid-rows-[1fr]",
        )}
      >
        {/* min-h-0 is what actually lets a grid row collapse to nothing. */}
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-2 px-4 pb-4">
            {mounted && (
              <>
                {stream.error && <Banner tone="error">{stream.error}</Banner>}
                {/*
                  The browser refused to open the stream and named nothing — a 400, a 401
                  or the per-user slot cap. It used to be indistinguishable from "still
                  dialling", which is a pane that waits forever on a connection nobody is
                  making.
                */}
                {!stream.error && stream.status === "closed" && !stream.done && (
                  <Banner tone="error">{t("streamUnavailable")}</Banner>
                )}
                {stream.warning && <Banner tone="info">{stream.warning}</Banner>}
                {container.deploymentId ? (
                  <LogPane
                    lines={stream.logs}
                    status={stream.status}
                    emptyLabel={t("waitingForOutput")}
                  />
                ) : (
                  <Banner tone="info">{t("noDeployment")}</Banner>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
