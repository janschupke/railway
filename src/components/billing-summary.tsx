import { ExternalLink } from "lucide-react";
import { Card } from "./ui/card";
import { Heading, Text } from "./ui/text";

/**
 * The two readouts on the billing tab, and the line that has to stay between them.
 *
 * They are separate cards on purpose, and this is the one thing about this file worth
 * arguing over in review. The spend figure is workspace-wide and the usage figure covers
 * only the containers this app created; put side by side in one panel they read as a pair
 * — "here is what you are using and here is what it costs" — which is precisely the
 * misreading container-section.tsx used to guard against by keeping the spend sentence at
 * the foot of the list. Two cards, two headings that name their own scope, and a scope
 * sentence inside each is what replaces that separation now they share a page.
 *
 * Presentational: every figure arrives already formatted, because the currency, the dates
 * and the vCPU/memory units all need the request's locale, and that is a server read.
 */

/** One label/value pair. Six of them across the two cards, so it is a component. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Text asChild variant="caption" tone="subtle">
        <dt>{label}</dt>
      </Text>
      <Text asChild variant="body">
        <dd>{value}</dd>
      </Text>
    </div>
  );
}

export function SpendCard({
  heading,
  /**
   * The figure and its supporting pairs, or null when Railway will not say.
   *
   * A personal project has no workspace, and a token without `workspace:viewer` cannot read
   * one. The two render identically on purpose: from the reader's side they are the same
   * situation — the number is not available here, it is over there — and neither is an
   * error, because an absent cost figure is not something they can act on in this app.
   */
  amount,
  amountLabel,
  periodLabel,
  period,
  workspaceLabel,
  workspace,
  caveat,
  unavailable,
  billingHref,
  billingLabel,
}: {
  heading: string;
  amount: string | null;
  amountLabel: string;
  periodLabel: string;
  period: string;
  workspaceLabel: string;
  workspace: string;
  caveat: string;
  unavailable: string;
  billingHref: string;
  billingLabel: string;
}) {
  return (
    <Card className="space-y-3 p-4">
      <Heading level={2}>{heading}</Heading>

      {amount === null ? (
        <Text asChild variant="body" tone="muted">
          <p>{unavailable}</p>
        </Text>
      ) : (
        <>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {/* The amount leads, at display weight, because it is the one number a reader
                opens this tab for. The other two qualify it. */}
            <div className="flex flex-col gap-0.5">
              <Text asChild variant="caption" tone="subtle">
                <dt>{amountLabel}</dt>
              </Text>
              <Text asChild variant="title">
                <dd>{amount}</dd>
              </Text>
            </div>
            <Figure label={periodLabel} value={period} />
            <Figure label={workspaceLabel} value={workspace} />
          </dl>

          {/*
            Not padding. This is the answer to "why does this not match my container
            list", said once here instead of many times in an issue tracker: Railway
            reports no per-project or per-container cost, so the figure above necessarily
            includes services this app did not create.
          */}
          <Text asChild variant="caption" tone="subtle">
            <p>{caveat}</p>
          </Text>
        </>
      )}

      <Text asChild variant="body">
        <p>
          <a
            href={billingHref}
            target="_blank"
            rel="noreferrer"
            className="focus-ring link inline-flex items-center gap-1"
          >
            {billingLabel}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </p>
      </Text>
    </Card>
  );
}

export function UsageCard({
  heading,
  /** Null when Railway reported nothing for these containers — absent, not zero. */
  cpu,
  cpuLabel,
  memory,
  memoryLabel,
  containers,
  containersLabel,
  scope,
  none,
}: {
  heading: string;
  cpu: string | null;
  cpuLabel: string;
  memory: string | null;
  memoryLabel: string;
  containers: string;
  containersLabel: string;
  scope: string;
  none: string;
}) {
  return (
    <Card className="space-y-3 p-4">
      <Heading level={2}>{heading}</Heading>

      {cpu === null || memory === null ? (
        /*
         * Nothing running, metrics refused, and a project with no containers of ours all
         * produce the same nothing — and "0.00 vCPU across 0 containers" is a sentence
         * with no content that reads as a claim about idle infrastructure someone is
         * paying for.
         */
        <Text asChild variant="body" tone="muted">
          <p>{none}</p>
        </Text>
      ) : (
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure label={cpuLabel} value={cpu} />
          <Figure label={memoryLabel} value={memory} />
          <Figure label={containersLabel} value={containers} />
        </dl>
      )}

      {/*
        The negative claim, and it is required rather than decorative. These figures sit on
        the same screen as a dollar amount, and without a sentence saying they are neither
        the same scope nor the basis of that amount, the two read as one readout.
      */}
      <Text asChild variant="caption" tone="subtle">
        <p>{scope}</p>
      </Text>
    </Card>
  );
}
