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
