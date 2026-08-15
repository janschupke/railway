import type { ComponentProps } from "react";
import { railwayServiceUrl } from "@/lib/railway/links";

/**
 * A link out to one service on Railway, wherever this app runs out of things to show.
 *
 * The row offers it three times — on the name, as the only control a container this app
 * did not create has, and inside a failed row's panel — and the detail dialog offers it
 * again. Every one of those spelled out the same three ids and the same
 * `target`/`rel` pair, so the escape hatch's address was a property of four call sites.
 *
 * `rel="noreferrer"` is the half worth naming: these open in a new tab, and it is the
 * attribute that a copy written from memory leaves off.
 *
 * Everything else is forwarded, because the surrounding element differs every time — the
 * name is `Text asChild`, the two buttons are `Button asChild` in different variants, and
 * each passes its own className down through Radix's Slot to the anchor underneath.
 */
export function RailwayServiceLink({
  projectId,
  serviceId,
  environmentId,
  children,
  ...rest
}: {
  projectId: string;
  serviceId: string;
  environmentId: string;
} & Omit<ComponentProps<"a">, "href" | "target" | "rel">) {
  return (
    // `children` is named rather than left to spread: jsx-a11y cannot see content arriving
    // through `{...rest}` and reads the anchor as empty, which is a real check to keep.
    <a
      href={railwayServiceUrl({ projectId, serviceId, environmentId })}
      target="_blank"
      rel="noreferrer"
      {...rest}
    >
      {children}
    </a>
  );
}
