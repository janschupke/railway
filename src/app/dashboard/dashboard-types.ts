/**
 * What the two dashboard loaders hand the page, and what each field means when it is empty.
 *
 * A schema rather than a read, and most of it is the error semantics: `errorKind` beside
 * `error`, `partial` beside `projects`, `metricsError` beside `metrics`. Those pairings are
 * the whole contract — a null and a null mean something different from a null and a
 * message — and they were stated in seventy-five lines of docblock at the top of a file
 * whose subject is fetching.
 */

import type { RailwayErrorKind } from "@/lib/railway/errors";
import type {
  Container,
  ContainerMetrics,
  ContainerVolume,
  RailwayEnvironment,
  RailwayProject,
  RailwayWorkspace,
  WorkspaceSpend,
} from "@/lib/railway/types";

export type DashboardShell = {
  user: { name?: string; email?: string };
  projects: RailwayProject[];
  /**
   * Where a new project could be created, for the create dialog's workspace select.
   *
   * Empty for two situations that need different answers on screen and are told apart by
   * `missingScopes` rather than by this: an account with no workspaces, and a token whose
   * `workspace:viewer` was withheld — which reads as no workspaces from here.
   */
  workspaces: RailwayWorkspace[];
  project: RailwayProject | null;
  environment: RailwayEnvironment | null;
  /** Set when the project list failed; the header and shell still render. */
  error: string | null;
  /**
   * Set when some project sources answered and others did not.
   *
   * A list that is real but incomplete must say so. Silently showing the projects that
   * happened to load, with no sign that a whole workspace was refused, is how someone
   * concludes their projects are gone.
   */
  partialError: string | null;
  /**
   * What kind of failure, so the page can offer the action that matches it.
   *
   * A rate limit wants a retry; a rejected credential wants re-consent. Offering both
   * every time trains the user to click the one that never helps.
   */
  errorKind: RailwayErrorKind | null;
  /**
   * Scopes the app asked for at consent and did not get.
   *
   * The empty dashboard has two very different causes — nothing to show, or no
   * permission to see it — and they need opposite advice. Only a missing scope makes
   * re-authorizing the useful action; without this the UI can only guess, and guessing
   * is what sent users round the consent screen with nothing changing.
   */
  missingScopes: string[];
  /**
   * True when the URL named a project that is no longer in the list.
   *
   * Falling silently back to the first project shows someone else's containers under a
   * link they believe points somewhere specific.
   */
  droppedSelection: boolean;
};

export type ContainerListData = {
  containers: Container[];
  /** Set when this environment's containers failed; the section still renders. */
  error: string | null;
  /**
   * Current usage per service id, for whichever containers Railway had a sample for.
   *
   * Keyed rather than merged onto the containers, so a value that changes every couple of
   * minutes never reaches the watcher's fingerprint or the list's filter key. Empty when
   * metrics were refused or failed — which reads identically to "no samples yet", and is
   * meant to: the row renders an em dash either way.
   */
  metrics: Record<string, ContainerMetrics>;
  /**
   * Where each container keeps its data, for whichever containers have a volume.
   *
   * Keyed for the same reason `metrics` is — `currentSizeMB` moves as a database is written
   * to, and neither the watcher's fingerprint nor the list's filter key may observe a value
   * like that. Empty when the read was refused, which reads identically to "no container
   * here has a volume": the row shows nothing extra, and the destroy dialog offers no
   * choice, which keeps the data.
   */
  volumes: Record<string, ContainerVolume>;
  /** Workspace-wide, and null for a personal project or an unscoped token. */
  spend: WorkspaceSpend | null;
};
