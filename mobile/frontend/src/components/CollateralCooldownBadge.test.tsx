// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../i18n/index.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import CollateralCooldownBadge from "./CollateralCooldownBadge.js";

describe("CollateralCooldownBadge (#420)", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows remaining ledgers and seconds while locked", () => {
    render(<CollateralCooldownBadge remainingLedgers={3} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Locked: 3 Ledgers Remaining (~15s)",
    );
  });

  it("shows the unlocked state when the cooldown has expired", () => {
    render(<CollateralCooldownBadge remainingLedgers={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("Collateral Unlocked");
  });
});
