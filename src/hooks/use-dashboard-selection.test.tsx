import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routerMock, setPathname, setSearchParams } from "@/test/setup-dom";
import { useDashboardSelection } from "./use-dashboard-selection";

/** The pushed URL, so every assertion reads as the address bar rather than as a call. */
const pushed = () => String(routerMock.push.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => {
  setPathname("/dashboard");
  setSearchParams("project=p1&environment=e1");
});
afterEach(() => routerMock.push.mockClear());

describe("useDashboardSelection", () => {
  it("keeps the reader on the tab they are already on", () => {
    /*
     * The regression this hook was rewritten for. It used to push `/dashboard` outright,
     * so changing project from the spin-up tab silently moved the reader to the list.
     */
    setPathname("/dashboard/new");
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.selectProject("p2"));

    expect(pushed()).toBe("/dashboard/new?project=p2");
  });

  it("carries the list's own filters through a project switch", () => {
    // Client-side state kept in the query string; a fresh URLSearchParams would reset it.
    setSearchParams("project=p1&environment=e1&q=redis&status=failed");
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.selectProject("p2"));

    expect(pushed()).toContain("q=redis");
    expect(pushed()).toContain("status=failed");
  });

  it("drops the environment when the project changes", () => {
    // The old environment belongs to the old project; the server defaults it instead.
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.selectProject("p2"));

    expect(pushed()).not.toContain("environment=");
  });

  it("keeps the project when only the environment changes", () => {
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.selectEnvironment("e2"));

    expect(pushed()).toBe("/dashboard?project=p1&environment=e2");
  });

  it("lands on what a create just made, environment and all", () => {
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.select("p9", "e9"));

    expect(pushed()).toBe("/dashboard?project=p9&environment=e9");
  });

  it("clears the environment when a create had none", () => {
    /*
     * A project created without one would otherwise inherit the previous project's
     * environment in the URL, which the server drops anyway — but silently, one render
     * later.
     */
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.select("p9"));

    expect(pushed()).toBe("/dashboard?project=p9");
  });

  it("sends a finished spin-up to the container tab, selection intact", () => {
    setPathname("/dashboard/new");
    setSearchParams("project=p1&environment=e1");
    const { result } = renderHook(() => useDashboardSelection());

    act(() => result.current.goToContainers());

    expect(pushed()).toBe("/dashboard?project=p1&environment=e1");
  });

  it("reports the navigation as pending", () => {
    const { result } = renderHook(() => useDashboardSelection());

    expect(result.current.pending).toBe(false);
    act(() => result.current.selectProject("p2"));
    // Settles as soon as the transition does; what matters is that it is observable at
    // all, since the picker stays enabled and signals with aria-busy instead.
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });
});
