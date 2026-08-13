"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  OWNER_FILTERS,
  type ContainerFilters as Filters,
  type OwnerFilter,
} from "@/lib/container-filters";
import { LIST } from "@/lib/constants";
import { CONTAINER_STATES, type ContainerState } from "@/lib/railway/types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { MultiSelect } from "./ui/multi-select";
import { chip } from "./ui/chip";
import { Text } from "./ui/text";

/** Catalog key per origin, so this file owns the order and the catalog owns the wording. */
const OWNER_LABEL_KEY = {
  created: "ownerCreated",
  external: "ownerExternal",
} as const satisfies Record<OwnerFilter, string>;

/**
 * The container list's control row.
 *
 * Presentation only — every value comes from the URL through useContainerFilters, and
 * every change goes straight back there. Nothing is mirrored locally except the search
 * box's own unsettled text, which the hook holds.
 *
 * No breakpoints, per the layout policy this app follows throughout (see spin-up-form):
 * the search field grows and the controls beside it wrap as the viewport narrows, rather
 * than switching layouts at a width someone picked.
 *
 * ## Why the row's own height is fixed
 *
 * The controls are a constant set. Nine status chips used to sit in this row and wrap to
 * two or three lines depending on the viewport and on nothing the user did, and Clear
 * appeared and disappeared with the selection — so acting on a filter moved the list
 * under the pointer that had just acted on it. Now the row holds a search box, one
 * dropdown, two checkboxes and one button at all times, and the only thing that changes
 * height is the chip strip, which is the selection itself becoming visible.
 */
export function ContainerFilterBar({
  filters,
  draft,
  onDraftChange,
  onFlushDraft,
  onStatusesChange,
  onOwnersChange,
  onClear,
  canClear,
}: {
  filters: Filters;
  draft: string;
  onDraftChange: (value: string) => void;
  onFlushDraft: () => void;
  onStatusesChange: (statuses: ContainerState[]) => void;
  onOwnersChange: (owners: OwnerFilter[]) => void;
  onClear: () => void;
  canClear: boolean;
}) {
  const t = useTranslations("filters");
  const tStates = useTranslations("states");

  const toggleOwner = (owner: OwnerFilter, checked: boolean) => {
    const next = checked
      ? OWNER_FILTERS.filter((o) => o === owner || filters.owners.includes(o))
      : filters.owners.filter((o) => o !== owner);
    onOwnersChange([...next]);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/*
          basis-80, not basis-64, and it is the whole phone layout.

          Wrapping is decided on the basis, not on what an item can shrink to. At 64 the
          field and the status trigger came to just under a phone's content width, so they
          shared the first line and the search box lost a third of itself to a control
          that is the same size either way — the toggle strip it replaced was wide enough
          to wrap and had been hiding this. At 80 they cannot share, the field takes the
          line, and on a wide viewport it simply grows as it did before. One number, and
          no breakpoint.
        */}
        <div className="relative min-w-0 grow basis-80">
          <Search
            aria-hidden
            className="text-text-subtle pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={draft}
            maxLength={LIST.QUERY_MAX}
            aria-label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              // Enter skips the remaining settle; Escape clears without waiting for it.
              if (event.key === "Enter") {
                event.preventDefault();
                onFlushDraft();
              }
              if (event.key === "Escape") onDraftChange("");
            }}
            /* Room for the icon on the left. The native search clear sits on the right,
               where the browser draws it, so nothing needs to be reserved there. */
            className="pl-9"
          />
        </div>

        {/*
          Nine states behind one control. As a toggle strip they were the widest thing in
          the row and reflowed it at every breakpoint, and eight of the nine are noise to
          someone who came to find the failed one.
        */}
        <MultiSelect
          label={t("statusLabel")}
          countLabel={t("statusSelected", { count: filters.statuses.length })}
          listLabel={t("statusListLabel")}
          options={CONTAINER_STATES.map((state) => ({
            value: state,
            label: tStates(state),
          }))}
          value={filters.statuses}
          onValueChange={onStatusesChange}
        />

        {/*
          A group rather than a fieldset: a legend would add a second visible label to a row
          that already reads as one control strip, and the accessible name is what the two
          boxes actually need to be understood together.
        */}
        <div role="group" aria-label={t("ownerLabel")} className="flex shrink-0 gap-3">
          {OWNER_FILTERS.map((owner) => (
            <Checkbox
              key={owner}
              label={t(OWNER_LABEL_KEY[owner])}
              checked={filters.owners.includes(owner)}
              onChange={(event) => toggleOwner(owner, event.target.checked)}
            />
          ))}
        </div>

        {/*
          Always rendered, disabled when there is nothing to clear.

          It used to be mounted only while a filter was active, which is the more
          considerate-sounding rule and the worse one: the control that appears is also a
          control that reflows the row it appears in, and it did so at the exact moment
          the user was aiming at something else. A disabled button says the same thing —
          nothing to clear — without moving anything, and it is where the user last saw
          it when they do have something to clear.
        */}
        <Button
          variant="secondary"
          onClick={onClear}
          disabled={!canClear}
          className="ml-auto shrink-0"
        >
          {t("clear")}
        </Button>
      </div>

      {/*
        The selection, as the badges it filters.

        A dropdown hides what is selected behind a count, which is fine for a control and
        not fine for state that changes what the page shows. These carry the same
        `data-state-color` as StatusBadge, so a chip and the rows it admits are the same
        colour, and each one removes only itself — the whole reason a count in a trigger
        is not enough.
      */}
      {filters.statuses.length > 0 && (
        <div
          role="group"
          aria-label={t("selectedLabel")}
          className="flex flex-wrap gap-1.5"
        >
          {filters.statuses.map((state) => (
            <Text
              key={state}
              variant="badge"
              tone="inherit"
              data-state-color={state}
              className={chip({ gap: "dot", className: "pr-1" })}
            >
              <span aria-hidden data-state-dot className="size-1.5 rounded-full" />
              {tStates(state)}
              <button
                type="button"
                aria-label={t("removeStatus", { status: tStates(state) })}
                onClick={() =>
                  onStatusesChange(filters.statuses.filter((s) => s !== state))
                }
                // No colour of its own: the chip's data-state-color owns both halves of
                // the pair, and a hover that repainted the X would break that.
                className="focus-ring cursor-pointer rounded-full opacity-60 transition-opacity hover:opacity-100"
              >
                <X aria-hidden className="size-3" />
              </button>
            </Text>
          ))}
        </div>
      )}
    </div>
  );
}
