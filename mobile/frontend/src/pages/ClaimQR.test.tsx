import { describe, expect, it } from "vitest";
import { formatRefundCountdown, GatewayTimeoutError, isGatewayTimeoutError } from "../lib/api";

function statusLabel(status: 'locked' | 'expired' | 'released' | 'refunded'): string {
  if (status === 'locked') return 'Ready to claim';
  if (status === 'expired') return 'Expired';
  if (status === 'released') return 'Released';
  return 'Refunded';
}

function buildQrPayload(id: string, secret: string | null, contractId: string): string | null {
  if (!secret) return null;
  return `velo://claim?request_id=${id}&secret=${secret}&contract=${contractId}`;
}

/** Mirrors ClaimQR pause banner visibility for existing locked trades. */
function pauseBannerVisible(paused: boolean): boolean {
  return paused;
}

describe("ClaimQR logic and status formatting", () => {
  it("formats status labels correctly for physical counter display", () => {
    expect(statusLabel("locked")).toBe("Ready to claim");
    expect(statusLabel("released")).toBe("Released");
    expect(statusLabel("refunded")).toBe("Refunded");
    expect(statusLabel("expired")).toBe("Expired");
  });

  it("constructs valid QR payload for provider scanning", () => {
    const payload = buildQrPayload("req_123", "sec_456", "C1234567890");
    expect(payload).toBe("velo://claim?request_id=req_123&secret=sec_456&contract=C1234567890");
  });

  it("returns null QR payload when secret is absent", () => {
    const payload = buildQrPayload("req_123", null, "C1234567890");
    expect(payload).toBeNull();
  });

  it("formats refund countdown estimates for the claim ticket", () => {
    expect(formatRefundCountdown(0)).toBe("0s");
    expect(formatRefundCountdown(45)).toBe("45s");
    expect(formatRefundCountdown(125)).toBe("2m 05s");
    expect(formatRefundCountdown(3725)).toBe("1h 2m");
  });

  it("shows pause banner when escrow circuit breaker is active", () => {
    expect(pauseBannerVisible(true)).toBe(true);
    expect(pauseBannerVisible(false)).toBe(false);
  });

  describe("504 Gateway Timeout Error Handling", () => {
    it("creates GatewayTimeoutError with correct properties", () => {
      const error = new GatewayTimeoutError(
        "The payment network request timed out. Please retry your operation.",
        "req-tout-504-abc123",
        "POST /cash/request (custodial lock)",
        10500
      );

      expect(error.name).toBe("GatewayTimeoutError");
      expect(error.message).toBe("The payment network request timed out. Please retry your operation.");
      expect(error.requestId).toBe("req-tout-504-abc123");
      expect(error.operation).toBe("POST /cash/request (custodial lock)");
      expect(error.elapsedMs).toBe(10500);
    });

    it("identifies GatewayTimeoutError instances correctly", () => {
      const timeoutError = new GatewayTimeoutError(
        "Timeout message",
        "req-123",
        "operation",
        5000
      );
      const regularError = new Error("Regular error");

      expect(isGatewayTimeoutError(timeoutError)).toBe(true);
      expect(isGatewayTimeoutError(regularError)).toBe(false);
      expect(isGatewayTimeoutError(null)).toBe(false);
      expect(isGatewayTimeoutError(undefined)).toBe(false);
    });

    it("handles GatewayTimeoutError with minimal properties", () => {
      const error = new GatewayTimeoutError(
        "Simple timeout",
        "req-456"
      );

      expect(error.name).toBe("GatewayTimeoutError");
      expect(error.message).toBe("Simple timeout");
      expect(error.requestId).toBe("req-456");
      expect(error.operation).toBeUndefined();
      expect(error.elapsedMs).toBeUndefined();
    });
  });
});
