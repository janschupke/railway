"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { generateDomain } from "@/app/dashboard/actions";
import { useToast } from "./ui/toast";
import { Button } from "./ui/button";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";

/**
 * The host without its scheme, for display only.
 *
 * `https://` is on every one of these — Railway terminates TLS for the domains it mints —
 * so rendering it would spend the width of eight characters on a constant, in the row's
 * most contested column. The href keeps the whole URL; only the label is shortened, which
 * is the direction that cannot mislead.
 *
 * Parsed rather than sliced. A `URL` that will not construct means this app produced a value
 * it does not understand, and falling back to the raw string shows the reader something true
 * rather than a substring of it.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Where a container answers, or the offer to give it somewhere.
 *
 * One slot with two states rather than a link here and a button in the row's action
 * cluster, and the reason is what the slot means: this line is the container's address. A
 * row that has one shows it; a row that could have one offers it, in the place the reader
 * is already looking for it. Putting the control in the action cluster instead would make it
 * the fifth button on rows that already carry Edit, two lifecycle verbs and Destroy — and
 * would separate "add an address" from the space where the address appears.
 *
 * Nothing at all for a container this app may not act on and that has no domain yet — the
 * offer would be one it cannot honour, and the row's Open in Railway is the honest route
 * there. That decision is NOT made here: see `canGenerate` below.
 *
 * No confirmation dialog, unlike every other write on this row. Stop, restart, redeploy and
 * destroy all interrupt or remove something that exists; this only adds, it is the cheapest
 * thing Railway will do here, and a domain nobody wanted is removed on Railway in two
 * clicks. Friction is priced in what it protects.
 */
export function ContainerUrl({
  url,
  serviceId,
  displayName,
  projectId,
  environmentId,
  canGenerate,
}: {
  /** The full `https://…`, or null when this container has no public address. */
  url: string | null;
  serviceId: string;
  displayName: string;
  projectId: string;
  environmentId: string;
  /**
   * Whether this row may mint a domain — decided by the row, not re-derived here.
   *
   * This used to be `managed`, and this component tested it itself. That made minting a
   * domain the one write on the row that answered the ownership question in its own file,
   * rather than in the branch that decides every other one — Edit, Stop, Restart, Redeploy
   * and Destroy all live under a single `container.managed` check in container-row.tsx.
   *
   * The server has always refused an unowned container here: `generateDomain` goes through
   * `withManagedContainer`, which re-reads the list from Railway before the verb runs. So
   * this is not a security boundary and never was. It is about there being ONE place a
   * reader can look to see which affordances a row is offering — a second copy of that
   * rule is the copy that would get it wrong, and it would get it wrong on the write with
   * no confirmation dialog in front of it.
   */
  canGenerate: boolean;
}) {
  const t = useTranslations("containers");
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const result = await generateDomain(null, formData);
      if (result.ok) {
        toast({ title: result.message, tone: "success" });
        /*
         * Inside the same transition as the action, so the button stays busy until the row
         * carrying the new URL has actually arrived. Split into a second transition, the
         * control would return to its resting state next to a row still showing no address.
         */
        router.refresh();
      } else {
        toast({
          title: t("generateDomainFailed"),
          description: result.error,
          tone: "error",
        });
      }
    });
  };

  if (url) {
    return (
      <Text asChild variant="mono" tone="subtle" className="block">
        {/*
          `link`, matching the name above rather than the row's buttons: this is navigation,
          and globals.css is explicit that underlining a control makes the two read as the
          same thing. Truncation on the inner span so the ellipsis eats the host rather than
          the icon that says the link leaves this app.
        */}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          /*
           * A label rather than an sr-only span beside the text, unlike the row's
           * not-managed tooltip which is deliberately a description.
           *
           * The visible text is a bare hostname, which out of the row's context says
           * nothing about which container it belongs to — so it needs to be named. Added as
           * a span, the two would concatenate and the accessible name would read the host
           * out twice. WCAG 2.5.3 Label in Name is satisfied either way: the label CONTAINS
           * the visible text, which is what that criterion asks and why the host is
           * interpolated into the sentence rather than replaced by a description of it.
           */
          aria-label={t("publicUrl", { name: displayName, host: hostOf(url) })}
          className="focus-ring link inline-flex max-w-full items-center gap-1"
        >
          <span className="truncate">{hostOf(url)}</span>
          <ExternalLink aria-hidden className="size-3 shrink-0" />
        </a>
      </Text>
    );
  }

  if (!canGenerate) return null;

  return (
    <form action={submit}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <input type="hidden" name="serviceId" value={serviceId} />
      {/*
        No port field, deliberately. The action derives it from the image it reads back from
        Railway, so the browser cannot name the port a domain points at — the same rule the
        credential minting follows. See `generateDomain`.
      */}
      <PendingStatus
        className="sr-only"
        label={pending ? t("generateDomainAnnounce", { name: displayName }) : undefined}
      />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        pending={pending}
        pendingLabel={t("generateDomainPending")}
      >
        <Globe aria-hidden />
        {t("generateDomain")}
      </Button>
    </form>
  );
}
