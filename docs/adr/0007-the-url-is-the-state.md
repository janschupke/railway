# ADR-7 — The URL is the state; there is no client store

No Redux, Zustand, Jotai, React Query or SWR. The measured shape of client state is one
app-authored context, seventeen `useState`, zero `useReducer`, zero `useOptimistic`.

**The selected project and environment live in the URL.** They are search params, read
by `page.tsx` and resolved server-side in `data.ts` — a stale or absent param falls back
to the first project rather than blanking the page. So the dashboard is linkable,
survives a reload, and the server does the fetching. `ProjectPicker` holds no selection
of its own; it writes to the URL and re-reads the result.

**The list's filters live in the URL too, but are applied on the client.** `q`, `status`,
`owner` and `sort` are search params, so a filtered list is shareable and survives a reload
like any other selection — but `useContainerFilters` writes them with
`window.history.replaceState` rather than `router.replace`, and `ContainerList` narrows
the array in memory. The reason is `PROJECT_QUERY`: it takes a project id and nothing
else, so the server has no way to filter and would recompute the same answer after two
Railway round trips per keystroke. Next patches both history methods to feed the router,
and its restore path seeds from the tree's own `renderedSearch`, so `useSearchParams`
updates with no request. Two traps are documented in place: the state argument must be
`null` (`window.history.state` carries `__NA`, which makes the patched `replaceState`
skip the router update and leave `useSearchParams` stale), and the page count resets on
the filter signature rather than on the `containers` array, which `router.refresh()`
replaces every few seconds. `sort` is in that signature although it narrows nothing:
re-ordering changes which containers the first page holds. Scroll depth is deliberately not
a param — a selection is shareable, a scroll position is not.

**Row selection is the one piece of list state that is deliberately _not_ in the URL.** The
containers ticked for a bulk destroy are held in `ContainerList`'s own `useState`, keyed on
the same filter signature so changing what is on screen clears what was picked. The test
above is what makes the difference: a filtered list is worth sharing, and a link that
arrives with six services pre-selected for deletion is a link worth being suspicious of. It
is also the one piece of state here that must not survive a reload.

**`router.refresh()` is the cache invalidation.** The dashboard is `force-dynamic` and
every Railway request is `cache: "no-store"`, because it is a live view of
infrastructure. There is no client-side fetch of the container list, so there is no
client cache to reconcile — which is the single biggest reason a data-fetching library
would add machinery without removing any.

**The one context is `ToastContext`**, and it is mounted in the _dashboard_ layout
rather than the root so the landing page and the 404 do not ship Radix Toast (~12 kB
gzip) for UI that has no actions in it. Its value is an imperative `{ toast }` memoised
to a stable identity; the toast list stays in provider state and never enters the
context, so pushing a toast re-renders the viewport rather than the dashboard.

Refactors considered and rejected:

| Tempting                                           | Why not                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `ProjectContext` for `projectId`/`environmentId` | Duplicates the URL as a second source of truth and forces components client-side. The drill is two non-consuming hops (`ContainerRow` → `DestroyContainerDialog`) of values that are constant for the page.                                                                                                                                     |
| React Query / SWR for containers                   | There is no client fetch to cache, and the live path is push (SSE), not poll.                                                                                                                                                                                                                                                                   |
| Theme in context or state                          | It is `useSyncExternalStore` over `localStorage`, which is correct on the first client render rather than one render late.                                                                                                                                                                                                                      |
| Lifting `expanded` / `pinned` / `open`             | All three are single-consumer disclosure state.                                                                                                                                                                                                                                                                                                 |
| Pinning or favouriting rows                        | Considered for T-503 and dropped. A pin is a per-reader preference about ordering, so it is either not shareable — the same argument this ADR makes against scroll depth — or a fourth param that contradicts `sort` whenever both are set. The sort control plus the managed-first default already answers "put what I care about at the top". |

**The live hazard worth naming:** `useTranslations` returns a fresh function identity on
every render. Putting `t` in a `useEffect` dependency array once caused duplicate toasts
and a `router.refresh()` loop; the fix — resolve the string during render and depend on
the string — is documented in place in `spin-up-form.tsx`. No lint rule prevents a
repeat, and `container-row.tsx`'s settle effect is one auto-added dependency away from
the same loop on a `force-dynamic` page.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
