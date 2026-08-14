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
  sort: "sort",
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

/**
 * The orders the list can be read in, key and direction together.
 *
 * One value rather than a key plus a direction, because half the pairs are not worth
 * offering: nobody wants the lifecycle run backwards, and a direction toggle beside the
 * dropdown would be a second control in a row whose constant height is a decision
 * container-filter-bar.tsx argues for at length. One selection is therefore one token, one
 * param and one URL.
 *
 * `default` is the order Railway's answer already arrived in — managed first, then newest,
 * per sortContainers in railway/mappers.ts. It is a member rather than the absence of one so
 * the control has something to return to; it writes no param, so the plain list keeps a bare
 * URL.
 */
export const SORT_ORDERS = [
  "default",
  "name-asc",
  "name-desc",
  "state",
  "newest",
  "oldest",
] as const;

export type SortOrder = (typeof SORT_ORDERS)[number];

export type ContainerFilters = {
  query: string;
  statuses: ContainerState[];
  owners: OwnerFilter[];
  sort: SortOrder;
};

/** Every group empty and the server's own order: the unfiltered list. */
export const NO_FILTERS: ContainerFilters = {
  query: "",
  statuses: [],
  owners: [],
  sort: "default",
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

/**
 * Reads the sort, falling back to the server's own order.
 *
 * Not `canonical` above, which answers "which of these are selected" for a group that can
 * hold several. This one is single-valued, so an unrecognised token has a specific right
 * answer rather than an empty set: the same posture toContainerState takes towards an enum
 * member this build does not know — narrow oddly, never blank the list.
 */
function readSort(params: URLSearchParams): SortOrder {
  const value = (params.get(FILTER_PARAM.sort) ?? "").trim().toLowerCase();
  return (SORT_ORDERS as readonly string[]).includes(value)
    ? (value as SortOrder)
    : "default";
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
    sort: readSort(params),
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
  // The server's own order writes nothing, so an unsorted list keeps a bare URL and the
  // absence of the param and `sort=default` mean the same thing on the way back in.
  if (next.sort !== "default") params.set(FILTER_PARAM.sort, next.sort);

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

/**
 * Whether anything is being hidden.
 *
 * Sort is deliberately not part of this. It hides nothing, it has its own way back — the
 * `default` member of its own control — and counting it here would make a button labelled
 * "Clear filters" the thing that resets the reading order, which is copy that lies.
 */
export function hasActiveFilters(filters: ContainerFilters): boolean {
  return (
    filters.query !== "" || filters.statuses.length > 0 || filters.owners.length > 0
  );
}

/** Where each state sits in the lifecycle, from the one array that already orders them. */
const STATE_RANK = new Map(CONTAINER_STATES.map((state, index) => [state, index]));

/**
 * Newest or oldest first, by the *service's* creation.
 *
 * `createdAt` rather than `updatedAt`, and that is not a coin toss. `updatedAt` moves every
 * time a deployment ticks — it is the field watch-fingerprint.ts excludes for exactly that
 * reason — so a list sorted on it would reorder itself under the reader every few seconds,
 * on a page that refreshes itself. The row displays `updatedAt`; the order is built on the
 * value that holds still.
 *
 * A container Railway gave no creation date sorts last in both directions. It is the one
 * ordering that says the same thing either way: this app does not know when this was made.
 */
const byCreated =
  (direction: 1 | -1) =>
  (a: Container, b: Container): number => {
    if (!a.createdAt || !b.createdAt) {
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return 0;
    }
    return direction * a.createdAt.localeCompare(b.createdAt);
  };

/**
 * The comparator per order, minus the tie-break every one of them shares.
 *
 * `default` is absent rather than mapped to a no-op comparator: it means "do not sort",
 * which is a different thing from "sort by nothing" — see `orderContainers`.
 */
const COMPARATORS: Record<
  Exclude<SortOrder, "default">,
  (a: Container, b: Container, locale?: string) => number
> = {
  "name-asc": (a, b, locale) => a.displayName.localeCompare(b.displayName, locale),
  "name-desc": (a, b, locale) => b.displayName.localeCompare(a.displayName, locale),
  state: (a, b) => (STATE_RANK.get(a.state) ?? 0) - (STATE_RANK.get(b.state) ?? 0),
  newest: byCreated(-1),
  oldest: byCreated(1),
};

/**
 * The list in the reader's chosen order.
 *
 * Applied after `filterContainers` and before paging, on the client, for the same reason the
 * filtering is: PROJECT_QUERY accepts a project id and nothing else, so there is no sort
 * argument to send and the whole array is already here.
 *
 * `default` returns the input untouched rather than re-sorting it into the same shape. That
 * preserves both the array identity — the memo above this in ContainerList would otherwise
 * hand `useIncrementalList` a new array on every render — and `sortContainers`' guarantee
 * that the containers this app can act on lead.
 *
 * Every order is total: the comparators above decide most pairs, and the service id settles
 * the rest, so two containers created in the same second have one order rather than
 * whichever one Array.prototype.sort happened to prefer this run.
 */
export function orderContainers(
  containers: Container[],
  sort: SortOrder,
  locale?: string,
): Container[] {
  if (sort === "default") return containers;
  const compare = COMPARATORS[sort];
  return [...containers].sort(
    (a, b) => compare(a, b, locale) || a.serviceId.localeCompare(b.serviceId),
  );
}

/**
 * A string that changes exactly when the *selection* changes.
 *
 * Pagination resets on this rather than on the container array, whose identity changes on
 * every router.refresh() — see use-incremental-list. Canonical parse ordering is what
 * makes a plain join sufficient here.
 *
 * The sort is part of it, although it narrows nothing: re-ordering changes which containers
 * the first page holds, so a reader three pages into one order would otherwise land three
 * pages into another. Row selection resets on this string too — see ContainerList.
 */
export function filterKey(filters: ContainerFilters): string {
  return [
    filters.query,
    filters.statuses.join(","),
    filters.owners.join(","),
    filters.sort,
  ].join("|");
}
