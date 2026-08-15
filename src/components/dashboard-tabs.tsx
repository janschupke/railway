"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { TabNav } from "./ui/tab-nav";

/**
 * The dashboard's three views, and the selection that travels between them.
 *
 * A client component in the layout rather than markup in each page, and the query string
 * is the whole reason. The selection lives in the URL (ADR-7), and so do the container
 * list's own filters — but the pages must not see the second group: the comment on
 * `searchParams` in dashboard/page.tsx states that widening its type would claim the
 * server reads filters, which it must not. Reading the query here, on the client, carries
 * everything through a tab switch while leaving that claim true.
 *
 * It renders in dashboard/layout.tsx, above the route's loading and error boundaries, so
 * the strip is literally the same element across a tab change — the argument
 * dashboard/loading.tsx makes for the header, one level down. That is also why there is no
 * tab-strip skeleton anywhere, and why a failed tab can still be navigated out of.
 */
const TABS = [
  { path: "/dashboard", key: "tabContainers" },
  { path: "/dashboard/new", key: "tabNew" },
  { path: "/dashboard/billing", key: "tabBilling" },
] as const;

export function DashboardTabs() {
  const t = useTranslations("dashboard");
  const pathname = usePathname();
  const query = useSearchParams().toString();

  return (
    <TabNav
      label={t("tabsLabel")}
      items={TABS.map(({ path, key }) => ({
        href: query ? `${path}?${query}` : path,
        label: t(key),
        /*
         * Exact match, not `startsWith`. The container tab's path is a prefix of the other
         * two, so a prefix test would mark it current on every tab — the obvious bug, and
         * one that looks right in review because two of the three cases still pass.
         */
        current: pathname === path,
      }))}
    />
  );
}
