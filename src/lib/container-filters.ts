import { CONTAINER_STATES, type Container, type ContainerState } from "./railway/types";
import { LIST } from "./constants";

/**
 * The container list's filter model: what the URL carries, and what it means.
 *
 * Pure and React-free so it can be unit-tested in the node project and so both the
 * component that writes the URL and the component that renders the list read the same
 * definition of "matching". Railway's own API filters nothing — PROJECT_QUERY takes only
 * a project id — so this is where narrowing actually happens.
 *
 * Query-parameter names, like PARAM in project-picker.tsx, are protocol rather than copy
 * and stay out of the catalog.
 */
const FILTER_PARAM = {
  query: "q",
  status: "status",
  owner: "owner",
} as const;

/**
 * Which containers this app created.
 *
 * There is exactly one ownership bit — `Container.managed`, derived from the name prefix
 * (see managed.ts) — so "created here" and "managed here" are the same thing said twice.
 * `created` is `managed === true`, `external` is `managed === false`, and the prefix note
 * under the list is what explains the distinction to the user.
 */
export const OWNER_FILTERS = ["created", "external"] as const;

export type OwnerFilter = (typeof OWNER_FILTERS)[number];

export type ContainerFilters = {
  query: string;
  statuses: ContainerState[];
  owners: OwnerFilter[];
};

/** Every group empty: the unfiltered list. */
export const NO_FILTERS: ContainerFilters = {
  query: "",
  statuses: [],
  owners: [],
};

/**
 * Reads one group, accepting both encodings.
 *
 * `status=running,failed` and `status=running&status=failed` are the same selection, so
 * both parse — the first is what this app writes, the second is what a hand-edited or
 * framework-rewritten URL can easily become.
 */
function readGroup(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Keeps only members of `allowed`, deduped and in `allowed`'s own order.
 *
 * Two properties matter. Canonical ordering means one selection has exactly one URL, so
 * a filter key can be a string comparison and a shared link is stable. Dropping
 * unrecognised tokens silently is the same posture as toContainerState mapping an unknown
 * Railway enum to "unknown" rather than throwing: a link naming a state this build no
 * longer has must narrow oddly, never blank the list or crash the page.
 */
function canonical<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const chosen = new Set(values);
  return allowed.filter((member) => chosen.has(member));
}

export function parseFilters(params: URLSearchParams): ContainerFilters {
  return {
    // Collapsed rather than merely trimmed: "web  server" and "web server" are the same
    // search intent, and the needle is compared against single-spaced names.
    query: (params.get(FILTER_PARAM.query) ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, LIST.QUERY_MAX),
    statuses: canonical(readGroup(params, FILTER_PARAM.status), CONTAINER_STATES),
    owners: canonical(readGroup(params, FILTER_PARAM.owner), OWNER_FILTERS),
  };
}

/**
 * The query string for `next`, preserving everything else already in `base`.
 *
 * `project` and `environment` are the page's actual inputs and must survive a filter
 * write untouched — which is why this takes the live params rather than building a
 * string from scratch.
 *
 * URLSearchParams encodes a comma as %2C. A comma is a legal sub-delim in a query
 * (RFC 3986) and both forms parse back identically, so the literal is restored: this
 * string ends up in the address bar, and `status=running,failed` is readable where
 * `status=running%2Cfailed` is not.
 */
export function filterQueryString(
  base: URLSearchParams,
  next: ContainerFilters,
): string {
  const params = new URLSearchParams(base);

  for (const name of Object.values(FILTER_PARAM)) params.delete(name);

  if (next.query) params.set(FILTER_PARAM.query, next.query);
  if (next.statuses.length) params.set(FILTER_PARAM.status, next.statuses.join(","));
  if (next.owners.length) params.set(FILTER_PARAM.owner, next.owners.join(","));

  return params.toString().replace(/%2C/g, ",");
}

/**
 * Substring match across everything a row displays.
 *
 * Four fields, because a row shows the name over the image-or-repo line and a user
 * searching for "postgres" means either. `rawName` joins `displayName` because the
 * latter is prefix-stripped while the prefix note actively teaches the user that the
 * prefix exists, so typing it must not return nothing.
 */
function matchesQuery(container: Container, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    container.displayName,
    container.rawName,
    container.image,
    container.repo,
  ];
  return haystack.some((value) => value?.toLocaleLowerCase().includes(needle));
}

/**
 * Applies the filters.
 *
 * The three groups AND together; within a group the members OR. An empty group means "no
 * constraint" rather than "nothing matches" — the same rule three times, and the reason a
 * URL carrying no filter params returns the whole list.
 *
 * Order is preserved, so sortContainers' guarantee still holds: managed containers lead,
 * and the first page stays the page the user can act on.
 */
export function filterContainers(
  containers: Container[],
  filters: ContainerFilters,
): Container[] {
  const needle = filters.query.toLocaleLowerCase();
  const statuses = new Set(filters.statuses);
  const owners = new Set(filters.owners);

  return containers.filter(
    (container) =>
      matchesQuery(container, needle) &&
      (statuses.size === 0 || statuses.has(container.state)) &&
      (owners.size === 0 || owners.has(container.managed ? "created" : "external")),
  );
}

export function hasActiveFilters(filters: ContainerFilters): boolean {
  return (
    filters.query !== "" || filters.statuses.length > 0 || filters.owners.length > 0
  );
}

/**
 * A string that changes exactly when the *selection* changes.
 *
 * Pagination resets on this rather than on the container array, whose identity changes on
 * every router.refresh() — see use-incremental-list. Canonical parse ordering is what
 * makes a plain join sufficient here.
 */
export function filterKey(filters: ContainerFilters): string {
  return [filters.query, filters.statuses.join(","), filters.owners.join(",")].join(
    "|",
  );
}
