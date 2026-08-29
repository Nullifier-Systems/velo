// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "../i18n/index.js";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicSwapDisputeCard } from "./AtomicSwapDisputeCard.js";

describe("AtomicSwapDisputeCard (#446)", () => {
  afterEach(() => {
    cleanup();
  });

  const defaultProps = {
    swapId: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    initiatorAddress: "GAINITIATOR00000000000000000000000000000000000000000000",
    counterpartyAddress: "GBCOUNTERPARTY000000000000000000000000000000000000000000",
    amountUsdc: "250.00",
    secretHash: "f".repeat(64),
    expirationLedger: 1000,
    currentLedger: 900,
    state: "ACTIVE" as const,
  };

  it("renders swap details, lock status, and disabled refund button before expiration", () => {
    render(<AtomicSwapDisputeCard {...defaultProps} />);

    expect(screen.getByText("Cross-Ledger Atomic Swap Bridge")).toBeInTheDocument();
    expect(screen.getByText("250.00 USDC")).toBeInTheDocument();
    expect(screen.getByTestId("swap-status-badge")).toHaveTextContent("Locked / Active");
    expect(screen.getByText("100 ledgers (~500s)")).toBeInTheDocument();

    const claimBtn = screen.getByTestId("claim-dispute-refund-button");
    expect(claimBtn).toBeDisabled();
    expect(claimBtn).toHaveTextContent("Refund Locked (100 ledgers left)");
  });

  it("enables Claim Dispute Refund button when expiration ledger is breached", async () => {
    const onClaimRefund = vi.fn();
    render(
      <AtomicSwapDisputeCard
        {...defaultProps}
        currentLedger={1050}
        onClaimRefund={onClaimRefund}
      />,
    );

    expect(screen.getByTestId("swap-status-badge")).toHaveTextContent("Refund Claimable");
    const claimBtn = screen.getByTestId("claim-dispute-refund-button");
    expect(claimBtn).not.toBeDisabled();
    expect(claimBtn).toHaveTextContent("Claim Dispute Refund");

    fireEvent.click(claimBtn);
    expect(onClaimRefund).toHaveBeenCalledWith(defaultProps.swapId);
  });

  it("handles secret extraction button and calls onExtractSecret", async () => {
    const onExtractSecret = vi.fn();
    render(
      <AtomicSwapDisputeCard
        {...defaultProps}
        onExtractSecret={onExtractSecret}
      />,
    );

    const input = screen.getByPlaceholderText("Enter revealed secret hex...");
    fireEvent.change(input, { target: { value: "a".repeat(64) } });

    const extractBtn = screen.getByText("Extract Secret");
    fireEvent.click(extractBtn);

    expect(onExtractSecret).toHaveBeenCalledWith(
      defaultProps.swapId,
      "a".repeat(64),
    );
  });
});
