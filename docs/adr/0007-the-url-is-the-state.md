# ADR-7 — The URL is the state; there is no client store

No Redux, Zustand, Jotai, React Query or SWR. The measured shape of client state is one
app-authored context, fifty-five `useState`, zero `useReducer`, zero `useOptimistic` —
counted across `src/**` excluding tests, and re-measurable with a grep rather than
remembered. It read seventeen when this was written; the growth is six features' worth of
local state and no shared state at all, which is the claim this decision actually makes.

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
| A form store for the advanced resource controls    | Seven write-only values that no other component reads and that must be blank again after a successful submit. One `useState` plus `key={submissionKey}` is the whole feature; a store would need an explicit clear action to replicate a remount. See the update below.                                                                         |
| Pinning or favouriting rows                        | Considered for T-503 and dropped. A pin is a per-reader preference about ordering, so it is either not shareable — the same argument this ADR makes against scroll depth — or a fourth param that contradicts `sort` whenever both are set. The sort control plus the managed-first default already answers "put what I care about at the top". |

**The live hazard worth naming:** `useTranslations` returns a fresh function identity on
every render. Putting `t` in a `useEffect` dependency array once caused duplicate toasts
and a `router.refresh()` loop; the fix — resolve the string during render and depend on
the string — is documented in place in `spin-up-form.tsx`. No lint rule prevents a
repeat, and `container-row.tsx`'s settle effect is one auto-added dependency away from
the same loop on a `force-dynamic` page.

## Update, 2026-08-14 — seven optional fields, and still no store

T-490 put seven resource controls behind an Advanced disclosure on the spin-up form: region,
replicas, vCPU, memory, restart policy, restart retries and start command. That ticket asked
outright whether the position above survives it. **It does**, and the four reasons are worth
writing down, because none of them is "we did not feel like adding Zustand".

**The state is write-only and it is local.** All seven values live in one `useState` inside
`AdvancedSettings`. Nothing else on the page reads them, no sibling needs them, and they
never outlive a submission — they are read once, out of `FormData`, by the action. A store
earns its place when state is shared or persisted, and this is neither. It is the same
single-consumer shape the table above already declines to lift.

**Controlled, and that was measured rather than assumed.** The first version left them
uncontrolled so the remount below would clear them for free. React resets an uncontrolled
form once a function action returns, whatever the action answered — so a **failed**
submission wiped the panel, which is the one moment somebody needs what they typed: they are
being told to change one number, with the other six gone. A component test caught it. One
state object fixes it, and the cost is a `useState` this decision has no objection to.

**Clearing them on success is a remount, not a reducer.** The form already re-mints
`submissionKey` on success and only on success, so the panel is rendered with
`key={submissionKey}` and empties itself with no clearing code anywhere. The `<details>`
element stays mounted around it, so a panel somebody had open stays open. The trap is
recorded in place: keying the `<details>` instead looks identical in review and snaps the
panel shut on every success. It also makes the "re-mint only on success" rule load-bearing
in a second place — re-minting on failure would start discarding settings mid-correction.

**The disclosure state is the DOM's.** `<details open>` is the platform's own
single-consumer disclosure state. The one place the app writes it — forcing the panel open
when a validation error names a field inside it, because an inline error nobody can see is
silence — is a ref write in the same register as clearing the name input. Radix Collapsible
was rejected on the argument `ui/checkbox.tsx` makes about Radix Checkbox, plus two this
ticket adds: a native disclosure keeps its closed content in the DOM, so a field somebody
tidied away still submits, and it has no height animation to synchronise and therefore none
of the mounted/expanded race documented in `container-row.tsx`.

**The genuinely new thing is a second unawaited promise.** The region list is read
server-side in `data.ts` and handed down as `Promise<RegionOption[]>`, resolved in an effect
— the contract `managedNames` already carries, including "cannot reject, and must not be
made to". This is where a data-fetching library would normally appear, and the reason it
still does not is the reason above: there is no client fetch to cache, because the value
arrives from a server render as a prop. What changed is that there are now two of them, so
the effect is `src/hooks/use-resolved.ts` rather than written twice — and that hook is where
the hazard named at the end of this document can next recur.

One thing the region read does **not** share with `managedNames`: it is not free.
`managedNames` costs no round trip because it rides `loadContainers`' per-render memo; this
has no such carrier and `/dashboard` is `force-dynamic`, so it is memoised in process with a
TTL (`src/lib/railway/regions.ts`, `REGIONS` in `constants.ts`), keyed by user and project.
That is a per-process cache with an expiry, like `lib/idempotency.ts` and the registry's
answer cache — not a database (ADR-4), and not a client store.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
