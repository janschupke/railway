import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "./banner";
import { Button } from "./button";
import { Card } from "./card";
import { EmptyState, Separator, Skeleton } from "./misc";
import { ScrollArea } from "./scroll-area";
import { Select } from "./select";
import { ToggleGroup } from "./toggle-group";
import { Tooltip } from "./tooltip";
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

describe("Separator, Skeleton, EmptyState", () => {
  it("renders a separator with an orientation", () => {
    const { container } = render(<Separator orientation="vertical" />);
    expect(container.querySelector("[data-orientation='vertical']")).not.toBeNull();
  });

  it("hides skeletons from assistive technology", () => {
    // The surrounding region already carries aria-busy; announcing shimmer is noise.
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
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
      <Tooltip content="Only services created here can be destroyed here.">
        <button type="button">Why?</button>
      </Tooltip>,
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
