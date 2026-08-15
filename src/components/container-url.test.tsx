import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { routerMock } from "@/test/setup-dom";

/*
 * Stubbed rather than imported, for the reason `container-actions.test.tsx` gives: this
 * component's job is choosing between an address and the offer of one, and the real module
 * would drag the whole server-side action graph into a jsdom render.
 */
const generateDomain =
  vi.fn<(prev: ActionResult | null, data: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  generateDomain: (prev: ActionResult | null, data: FormData) =>
    generateDomain(prev, data),
}));

const { ContainerUrl } = await import("./container-url");
const { ToastProvider } = await import("./ui/toast");

beforeEach(() => {
  generateDomain.mockReset();
  // Shared across the file by setup-dom, so a refresh from the previous case would satisfy
  // the assertion that a refused action refreshes nothing.
  routerMock.refresh.mockClear();
});

const renderUrl = (over: { url?: string | null; canGenerate?: boolean } = {}) =>
  render(
    <ToastProvider>
      <ContainerUrl
        url={over.url ?? null}
        serviceId="svc_1"
        displayName="web"
        projectId="p1"
        environmentId="e1"
        canGenerate={over.canGenerate ?? true}
      />
    </ToastProvider>,
  );

describe("ContainerUrl", () => {
  it("links to the address, showing the host without the scheme", () => {
    // The href keeps the whole URL; only the label is shortened, which is the direction
    // that cannot mislead.
    renderUrl({ url: "https://spun-web-production.up.railway.app" });

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://spun-web-production.up.railway.app");
    expect(link.textContent).toContain("spun-web-production.up.railway.app");
    expect(link.textContent).not.toContain("https://");
  });

  it("names the container in the accessible name", () => {
    // A bare hostname read out of the row's context says nothing about which container it
    // belongs to.
    renderUrl({ url: "https://spun-web-production.up.railway.app" });
    expect(
      screen.getByRole("link", {
        name: /Open web at spun-web-production\.up\.railway\.app/,
      }),
    ).toBeInTheDocument();
  });

  it("leaves this app in a new tab, without handing it an opener", () => {
    renderUrl({ url: "https://spun-web-production.up.railway.app" });
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("offers to add one when a managed container has no address", () => {
    renderUrl();
    expect(
      screen.getByRole("button", { name: "Add a public URL" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  /*
   * This app does not act on services it did not create, so an offer here would be one it
   * cannot honour — the row's Open in Railway is the honest route for those.
   */
  it("offers nothing when the row says this container may not mint one", () => {
    renderUrl({ canGenerate: false });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("still shows the address of a container it may not act on", () => {
    renderUrl({ canGenerate: false, url: "https://someone-elses.up.railway.app" });
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://someone-elses.up.railway.app",
    );
  });

  it("posts the three ids and nothing else", async () => {
    /*
     * No port among them, which is the whole security property: the action derives it from
     * the image Railway reported, so the browser cannot aim a domain at a port of its
     * choosing on a service it happens to own.
     */
    generateDomain.mockResolvedValue({ ok: true, message: "web is now at https://x" });
    renderUrl();

    await userEvent.click(screen.getByRole("button", { name: "Add a public URL" }));

    await waitFor(() => expect(generateDomain).toHaveBeenCalled());
    const data = generateDomain.mock.calls[0]![1];
    expect([...data.keys()].sort()).toEqual([
      "environmentId",
      "projectId",
      "serviceId",
    ]);
    expect(data.get("serviceId")).toBe("svc_1");
  });

  it("announces the new address and pulls the row that will show it", async () => {
    generateDomain.mockResolvedValue({
      ok: true,
      message: "web is now at https://spun-web-production.up.railway.app",
    });
    renderUrl();

    await userEvent.click(screen.getByRole("button", { name: "Add a public URL" }));

    expect(
      await screen.findByText(
        "web is now at https://spun-web-production.up.railway.app",
      ),
    ).toBeInTheDocument();
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it("toasts a refusal rather than leaving the button looking spent", async () => {
    generateDomain.mockResolvedValue({
      ok: false,
      error: "This service was not created here, so this app cannot act on it.",
    });
    renderUrl();

    await userEvent.click(screen.getByRole("button", { name: "Add a public URL" }));

    expect(await screen.findByText("Could not add a public URL")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This service was not created here, so this app cannot act on it.",
      ),
    ).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });
});
