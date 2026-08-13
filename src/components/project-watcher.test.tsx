import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useProjectWatcher = vi.fn();
vi.mock("@/hooks/use-project-watcher", () => ({
  useProjectWatcher: (projectId: string, environmentId: string) =>
    useProjectWatcher(projectId, environmentId),
}));

const { ProjectWatcher } = await import("./project-watcher");

/**
 * A component that renders nothing, which is exactly why it needed a test.
 *
 * It exists only to run a hook from inside a Server Component's tree, so "does it work"
 * is entirely "does it pass its props through and produce no markup". Neither is
 * observable from any other test, and it sat at 0% behind a global coverage threshold.
 */
describe("ProjectWatcher", () => {
  it("hands its ids to the watcher hook", () => {
    render(<ProjectWatcher projectId="p1" environmentId="e1" />);
    expect(useProjectWatcher).toHaveBeenCalledWith("p1", "e1");
  });

  it("renders nothing", () => {
    // It is mounted beside the picker inside a layout that is not expecting a node; any
    // markup here would land in the middle of the dashboard's grid.
    const { container } = render(<ProjectWatcher projectId="p1" environmentId="e1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
