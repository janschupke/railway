"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToggleGroup } from "radix-ui";
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
 * the search field grows and the two groups wrap beneath it as the viewport narrows,
 * rather than switching layouts at a width someone picked.
 */
export function ContainerFilterBar({
  filters,
  draft,
  onDraftChange,
  onFlushDraft,
  onStatusesChange,
  onOwnersChange,
  onClear,
  showClear,
}: {
  filters: Filters;
  draft: string;
  onDraftChange: (value: string) => void;
  onFlushDraft: () => void;
  onStatusesChange: (statuses: ContainerState[]) => void;
  onOwnersChange: (owners: OwnerFilter[]) => void;
  onClear: () => void;
  showClear: boolean;
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="relative min-w-0 grow basis-64">
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
        `type="multiple"` is the additive multi-select this needs, and Radix gives it a
        roving tabindex and aria-pressed for free — a group of nine reached with one Tab
        and walked with the arrow keys, rather than nine tab stops.
      */}
      <ToggleGroup.Root
        type="multiple"
        value={filters.statuses}
        aria-label={t("statusLabel")}
        onValueChange={(next) => onStatusesChange(next as ContainerState[])}
        className="flex flex-wrap gap-1"
      >
        {CONTAINER_STATES.map((state) => (
          <ToggleGroup.Item key={state} value={state} asChild>
            <Text asChild variant="badge" className={chip({ selectable: true })}>
              <button type="button">{tStates(state)}</button>
            </Text>
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>

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

      {/* Only offered when there is something to clear; a permanently dead control in a
          filter bar reads as broken rather than as inactive. */}
      {showClear && (
        <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0">
          <X aria-hidden />
          {t("clear")}
        </Button>
      )}
    </div>
  );
}
