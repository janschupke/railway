import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Input } from "./input";

describe("Field", () => {
  it("associates the label with the control", () => {
    render(
      <Field label="Image reference">
        {(props) => <Input {...props} name="image" />}
      </Field>,
    );

    // getByLabelText only resolves if the htmlFor/id wiring is real.
    expect(screen.getByLabelText("Image reference")).toBeInTheDocument();
  });

  it("describes the control with its hint", () => {
    render(
      <Field label="Name" hint="Prefixed automatically">
        {(props) => <Input {...props} />}
      </Field>,
    );

    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "Prefixed automatically",
    );
  });

  it("replaces the hint with the error rather than stacking both", () => {
    // Two competing descriptions read as one run-on sentence to a screen reader.
    render(
      <Field label="Name" hint="Prefixed automatically" error="Give it a name">
        {(props) => <Input {...props} />}
      </Field>,
    );

    const input = screen.getByLabelText("Name");
    expect(input).toHaveAccessibleDescription("Give it a name");
    expect(screen.queryByText("Prefixed automatically")).not.toBeInTheDocument();
  });

  it("marks the control invalid and announces the error", () => {
    render(
      <Field label="Name" error="Give it a name">
        {(props) => <Input {...props} />}
      </Field>,
    );

    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Give it a name");
  });

  it("adds no description when there is neither hint nor error", () => {
    render(<Field label="Name">{(props) => <Input {...props} />}</Field>);
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });

  describe("a warning", () => {
    it("describes the control in place of the hint", () => {
      render(
        <Field label="Image" hint="Pick one" warning="No public image matches">
          {(props) => <Input {...props} />}
        </Field>,
      );

      expect(screen.getByLabelText("Image")).toHaveAccessibleDescription(
        "No public image matches",
      );
      expect(screen.queryByText("Pick one")).not.toBeInTheDocument();
    });

    /*
     * The distinction the whole prop exists for: a warning says something is probably
     * wrong, and the form will still accept it. Claiming aria-invalid would tell a screen
     * reader the value is refused when submitting is in fact the right move.
     */
    it("does not mark the control invalid", () => {
      render(
        <Field label="Image" warning="No public image matches">
          {(props) => <Input {...props} />}
        </Field>,
      );

      expect(screen.getByLabelText("Image")).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("waits its turn rather than interrupting", () => {
      // Polite, because this appears while someone is still typing into the field.
      render(
        <Field label="Image" warning="No public image matches">
          {(props) => <Input {...props} />}
        </Field>,
      );

      expect(screen.getByRole("status")).toHaveTextContent("No public image matches");
    });

    it("loses to an error about the same value", () => {
      render(
        <Field
          label="Image"
          hint="Pick one"
          warning="No public image matches"
          error="Not a valid reference"
        >
          {(props) => <Input {...props} />}
        </Field>,
      );

      const input = screen.getByLabelText("Image");
      expect(input).toHaveAccessibleDescription("Not a valid reference");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.queryByText("No public image matches")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  it("gives each instance its own ids", () => {
    // Duplicated ids would silently point every label at the first input.
    render(
      <>
        <Field label="First">{(props) => <Input {...props} />}</Field>
        <Field label="Second">{(props) => <Input {...props} />}</Field>
      </>,
    );

    expect(screen.getByLabelText("First")).not.toBe(screen.getByLabelText("Second"));
  });
});
