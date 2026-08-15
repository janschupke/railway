import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CreateProjectDialog } from "@/components/create-dialogs";
import { ProjectPicker } from "@/components/project-picker";
import { RefreshButton } from "@/components/refresh-button";
import { SignInButton } from "@/components/sign-in-button";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBlock } from "@/components/ui/error-block";
import { EmptyState } from "@/components/ui/misc";
import { PageMain } from "@/components/ui/page";
import { Heading } from "@/components/ui/text";
import { LINKS } from "@/lib/constants";
import type { DashboardShell } from "./dashboard-types";

/**
 * Everything the three dashboard tabs draw before their own content: the page heading, the
 * failure states, and the project and environment pickers.
 *
 * Not in dashboard/layout.tsx, and the reason is mechanical rather than stylistic: the
 * picker needs the *resolved* project and environment — the ones `loadDashboardShell`
 * chose after reading the query string — and a layout cannot read searchParams. So each
 * page runs the same four-line preamble and hands the resolved shell here. What keeps that
 * to one Railway round trip is the `cache()` on the loader, not this component.
 *
 * The tab strip is the half that CAN live in the layout, and does. See dashboard-tabs.tsx.
 *
 * `children` renders only on the has-projects branch. JSX is inert until rendered, so a
 * caller's `<ContainerSection/>` or `<BillingSection/>` issues no Railway read on the error
 * or empty paths — which is the behaviour page.tsx had when all of this was one file, and
 * the thing to check if that branch ever starts costing a request.
 */
export async function DashboardFrame({
  shell,
  children,
}: {
  shell: DashboardShell;
  children: React.ReactNode;
}) {
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");
  const tCreate = await getTranslations("createProject");
  const { projects, workspaces, error, errorKind, missingScopes } = shell;

  /*
   * The empty list has two causes that need opposite advice. Without project access
   * Railway reports nothing no matter how many projects exist, and re-consent is the
   * only fix; with it, the list is genuinely empty and re-consent changes nothing —
   * which is the loop this page used to send people round.
   *
   * The create action belongs on exactly one side of this line. `projectCreate` is
   * refused by the same withheld scope that produced the empty list on the denied branch,
   * so offering it there would be a second button that cannot work; on the genuinely-empty
   * branch it is the only thing that changes anything, which is why that branch leads with
   * it and demotes the retry.
   */
  const deniedProjectAccess = missingScopes.some(
    (scope) => scope === "project:admin" || scope === "workspace:viewer",
  );

  /*
   * The narrower half of the line above, and the create dialog needs it told apart.
   *
   * An empty workspace list has two causes with nothing in common: an account that has no
   * workspaces, where there is no choice to offer, and a token that was refused the scope
   * that lists them, where there is a choice and this app cannot see it. Only the second is
   * owed a sentence about why the project will be personal.
   *
   * Reachable only through the picker below. On the empty-state branch a withheld
   * `workspace:viewer` already makes `deniedProjectAccess` true, and that branch offers
   * re-consent rather than a create dialog.
   */
  const deniedWorkspaces = missingScopes.includes("workspace:viewer");

  /*
   * A failed project read means there is nothing to pick, nothing to spin up into and
   * nothing to list. The page used to render the whole interactive shell anyway —
   * `projects.length === 0 && !error` sent the failure case down the branch that draws
   * the pickers — so a broken authorization presented as an enabled Project dropdown
   * that opened an empty popup and explained nothing.
   *
   * Re-consent is offered only where it can help: a scope Railway withheld, or a
   * credential it rejected. A rate limit or an outage wants the retry, and pairing every
   * failure with a sign-in link is how "re-authorize" became the button that never works.
   */
  const reauthorizable = errorKind === "auth";

  /*
   * Two weights for the same escape hatch. On a plain card it is tertiary and stays
   * ghost; inside the tinted error block muted text on a danger surface reads as
   * disabled rather than quiet, so it takes the block's own weight.
   */
  const openRailwayLink = (
    <a href={LINKS.RAILWAY_DASHBOARD} target="_blank" rel="noreferrer">
      {t("openRailway")}
      <ExternalLink aria-hidden />
    </a>
  );
  const openRailway = (
    <Button asChild variant="ghost" size="sm">
      {openRailwayLink}
    </Button>
  );
  const openRailwayInError = (
    <Button asChild variant="danger" size="sm">
      {openRailwayLink}
    </Button>
  );

  return (
    <PageMain>
      {/*
        The page had no h1 at all — its highest heading was the container section's h2,
        so the document outline started at level two and the screen had no title.

        Invisible to every gate: axe's `page-has-heading-one` and `heading-order` are
        best-practice rules, and e2e/support.ts scans wcag tags only. The best-practice
        scan in e2e/a11y.spec.ts is what makes it stay fixed.

        Visually hidden rather than shown. The dashboard's subject is the project
        picker directly below, which names the project and environment far more usefully
        than a repeated app name would; a visible title here would be chrome restating
        what the next control already says. The outline and the screen-reader announce
        both need it to exist, which is what this does.

        One h1 for all three tabs, which is why it stays generic: the tab strip above
        already names which view this is, and a per-tab h1 would put the same word on
        screen twice for a reader who navigated with it.
      */}
      <Heading level={1} className="sr-only">
        {t("title")}
      </Heading>
      {error ? (
        <ErrorBlock
          message={error}
          actions={
            reauthorizable ? (
              <>
                <SignInButton
                  label={t("reauthorize")}
                  consent
                  variant="danger"
                  size="sm"
                />
                {openRailwayInError}
              </>
            ) : (
              <>
                <RefreshButton
                  label={tCommon("retry")}
                  pendingLabel={t("retryPending")}
                  variant="danger"
                  size="sm"
                />
                {openRailwayInError}
              </>
            )
          }
        />
      ) : (
        <>
          {shell.partialError && <Banner tone="warning">{shell.partialError}</Banner>}

          {shell.droppedSelection && (
            <Banner tone="warning">{t("droppedSelection")}</Banner>
          )}

          {projects.length === 0 ? (
            <Card>
              <EmptyState
                title={
                  deniedProjectAccess ? t("noProjectsScopeTitle") : t("noProjectsTitle")
                }
                description={
                  deniedProjectAccess
                    ? t("noProjectsScopeDescription", {
                        scopes: missingScopes.join(", "),
                      })
                    : t("noProjectsDescription")
                }
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {deniedProjectAccess ? (
                      <SignInButton
                        label={t("chooseProjects")}
                        consent
                        variant="primary"
                        size="sm"
                      />
                    ) : (
                      <>
                        {/*
                          The account is reachable and has nothing in it, so the useful
                          action is to put something in it. This used to lead with Check
                          again, which is the right answer only for the narrow case of a
                          project created elsewhere seconds ago — it stays, demoted.
                        */}
                        <CreateProjectDialog
                          variant="primary"
                          triggerLabel={tCreate("triggerFirst")}
                          workspaces={workspaces}
                          deniedWorkspaces={deniedWorkspaces}
                        />
                        {/* Asking Railway again is both cheaper and likelier to help
                              than a consent screen that already granted everything. */}
                        <RefreshButton
                          label={t("noProjectsRetry")}
                          pendingLabel={t("noProjectsRetryPending")}
                          variant="secondary"
                          size="sm"
                        />
                        <SignInButton
                          label={t("chooseProjects")}
                          consent
                          variant="ghost"
                          size="sm"
                        />
                      </>
                    )}
                    {openRailway}
                  </div>
                }
              />
            </Card>
          ) : (
            <>
              <ProjectPicker
                projects={projects}
                projectId={shell.project?.id ?? null}
                environmentId={shell.environment?.id ?? null}
                workspaces={workspaces}
                deniedWorkspaces={deniedWorkspaces}
              />

              {children}
            </>
          )}
        </>
      )}
    </PageMain>
  );
}
