// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "zkSettle.modalTitle": "Zero-Knowledge Settlement",
        "zkSettle.secretLabel": "Credential Secret Key (64-char hex):",
        "zkSettle.secretPlaceholder": "e.g. 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "zkSettle.invalidHexKey": "Invalid hex key",
        "zkSettle.generatingProof": "Generating Proof...",
        "zkSettle.settlingOnStellar": "Settling on Stellar...",
        "zkSettle.closeModal": "Close Modal",
        "zkSettle.cancel": "Cancel",
        "zkSettle.generateAndSettle": "Generate Proof & Settle",
      };
      return translations[key] || key;
    },
  }),
}));

import { ZkSettlementModal } from "./ZkSettlementModal";

describe("ZkSettlementModal Component (Issue #371)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders modal when open and shows header", () => {
    render(<ZkSettlementModal isOpen={true} onClose={() => {}} />);
    expect(screen.getByText("Zero-Knowledge Settlement")).toBeDefined();
  });

  it("shows blur validation error for invalid hex secret key", () => {
    render(<ZkSettlementModal isOpen={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/1234567890/i);

    fireEvent.change(input, { target: { value: "invalid_short_key" } });
    fireEvent.blur(input);

    expect(screen.getByText("Invalid hex key")).toBeDefined();
  });

  it("clears error on valid 64-char hex key", () => {
    render(<ZkSettlementModal isOpen={true} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/1234567890/i);

    fireEvent.change(input, { target: { value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } });
    fireEvent.blur(input);

    expect(screen.queryByText("Invalid hex key")).toBeNull();
  });
});
