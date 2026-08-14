import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Disclosure } from "./disclosure";
import { Input } from "./input";

const panel = () => screen.getByRole("group") as HTMLDetailsElement;

describe("Disclosure", () => {
  it("starts closed, with the summary as its accessible name", () => {
    render(
      <Disclosure summary="Advanced settings">
        <p>hidden until asked for</p>
      </Disclosure>,
    );
    expect(panel().open).toBe(false);
    expect(screen.getByText("Advanced settings")).toBeInTheDocument();
  });

  it("opens on a click and closes again", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure summary="Advanced settings">
        <p>content</p>
      </Disclosure>,
    );

    await user.click(screen.getByText("Advanced settings"));
    expect(panel().open).toBe(true);
    await user.click(screen.getByText("Advanced settings"));
    expect(panel().open).toBe(false);
  });

  /*
   * The summary is in the tab order without a tabindex, which is half of why this is a
   * `<summary>` rather than a div with a click handler.
   *
   * The other half — that Enter and Space toggle it — is asserted in e2e/keyboard.spec.ts
   * rather than here, because jsdom does not implement the activation behaviour that turns
   * those keys into a click on this element. Asserting it in jsdom would be asserting
   * against the simulation, which is the same reason the Select's typeahead is proved in a
   * browser.
   */
  it("is reachable by keyboard with no tabindex of its own", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure summary="Advanced settings">
        <p>content</p>
      </Disclosure>,
    );

    await user.tab();
    expect(screen.getByText("Advanced settings")).toHaveFocus();
  });

  /*
   * The correctness property this component exists for. Collapsing the panel means "tidy
   * this away", not "throw this away" — somebody who sets three replicas, closes Advanced
   * and presses the button must get three replicas. Radix Collapsible unmounts closed
   * content by default, so this is the assertion that would fail the day someone swaps the
   * implementation for it.
   */
  it("submits a field inside it while it is closed", async () => {
    const user = userEvent.setup();
    render(
      <form aria-label="settings">
        <Disclosure summary="Advanced settings">
          <Input name="replicas" defaultValue="" aria-label="Replicas" />
        </Disclosure>
      </form>,
    );

    await user.click(screen.getByText("Advanced settings"));
    await user.type(screen.getByLabelText("Replicas"), "3");
    await user.click(screen.getByText("Advanced settings"));

    expect(panel().open).toBe(false);
    const form = screen.getByRole("form") as HTMLFormElement;
    expect(new FormData(form).get("replicas")).toBe("3");
  });

  it("forwards a ref, which is how a validation error opens the panel", () => {
    const ref = createRef<HTMLDetailsElement>();
    render(
      <Disclosure ref={ref} summary="Advanced settings">
        <p>content</p>
      </Disclosure>,
    );

    expect(ref.current?.open).toBe(false);
    ref.current!.open = true;
    expect(panel().open).toBe(true);
  });
});
