"use client";

import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useDeploymentStream } from "@/hooks/use-deployment-stream";
import { useThrottledRefresh } from "@/hooks/use-throttled-refresh";
import {
  isDeploymentStep,
  isTerminal,
  isTransitioning,
  type Container,
  type ContainerMetrics,
  type ContainerState,
  type ContainerVolume,
  type LogPhase,
} from "@/lib/railway/types";
import { railwayServiceUrl } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { useVolumeSize } from "@/hooks/use-volume-size";
import { cn } from "@/lib/utils";
import { ContainerActions } from "./container-actions";
import { ContainerMetricsReadout } from "./container-metrics";
import { ContainerUrl } from "./container-url";
import { LogPaneSkeleton } from "./log-pane-skeleton";
import { StatusBadge } from "./status-badge";
import { Banner } from "./ui/banner";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { ErrorBlock } from "./ui/error-block";
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
  metrics,
  volume,
  selected = false,
  onSelectedChange,
}: {
  container: Container;
  projectId: string;
  environmentId: string;
  /** Whether this row is part of the list's current selection. */
  selected?: boolean;
  /**
   * Absent means this row cannot be selected, and is the only thing that decides it.
   *
   * The list passes a handler to the rows it may act on and nothing to the rest, so "which
   * rows have a checkbox" is answered once, where the selection lives, rather than by each
   * row re-deriving it from `container.managed`. A row that could tick itself into a
   * selection the list would then have to filter back out is the state this avoids.
   */
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Passed in rather than read from the container, because it is deliberately not on it —
   * see ContainerMetrics on what a fluctuating value in the watch fingerprint would cost.
   * Undefined means Railway reported nothing for this service, which the readout renders.
   */
  metrics: ContainerMetrics | undefined;
  /**
   * Off `Container` for the same reason `metrics` is: `currentSizeMB` grows as the database
   * is written to, and the watch fingerprint hashes containers. Undefined means this
   * container has no volume — or that the read was refused, which the row renders the same
   * way and the destroy dialog degrades to keeping the data.
   */
  volume: ContainerVolume | undefined;
}) {
  const t = useTranslations("containers");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const refresh = useThrottledRefresh();
  const sized = useVolumeSize();
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

  /*
   * Which way the panel is currently travelling.
   *
   * `mounted && !expanded` is TWO different states — one frame into opening, and one
   * transition away from closed — and without this ref the backstop below could not tell
   * them apart. It assumed closing, so a machine that delayed the frames past the timer
   * ran `setMounted(false)` on a panel that was opening; the rAF then set `expanded`
   * true against an unmounted panel and the row stuck there, `aria-expanded="true"` over
   * a `hidden` region with no way back short of a reload. A ref rather than state
   * because it must be readable inside the frame callback without re-running it.
   */
  const intent = useRef<"open" | "closed">("closed");

  const toggle = () => {
    if (expanded) {
      intent.current = "closed";
      setExpanded(false);
      return;
    }
    intent.current = "open";
    setMounted(true);
    /*
     * Two frames, not one. The first commits `mounted` — `hidden` comes off at
     * grid-rows 0fr — and the second flips to 1fr with a start value the transition can
     * interpolate from. Collapsing needs no equivalent: the panel is already laid out.
     */
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // A close that landed while these frames were queued wins; opening now would
        // re-expand a panel the user has already dismissed.
        if (intent.current === "open") setExpanded(true);
      }),
    );
  };

  /*
   * Backstop for an interrupted transition. Toggling faster than the animation means
   * `transitionend` may never fire, which would leave a zero-height panel mounted and
   * therefore in the tab order — invisible, and focusable.
   */
  useEffect(() => {
    if (expanded || !mounted || intent.current === "open") return;
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
   * What a failed row says, from the four things Railway may have told us.
   *
   * The step is a bounded enum, so it is a catalog lookup — the same shape StatusBadge
   * uses for `states.${state}`. `isDeploymentStep` is what keeps that safe: Railway adds
   * enum members without notice, and an unknown one falls to the reason-only branch rather
   * than rendering a missing-message marker at the user.
   *
   * The reason is an ICU *value*, never a key. It is Railway's own words, bounded on the
   * server, and it renders as a text child so React escapes it — it is never a href, an
   * attribute, or markup. See the accepted risk in SECURITY.md.
   */
  const failureStep = isDeploymentStep(stream.failure?.step)
    ? stream.failure.step
    : null;
  const failureReason = stream.failure?.reason ?? null;
  const stepLabel = failureStep ? t(`deploymentStep.${failureStep}`) : null;
  const failureMessage =
    stepLabel && failureReason
      ? t("failedWithReason", { step: stepLabel, reason: failureReason })
      : stepLabel
        ? t("failedAtStep", { step: stepLabel })
        : failureReason
          ? t("failedReasonOnly", { reason: failureReason })
          : t("failedExplanation");

  /*
   * Pull the authoritative list once the deployment settles, so sources refresh.
   *
   * Deliberately NOT wrapped in a transition with a pending state, unlike the spin-up
   * and destroy refreshes. Nobody activated this: several rows can settle in the same
   * second, and a refresh suspends above the container boundary, so a busy state here
   * would be a page-wide signal attributable to no control the user touched. The badge
   * has already flipped from the stream by the time this runs, which is the signal that
   * matters.
   *
   * "Several rows can settle in the same second" was written as a reason not to show a
   * pending state, and was also a request storm nobody had costed: this is per row, on a
   * force-dynamic route, so N rows settling meant 2N Railway round trips plus whatever
   * the project watcher fired for the same event. The throttle is shared across the tab
   * — see use-throttled-refresh — so they now coalesce into one.
   */
  useEffect(() => {
    if (stream.done && isTerminal(state)) refresh();
  }, [stream.done, state, refresh]);

  return (
    <li className="border-border border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        {/*
          Two controls, not one.

          The name used to be the label of the disclosure button, which made it the one
          thing on a row that could not also be a link — and Railway's own page for the
          service was reachable only from a failed row's expanded panel. An anchor cannot
          nest inside a button, so the disclosure gave the name up and kept the chevron.

          What that costs: the expand target shrinks from the whole name block to the
          chevron, and each row gains a tab stop. What it buys: every container, not just
          the broken ones, has a route to the page that can answer questions this app's
          single-enum view of a deployment cannot.
        */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/*
            The selection box, and the empty slot that stands in for it.

            Only a managed row can be destroyed, so only a managed row gets one — a checkbox
            on a service this app cannot touch would be a selection that can never lead
            anywhere. The unmanaged row renders a box of the same size instead, because the
            alternative is every name in the list sitting on one axis except the ones that
            are not ours, which reads as a rendering fault rather than as a distinction.

            `size-3.5` matches the input inside Checkbox; the gap comes from the flex row.
          */}
          {onSelectedChange ? (
            <Checkbox
              hideLabel
              label={t("selectRow", { name: container.displayName })}
              checked={selected}
              onChange={(event) => onSelectedChange(event.target.checked)}
              className="shrink-0"
            />
          ) : (
            <span aria-hidden className="size-3.5 shrink-0" />
          )}

          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            // p-1.5 around a 16px icon is a 28px target; p-1 would sit exactly on the
            // 24px floor, with nothing left for the next person who nudges the icon.
            className="focus-ring hover:bg-subtle -ml-1 shrink-0 rounded-md p-1.5"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                // Same duration as the panel, so the two read as one gesture.
                "text-text-subtle duration-base size-4 shrink-0 transition-transform",
                expanded && "rotate-180",
              )}
            />
            {/*
              The whole accessible name, since the chevron carries no visible text. No
              WCAG 2.5.3 conflict of the kind the Info button below documents: there is
              no visible label here for this wording to contradict.
            */}
            <span className="sr-only">
              {t("toggleLogs", { name: container.displayName })}
            </span>
          </button>

          <span className="min-w-0">
            {/* The name used to carry no size class at all, so it inherited 16px and
                sat four steps above the 12px source line directly under it. */}
            <Text asChild variant="label">
              {/*
                `link`, not `Button asChild` — this is navigation, and the utility's
                docblock in globals.css is explicit that underlining a control would make
                the two read as the same thing. Truncation lives on the inner span so the
                ellipsis eats the name rather than the icon that explains where it goes.
              */}
              <a
                href={railwayServiceUrl({
                  projectId,
                  serviceId: container.serviceId,
                  environmentId,
                })}
                target="_blank"
                rel="noreferrer"
                className="focus-ring link inline-flex max-w-full items-center gap-1"
              >
                <span className="truncate">{container.displayName}</span>
                <ExternalLink
                  aria-hidden
                  className="text-text-subtle size-3.5 shrink-0"
                />
              </a>
            </Text>
            <Text variant="mono" tone="subtle" className="block truncate">
              {container.image ?? container.repo ?? t("noSource")}
            </Text>
            {/*
              Under the source, not out in the action cluster.

              This is the container's address, and the block above it is already the
              container's identity — what it is called and what it runs. A URL belongs to
              that sentence rather than beside the buttons that stop and destroy it, and the
              cluster is at four controls on a running managed row before anything else is
              added to it.

              The same slot holds the offer when there is no address yet, so the place a
              reader looks for a URL either has one or explains how to get one.
            */}
            <ContainerUrl
              url={container.url}
              serviceId={container.serviceId}
              displayName={container.displayName}
              projectId={projectId}
              environmentId={environmentId}
              managed={container.managed}
            />
          </span>
        </div>

        <StatusBadge
          state={state}
          rawStatus={stream.rawStatus ?? container.rawStatus}
        />

        <Text
          asChild
          variant="caption"
          tone="subtle"
          /*
           * `min-w-`, and `whitespace-nowrap` alongside it.
           *
           * At 12px "34 minutes ago" measures about 78px against the 80px box this used
           * to be, with wrapping left on — so the longest values in the commonest unit
           * broke across two lines and grew the row. A fixed width plus nowrap would fix
           * English and hide the same failure everywhere else: the text would simply
           * overflow into the status badge, silently. The floor keeps the column aligned
           * for every value Intl produces in English; the absence of a ceiling is what
           * keeps a longer locale honest, taking the space it needs from the flex row.
           */
          className="min-w-24 shrink-0 text-right whitespace-nowrap"
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
          /*
           * `state` rather than `container.state`: the stream is fresher than the last
           * server render, and a row that has just finished deploying must offer Stop
           * rather than the Redeploy its stale status would have earned.
           */
          <ContainerActions
            serviceId={container.serviceId}
            displayName={container.displayName}
            image={container.image}
            deploymentId={container.deploymentId}
            state={state}
            projectId={projectId}
            environmentId={environmentId}
            /*
             * Undefined when the container has no volume, which is what makes the destroy
             * dialog render no checkbox and post no field. Formatted here rather than
             * inside the dialog so that the two places stating this volume's size — the
             * readout below and the confirmation — go through one hook.
             */
            volumeSize={volume && sized(volume.sizeMB)}
          />
        ) : (
          /*
           * The slot every other row uses to act, holding the one action this row has.
           *
           * It used to be a button that said "Not managed here" and did nothing when
           * pressed — a control whose whole content was an explanation of why it was not
           * a control. The information is worth keeping and the affordance was a lie:
           * something that looks like a button and answers a click with nothing is read
           * as broken long before it is read as a note.
           *
           * Railway's own page is genuinely what a reader wants next here, since this
           * service cannot be destroyed from this app. The name above links to the same
           * place, which is not a reason to leave this slot dead: the name is navigation
           * inside a sentence, and this is the row's action, in the column where every
           * other row keeps one.
           *
           * The tooltip still carries the explanation — it is the answer to "where is my
           * Destroy button", which is the question this row actually raises. As a
           * description rather than a label, so the accessible name stays the visible
           * text (WCAG 2.5.3 Label in Name).
           */
          <Tooltip content={t("notManagedTooltip")}>
            <Button variant="secondary" size="sm" asChild>
              <a
                href={railwayServiceUrl({
                  projectId,
                  serviceId: container.serviceId,
                  environmentId,
                })}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink aria-hidden />
                {t("openInRailway")}
              </a>
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
                {/*
                  A terminal failure says what it can, and where the rest of it is.

                  The deployment query answers this app with one enum member, so the reason
                  comes from a second, best-effort read of Railway's deployment-event feed
                  once the deployment has settled as failed. That read can come back empty,
                  refused or withdrawn, and the four branches below are those outcomes: a
                  step and a reason, a step alone, a reason alone, or neither — which is the
                  sentence this block has always shown.

                  "Open in Railway" is unconditional in every branch. Even a named reason is
                  one bounded line of what Railway's own page holds in full, so the link is
                  not a fallback the reason replaces.

                  ErrorBlock rather than Banner because this one has an action attached:
                  Banner is a <p> and cannot legally hold a control — see its docblock for
                  the stranded Retry that taught us.

                  Driven by `state`, which prefers the stream but falls back to the server
                  render, so a row that was already failed when the page loaded gets this
                  on expand without a stream ever having spoken. The reason itself needs the
                  stream, so it arrives on expand rather than on page load.
                */}
                {state === "failed" && (
                  <ErrorBlock
                    message={failureMessage}
                    actions={
                      <Button asChild variant="danger" size="sm">
                        <a
                          href={railwayServiceUrl({
                            projectId,
                            serviceId: container.serviceId,
                            environmentId,
                          })}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("openInRailway")}
                          <ExternalLink aria-hidden />
                        </a>
                      </Button>
                    }
                  />
                )}
                {/*
                  Above the pane, not beside it. The pane is lazily loaded behind a
                  skeleton, so a column next to it would reflow when the chunk lands; this
                  also means the panel has something in it during that first frame.
                */}
                <ContainerMetricsReadout
                  metrics={metrics}
                  volume={volume}
                  state={state}
                  deployedAt={container.deployedAt}
                  name={container.displayName}
                />
                {container.deploymentId ? (
                  <LogPane
                    lines={stream.logs}
                    status={stream.status}
                    emptyLabel={t("waitingForOutput")}
                    label={container.displayName}
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
