import { describe, it, expect } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "../i18n/index.js";
import { ZkSettlementModal } from "./ZkSettlementModal";

describe("ZkSettlementModal Component (Issue #371)", () => {
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
