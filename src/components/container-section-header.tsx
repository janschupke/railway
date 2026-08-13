import { Heading } from "./ui/text";

/**
 * The container section's heading and its one-line summary.
 *
 * Extracted because three places draw this row — the server section, the client list, and
 * the skeleton that stands in for both — and a baseline that drifted between them would
 * show as the heading stepping sideways when the list arrives.
 *
 * `id` is here for the same reason: scroll-to-top hands focus to the heading, which needs
 * a target that exists whether the list is loaded or still a placeholder.
 */
export const CONTAINER_HEADING_ID = "containers-heading";

export function ContainerSectionHeader({
  heading,
  summary,
}: {
  heading: string;
  summary?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      {/*
        tabIndex -1 so scroll-to-top can move focus here. Without it the button that
        scrolled the page keeps focus while sitting off screen, and the next Tab
        continues from somewhere the reader cannot see.
      */}
      <Heading level={2} id={CONTAINER_HEADING_ID} tabIndex={-1}>
        {heading}
      </Heading>
      {summary}
    </div>
  );
}
