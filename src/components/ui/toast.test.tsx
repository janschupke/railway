import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

/*
 * What jsdom can and cannot see here.
 *
 * The exit itself is Radix `Presence`, which holds a closing node in the tree for exactly
 * as long as an animation runs on it. jsdom runs none, so Presence unmounts immediately
 * and the animated dismissal is simply not observable in this environment — no amount of
 * fake timers changes that. e2e/motion.spec.ts asserts it in a real browser instead.
 *
 * What *is* worth pinning here is everything around it: the stack bound, the swipe
 * classes, and the fact that the root is rendered controlled at all — passing `open` is
 * what gives Presence something to close, and dropping it is how the exit was lost.
 */

function Trigger({ title = "Done" }: { title?: string }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ title, tone: "success" })}>
      Fire {title}
    </button>
  );
}

const provider = (children: React.ReactNode) =>
  render(<ToastProvider>{children}</ToastProvider>);

const root = (text: string) => screen.getByText(text).closest("li")!;

describe("useToast", () => {
  it("renders a toast and dismisses it", async () => {
    const user = userEvent.setup();
    provider(<Trigger />);

    await user.click(screen.getByRole("button", { name: /^Fire/ }));
    expect(await screen.findByText("Done")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("renders the root controlled, which is what gives it an exit at all", async () => {
    const user = userEvent.setup();
    provider(<Trigger />);
    await user.click(screen.getByRole("button", { name: /^Fire/ }));

    // data-state is Presence's own output, and it only exists on a controlled root.
    expect(root("Done")).toHaveAttribute("data-state", "open");
  });

  it("follows the pointer during a swipe instead of jumping on release", async () => {
    /*
     * There was a `data-[swipe=end]` rule and nothing else, so a half-finished drag did
     * not move the toast at all and a completed one teleported. Asserted as classes:
     * jsdom applies no Tailwind, and the class is what a future edit would drop.
     */
    const user = userEvent.setup();
    provider(<Trigger />);
    await user.click(screen.getByRole("button", { name: /^Fire/ }));

    const className = root("Done").className;
    expect(className).toContain("data-[swipe=move]:transition-none");
    expect(className).toContain("data-[swipe=cancel]:translate-x-0");
  });

  it("keeps the stack short, dropping the oldest", async () => {
    // A fourth toast means the first is no longer news, and a taller stack covers the
    // controls that produced it.
    const user = userEvent.setup();
    provider(
      <>
        <Trigger title="one" />
        <Trigger title="two" />
        <Trigger title="three" />
        <Trigger title="four" />
      </>,
    );

    for (const title of ["one", "two", "three", "four"]) {
      await user.click(screen.getByRole("button", { name: `Fire ${title}` }));
    }

    expect(screen.queryByText("one")).not.toBeInTheDocument();
    for (const title of ["two", "three", "four"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it("throws outside a provider rather than swallowing the message", () => {
    // A silently dropped toast is a bug you only find in production.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});
