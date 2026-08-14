import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  KeyValueEditor,
  type KeyValueError,
  type KeyValueRow,
} from "./key-value-editor";

/**
 * A controlled host, because the editor is controlled.
 *
 * Rendering it with a static `rows` prop would make every typing assertion pass or fail
 * on the harness rather than on the component.
 */
function Harness({
  initial = [],
  error,
  max = 25,
}: {
  initial?: KeyValueRow[];
  error?: KeyValueError;
  max?: number;
}) {
  const [rows, setRows] = useState<KeyValueRow[]>(initial);
  return (
    <form>
      <KeyValueEditor
        legend="Environment variables"
        rows={rows}
        onRowsChange={setRows}
        nameFieldName="variableKey"
        valueFieldName="variableValue"
        nameLabel="Variable name"
        valueLabel="Variable value"
        generatedPlaceholder="Generated for you"
        addLabel="Add variable"
        removeLabel={({ name, position }) =>
          name ? `Remove ${name}` : `Remove variable ${position}`
        }
        cellLabel={({ label, position }) => `${label} ${position}`}
        addedAnnouncement={(position) => `Added variable ${position}.`}
        removedAnnouncement={({ name, position }) =>
          name ? `Removed ${name}.` : `Removed variable ${position}.`
        }
        error={error}
        max={max}
        maxReachedLabel="That is the most you can set here."
      />
    </form>
  );
}

const row = (over: Partial<KeyValueRow> & { id: string }): KeyValueRow => ({
  name: "",
  value: "",
  ...over,
});

/** The two inputs of one row, by their row-disambiguated accessible names. */
const cells = (position: number) => ({
  name: screen.getByLabelText(`Variable name ${position}`),
  value: screen.getByLabelText(`Variable value ${position}`),
});

describe("KeyValueEditor", () => {
  it("labels every cell distinctly, so a row can be found by name", () => {
    // Five identical "Variable name" labels is a form that passes a visual review and
    // leaves a screen-reader user counting.
    render(
      <Harness
        initial={[row({ id: "a", name: "ONE" }), row({ id: "b", name: "TWO" })]}
      />,
    );

    expect(cells(1).name).toHaveValue("ONE");
    expect(cells(2).name).toHaveValue("TWO");
  });

  describe("the blank-row rule", () => {
    /*
     * The wire-format invariant, and the only place it is visible. An input with no
     * `name` is not submitted, which is what keeps a trailing blank row out of FormData
     * without the server guessing which indices to skip.
     */
    it("gives a fully blank row no name on either input", () => {
      render(<Harness initial={[row({ id: "a" })]} />);

      expect(cells(1).name).not.toHaveAttribute("name");
      expect(cells(1).value).not.toHaveAttribute("name");
    });

    it("names both inputs as soon as either cell is typed into", async () => {
      const user = userEvent.setup();
      render(<Harness initial={[row({ id: "a" })]} />);

      // Only the value, deliberately: naming one cell without the other would desync the
      // two parallel arrays the server reads.
      await user.type(cells(1).value, "x");

      expect(cells(1).name).toHaveAttribute("name", "variableKey");
      expect(cells(1).value).toHaveAttribute("name", "variableValue");
    });
  });

  describe("adding", () => {
    it("appends a row and moves focus into its name cell", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Add variable" }));

      expect(cells(1).name).toHaveFocus();
    });

    it("announces the addition", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Add variable" }));

      expect(screen.getByText("Added variable 1.")).toBeInTheDocument();
    });

    it("disables the control at the cap, and says why", async () => {
      const user = userEvent.setup();
      render(<Harness initial={[row({ id: "a", name: "ONE" })]} max={1} />);

      const add = screen.getByRole("button", { name: "Add variable" });
      expect(add).toBeDisabled();
      // Disabled with the reason beside it rather than hidden.
      expect(
        screen.getByText("That is the most you can set here."),
      ).toBeInTheDocument();

      await user.click(add);
      expect(screen.queryByLabelText("Variable name 2")).not.toBeInTheDocument();
    });
  });

  describe("removing", () => {
    it("names the variable it would remove", () => {
      render(<Harness initial={[row({ id: "a", name: "POSTGRES_PASSWORD" })]} />);

      expect(
        screen.getByRole("button", { name: "Remove POSTGRES_PASSWORD" }),
      ).toBeInTheDocument();
    });

    it("falls back to the row's position when it has no name yet", () => {
      render(<Harness initial={[row({ id: "a" }), row({ id: "b" })]} />);

      expect(
        screen.getByRole("button", { name: "Remove variable 2" }),
      ).toBeInTheDocument();
    });

    it("removes the row it names, after one above it was already removed", async () => {
      /*
       * The test that proves ids are not indices. Removing by position would work fine
       * on a fresh list and then delete the wrong row the moment the list has shifted —
       * which is the bug a keyed list exists to prevent.
       */
      const user = userEvent.setup();
      render(
        <Harness
          initial={[
            row({ id: "a", name: "ONE" }),
            row({ id: "b", name: "TWO" }),
            row({ id: "c", name: "THREE" }),
          ]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Remove ONE" }));
      await user.click(screen.getByRole("button", { name: "Remove THREE" }));

      expect(cells(1).name).toHaveValue("TWO");
      expect(screen.queryByLabelText("Variable name 2")).not.toBeInTheDocument();
    });

    it("moves focus to the row that took its place", async () => {
      const user = userEvent.setup();
      render(
        <Harness
          initial={[row({ id: "a", name: "ONE" }), row({ id: "b", name: "TWO" })]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Remove ONE" }));

      expect(screen.getByRole("button", { name: "Remove TWO" })).toHaveFocus();
    });

    it("moves focus to the previous row when the last one goes", async () => {
      const user = userEvent.setup();
      render(
        <Harness
          initial={[row({ id: "a", name: "ONE" }), row({ id: "b", name: "TWO" })]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Remove TWO" }));

      expect(screen.getByRole("button", { name: "Remove ONE" })).toHaveFocus();
    });

    it("falls back to the add control when no removable row is left", async () => {
      // Focus must never land on <body>: that is the moment a keyboard user loses
      // their place entirely.
      const user = userEvent.setup();
      render(<Harness initial={[row({ id: "a", name: "ONE" })]} />);

      await user.click(screen.getByRole("button", { name: "Remove ONE" }));

      expect(screen.getByRole("button", { name: "Add variable" })).toHaveFocus();
    });
  });

  describe("locked rows", () => {
    it("makes the name read-only and offers no remove control", () => {
      // Dropping the key an image needs to boot is the crash loop the catalog prevents.
      render(
        <Harness
          initial={[row({ id: "a", name: "POSTGRES_PASSWORD", locked: true })]}
        />,
      );

      expect(cells(1).name).toHaveAttribute("readonly");
      expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    });

    it("leaves the value editable, which is what overriding means here", async () => {
      const user = userEvent.setup();
      render(
        <Harness
          initial={[row({ id: "a", name: "POSTGRES_PASSWORD", locked: true })]}
        />,
      );

      await user.type(cells(1).value, "hunter2");

      expect(cells(1).value).toHaveValue("hunter2");
    });

    it("shows the generated placeholder while the value is blank", () => {
      /*
       * A placeholder, never content. If this ever becomes a value the browser holds,
       * the e2e assertion that a minted credential never appears in the page fails —
       * which is the design review that test performs.
       */
      render(
        <Harness
          initial={[
            row({
              id: "a",
              name: "POSTGRES_PASSWORD",
              locked: true,
              generatedWhenBlank: true,
            }),
          ]}
        />,
      );

      expect(cells(1).value).toHaveValue("");
      expect(cells(1).value).toHaveAttribute("placeholder", "Generated for you");
    });
  });

  describe("errors", () => {
    it("marks the offending cell, describes it, and announces it", () => {
      render(
        <Harness
          initial={[row({ id: "a", name: "1bad" })]}
          error={{ rowId: "a", cell: "name", message: "Variable names use letters" }}
        />,
      );

      expect(cells(1).name).toHaveAttribute("aria-invalid", "true");
      expect(cells(1).name).toHaveAccessibleDescription("Variable names use letters");
      expect(screen.getByRole("alert")).toHaveTextContent("Variable names use letters");
    });

    it("moves focus to the offending cell", () => {
      // A row can be below the fold, where an inline message announces to nobody.
      render(
        <Harness
          initial={[row({ id: "a", name: "OK" }), row({ id: "b", name: "1bad" })]}
          error={{ rowId: "b", cell: "name", message: "Variable names use letters" }}
        />,
      );

      expect(cells(2).name).toHaveFocus();
    });

    it("marks only the cell it names", () => {
      render(
        <Harness
          initial={[row({ id: "a", name: "OK", value: "x" })]}
          error={{ rowId: "a", cell: "value", message: "Values cannot contain breaks" }}
        />,
      );

      expect(cells(1).value).toHaveAttribute("aria-invalid", "true");
      expect(cells(1).name).not.toHaveAttribute("aria-invalid");
    });

    it("leaves other rows unmarked", () => {
      render(
        <Harness
          initial={[row({ id: "a", name: "OK" }), row({ id: "b", name: "1bad" })]}
          error={{ rowId: "b", cell: "name", message: "Variable names use letters" }}
        />,
      );

      expect(cells(1).name).not.toHaveAttribute("aria-invalid");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    });
  });
});
