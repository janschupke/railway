import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "./banner";
import { Button } from "./button";
import { Card } from "./card";
import { EmptyState, PendingStatus } from "./misc";
import { Skeleton } from "./skeleton";
import { ScrollArea } from "./scroll-area";
import { Select } from "./select";
import { ToggleGroup } from "./toggle-group";
import { Tooltip, TooltipProvider } from "./tooltip";
import { ToastProvider, useToast } from "./toast";

describe("Button", () => {
  it("defaults to type=button so a decorative button cannot submit a form", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("honours an explicit submit type", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("renders as the child element when asChild, keeping the styling", () => {
    render(
      <Button asChild variant="primary">
        <a href="/login">Sign in</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link).toHaveClass("bg-accent");
    // A link must not acquire a type attribute.
    expect(link).not.toHaveAttribute("type");
  });

  it("lets a caller override a conflicting utility", () => {
    render(<Button className="px-8">Wide</Button>);
    expect(screen.getByRole("button").className).toContain("px-8");
  });

  it("blocks interaction when disabled", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );

    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("marks itself busy and swaps the label while pending", () => {
    render(
      <Button pending pendingLabel="Spinning up…">
        Spin up container
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Spinning up…");
    expect(button).not.toHaveTextContent("Spin up container");
  });

  it("falls back to the children when no pending label is given", () => {
    render(<Button pending>Save</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Save");
  });

  it("declines activation of a pending link, which cannot be disabled", async () => {
    /*
     * The regression this locks: `disabled` on a Slot-rendered <a> does nothing at all,
     * so a pending sign-in link stayed clickable and could fire a second OAuth round
     * trip. aria-disabled plus a suppressed click is the only shape that holds.
     */
    render(
      <Button asChild pending>
        <a href="/api/auth/login">Sign in</a>
      </Button>,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).not.toHaveAttribute("disabled");

    /*
     * Slot runs the child's own handler before the slot's, so a pending Button cannot
     * suppress it — what it can do is cancel the default, which is what stops a second
     * navigation. That cancellation is the actual guarantee, so assert on it.
     */
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("still calls through when a link is not pending", async () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <Button asChild>
        <a href="/somewhere" onClick={onClick}>
          Go
        </a>
      </Button>,
    );

    await user.click(screen.getByRole("link"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("attaches no handler to a plain enabled link", () => {
    /*
     * Not a micro-optimisation: an event handler cannot cross the Server Component
     * boundary, so a Button that always carries one cannot be used for a static link
     * rendered on the server. Rendering the dashboard's "Open Railway" link used to
     * crash the page into its error boundary for exactly this reason.
     *
     * React attaches its listeners at the root, so the handler is not observable as a
     * DOM attribute — asserting the props the primitive builds is what catches it.
     */
    const props = Button({ asChild: true, children: <a href="/x">Go</a> })
      .props as Record<string, unknown>;

    expect(props.onClick).toBeUndefined();
  });

  it("keeps the guard on an inert link, where it is the whole point", () => {
    const props = Button({
      asChild: true,
      pending: true,
      children: <a href="/x">Go</a>,
    }).props as Record<string, unknown>;

    expect(props.onClick).toBeTypeOf("function");
  });
});

describe("Banner", () => {
  it("interrupts for errors and announces politely otherwise", () => {
    const { rerender } = render(<Banner tone="error">Broke</Banner>);
    expect(screen.getByRole("alert")).toHaveTextContent("Broke");

    rerender(<Banner tone="success">Fine</Banner>);
    expect(screen.getByRole("status")).toHaveTextContent("Fine");
  });
});

describe("Card", () => {
  it("passes props through to the element", () => {
    render(<Card data-testid="card">body</Card>);
    expect(screen.getByTestId("card")).toHaveTextContent("body");
  });
});

describe("PendingStatus", () => {
  it("keeps the live region mounted while idle so the announcement is not missed", () => {
    // Injecting the region and its text in the same commit is the classic way to have
    // an announcement dropped; the element has to be there first.
    const { container, rerender } = render(<PendingStatus />);
    const region = container.querySelector("[aria-live='polite']");
    expect(region).toBeEmptyDOMElement();

    rerender(<PendingStatus label="Spinning up…" />);
    expect(region).toHaveTextContent("Spinning up…");
    expect(region).toHaveAttribute("data-pending-status");
  });
});

describe("Skeleton, EmptyState", () => {
  it("hides skeletons from assistive technology", () => {
    // The surrounding region already carries aria-busy; announcing shimmer is noise.
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("carries its fill colour independently of the animation", () => {
    /*
     * prefers-reduced-motion freezes every animation globally, so a skeleton that
     * relied on the pulse would be an invisible rectangle for those users. The token
     * is what makes it readable; motion-safe: says the pulse is the enhancement.
     */
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveClass("bg-skeleton");
    expect(container.firstElementChild).toHaveClass("motion-safe:animate-pulse");
  });

  it("takes its radius from the control it stands in for", () => {
    const { container } = render(<Skeleton shape="pill" />);
    expect(container.firstElementChild).toHaveClass("rounded-full");
  });

  it("lets a caller override the shape's classes", () => {
    const { container } = render(<Skeleton shape="control" className="rounded-none" />);
    expect(container.firstElementChild).toHaveClass("rounded-none");
    expect(container.firstElementChild).not.toHaveClass("rounded-md");
  });

  it("renders an empty state with an optional action", () => {
    render(
      <EmptyState
        title="Nothing here"
        description="Spin one up above."
        action={<Button>Start</Button>}
      />,
    );

    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("omits the action slot when none is given", () => {
    render(<EmptyState title="Nothing here" description="Quiet." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ScrollArea", () => {
  it("forwards viewport props so callers can label the scrolling region", () => {
    render(
      <ScrollArea viewportProps={{ role: "log", "aria-label": "Output" }}>
        <p>content</p>
      </ScrollArea>,
    );

    expect(screen.getByRole("log")).toHaveAccessibleName("Output");
  });
});

describe("Select", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ];

  it("carries an accessible name even without a visible label", () => {
    render(
      <Select label="Project" value="a" options={options} onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toBeInTheDocument();
  });

  it("shows the selected option's label", () => {
    render(
      <Select label="Project" value="b" options={options} onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Beta");
  });

  it("shows the placeholder when nothing is selected", () => {
    render(
      <Select
        label="Project"
        value={undefined}
        options={options}
        onValueChange={vi.fn()}
        placeholder="Pick one…"
      />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("Pick one…");
  });

  it("opens with the keyboard and reports the chosen value", async () => {
    // The swap from a native <select> has to earn itself on keyboard support.
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select
        label="Project"
        value="a"
        options={options}
        onValueChange={onValueChange}
      />,
    );

    await user.tab();
    expect(screen.getByRole("combobox")).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("cannot be opened when disabled", async () => {
    const user = userEvent.setup();
    render(
      <Select
        label="Project"
        value="a"
        options={options}
        onValueChange={vi.fn()}
        disabled
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("option")).toBeNull();
  });
});

describe("ToggleGroup", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ];

  it("reports a new selection", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleGroup
        label="Presets"
        value="a"
        options={options}
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("ignores a re-click on the active item rather than blanking the choice", async () => {
    // Radix emits "" when deselecting; this group is not deselectable.
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleGroup
        label="Presets"
        value="a"
        options={options}
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Alpha" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe("Tooltip", () => {
  it("shows supplementary detail on keyboard focus, which a title attribute cannot", async () => {
    const user = userEvent.setup();
    render(
      // The provider lives in the dashboard layout so delayDuration groups across the
      // whole list; a bare <Tooltip> is a Radix error, which is the point.
      <TooltipProvider>
        <Tooltip content="Only services created here can be destroyed here.">
          <button type="button">Why?</button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();
    expect(
      await screen.findByText("Only services created here can be destroyed here."),
    ).toBeInTheDocument();
  });
});

describe("useToast", () => {
  function Trigger() {
    const { toast } = useToast();
    return (
      <button type="button" onClick={() => toast({ title: "Done", tone: "success" })}>
        Fire
      </button>
    );
  }

  it("renders a toast and dismisses it", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Fire" }));
    expect(await screen.findByText("Done")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("throws outside a provider rather than swallowing the message", () => {
    // A silently dropped toast is a bug you only find in production.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});
