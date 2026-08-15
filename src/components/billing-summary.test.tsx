import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpendCard, UsageCard } from "./billing-summary";

const spendProps = {
  heading: "Workspace spend",
  amount: "$18.40",
  amountLabel: "Used this period",
  periodLabel: "Billing period",
  period: "Aug 1, 2026 – Aug 31, 2026",
  workspaceLabel: "Workspace",
  workspace: "Acme",
  caveat: "That covers every service in the workspace.",
  unavailable: "Railway reports spend per workspace.",
  billingHref: "https://railway.com/account/billing",
  billingLabel: "Open billing on Railway",
};

const usageProps = {
  heading: "Usage by containers created here",
  cpu: "0.50 vCPU",
  cpuLabel: "vCPU",
  memory: "1.0 GB",
  memoryLabel: "Memory",
  containers: "2",
  containersLabel: "Containers",
  scope: "This is not the figure Railway bills.",
  none: "Railway has reported no usage yet.",
};

describe("SpendCard", () => {
  it("pairs every figure with the label that scopes it", async () => {
    render(<SpendCard {...spendProps} />);

    // A definition list rather than three loose lines: the label is what makes "$18.40"
    // mean anything, and the pairing has to survive being read out of order.
    for (const [term, definition] of [
      ["Used this period", "$18.40"],
      ["Billing period", "Aug 1, 2026 – Aug 31, 2026"],
      ["Workspace", "Acme"],
    ]) {
      expect(screen.getByText(term ?? "").tagName).toBe("DT");
      expect(screen.getByText(definition ?? "").tagName).toBe("DD");
    }
  });

  it("keeps the caveat with the figure it qualifies", () => {
    render(<SpendCard {...spendProps} />);
    expect(screen.getByText(spendProps.caveat)).toBeInTheDocument();
  });

  it("drops the whole readout, caveat included, when there is no figure", async () => {
    // An absent number has nothing to qualify; the caveat under it would be explaining a
    // figure that is not there.
    render(<SpendCard {...spendProps} amount={null} />);

    expect(screen.getByText(spendProps.unavailable)).toBeInTheDocument();
    expect(screen.queryByText(spendProps.caveat)).toBeNull();
    expect(screen.queryByText("$18.40")).toBeNull();
  });

  it("keeps the way out to Railway on both branches", () => {
    // The one thing a reader can act on here, and it is the whole point of the absent
    // branch — so it must not live inside the figure's own block.
    render(<SpendCard {...spendProps} amount={null} />);

    expect(
      screen.getByRole("link", { name: /Open billing on Railway/ }),
    ).toHaveAttribute("href", spendProps.billingHref);
  });
});

describe("UsageCard", () => {
  it("pairs every figure with its label", () => {
    render(<UsageCard {...usageProps} />);

    expect(screen.getByText("vCPU").tagName).toBe("DT");
    expect(screen.getByText("0.50 vCPU").tagName).toBe("DD");
    expect(screen.getByText("2").tagName).toBe("DD");
  });

  it("says nothing was reported rather than printing an absent figure", () => {
    render(<UsageCard {...usageProps} cpu={null} memory={null} />);

    expect(screen.getByText(usageProps.none)).toBeInTheDocument();
    expect(screen.queryByText("0.50 vCPU")).toBeNull();
  });

  it("keeps the scope sentence on both branches", () => {
    /*
     * Required rather than decorative. This card renders beside a dollar figure, and
     * without a line saying the two are neither the same scope nor the basis of one
     * another they read as a single readout — which is the misreading
     * container-section.tsx used to prevent by keeping them on separate surfaces.
     */
    render(<UsageCard {...usageProps} cpu={null} memory={null} />);
    expect(screen.getByText(usageProps.scope)).toBeInTheDocument();
  });

  it("heads each card so the two scopes cannot be read as one", () => {
    render(
      <>
        <SpendCard {...spendProps} />
        <UsageCard {...usageProps} />
      </>,
    );

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Workspace spend", "Usage by containers created here"]);
  });
});
