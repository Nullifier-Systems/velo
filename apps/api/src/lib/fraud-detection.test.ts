import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkFraud,
  getFraudFlags,
  clearFraudFlags,
  clearVelocityStore,
  resetConfig,
} from "./fraud-detection.js";

const BUYER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SELLER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeInput(overrides: Partial<{ tradeId: string; buyer: string; seller: string; amountStroops: string }> = {}) {
  return {
    tradeId: overrides.tradeId ?? "trade-001",
    buyer: overrides.buyer ?? BUYER,
    seller: overrides.seller ?? SELLER,
    amountStroops: overrides.amountStroops ?? "1000000",
  };
}

describe("fraud-detection", () => {
  beforeEach(() => {
    clearFraudFlags();
    clearVelocityStore();
    resetConfig();
    // Defaults: max 5 requests per 60 s, large-amount 100 000 000 000 stroops
    delete process.env.FRAUD_MAX_REQUESTS_PER_WINDOW;
    delete process.env.FRAUD_WINDOW_MS;
    delete process.env.FRAUD_LARGE_AMOUNT_STROOPS;
    delete process.env.FRAUD_BUYER_ALLOWLIST;
  });

  afterEach(() => {
    clearFraudFlags();
    clearVelocityStore();
    resetConfig();
  });

  describe("velocity check", () => {
    it("does not flag when request count is within threshold", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const result = checkFraud({ ...makeInput(), tradeId: `trade-${i}` }, now + i);
        expect(result.flagged).toBe(false);
      }
      expect(getFraudFlags()).toHaveLength(0);
    });

    it("flags when buyer exceeds max requests per window", () => {
      const now = Date.now();
      let lastResult;
      for (let i = 0; i < 6; i++) {
        lastResult = checkFraud({ ...makeInput(), tradeId: `trade-${i}` }, now + i);
      }
      expect(lastResult!.flagged).toBe(true);
      expect(lastResult!.reasons[0]).toMatch(/velocity/);
      expect(getFraudFlags()).toHaveLength(1);
    });

    it("does not count requests outside the sliding window", () => {
      process.env.FRAUD_MAX_REQUESTS_PER_WINDOW = "2";
      process.env.FRAUD_WINDOW_MS = "1000"; // 1 second
      resetConfig();

      const now = 1_000_000;
      // 2 requests in the window
      checkFraud({ ...makeInput(), tradeId: "t1" }, now);
      checkFraud({ ...makeInput(), tradeId: "t2" }, now + 100);
      // 3rd request well outside the window (2 s later) — should NOT flag
      const result = checkFraud({ ...makeInput(), tradeId: "t3" }, now + 2000);
      expect(result.flagged).toBe(false);
      expect(getFraudFlags()).toHaveLength(0);
    });

    it("uses configurable threshold from env", () => {
      process.env.FRAUD_MAX_REQUESTS_PER_WINDOW = "2";
      resetConfig();

      const now = Date.now();
      checkFraud({ ...makeInput(), tradeId: "t1" }, now);
      checkFraud({ ...makeInput(), tradeId: "t2" }, now + 1);
      const result = checkFraud({ ...makeInput(), tradeId: "t3" }, now + 2);
      expect(result.flagged).toBe(true);
      expect(result.windowCount).toBe(3);
    });
  });

  describe("large-amount check", () => {
    it("flags amounts exceeding the threshold", () => {
      process.env.FRAUD_LARGE_AMOUNT_STROOPS = "500000000"; // 50 XLM equiv.
      resetConfig();

      const result = checkFraud(makeInput({ amountStroops: "600000000" }));
      expect(result.flagged).toBe(true);
      expect(result.reasons.some((r) => r.includes("large_amount"))).toBe(true);
    });

    it("does not flag amounts below the threshold", () => {
      process.env.FRAUD_LARGE_AMOUNT_STROOPS = "500000000";
      resetConfig();

      const result = checkFraud(makeInput({ amountStroops: "400000000" }));
      expect(result.flagged).toBe(false);
    });

    it("disables large-amount check when threshold is 0", () => {
      process.env.FRAUD_LARGE_AMOUNT_STROOPS = "0";
      resetConfig();

      const result = checkFraud(makeInput({ amountStroops: "999999999999999" }));
      // Only velocity matters; 1st request is never velocity-flagged
      expect(result.reasons.every((r) => r.includes("large_amount") === false)).toBe(true);
    });
  });

  describe("allowlist", () => {
    it("skips checks entirely for allowlisted buyers", () => {
      process.env.FRAUD_MAX_REQUESTS_PER_WINDOW = "1";
      process.env.FRAUD_BUYER_ALLOWLIST = BUYER;
      resetConfig();

      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        const result = checkFraud({ ...makeInput(), tradeId: `t${i}` }, now + i);
        expect(result.flagged).toBe(false);
      }
    });
  });

  describe("flag store", () => {
    it("persists flagged requests in the store", () => {
      process.env.FRAUD_MAX_REQUESTS_PER_WINDOW = "1";
      resetConfig();

      const now = Date.now();
      checkFraud({ ...makeInput(), tradeId: "t1" }, now);
      checkFraud({ ...makeInput(), tradeId: "t2" }, now + 1);

      const flags = getFraudFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0].tradeId).toBe("t2");
      expect(flags[0].buyer).toBe(BUYER);
    });

    it("stores a flaggedAt ISO timestamp", () => {
      process.env.FRAUD_MAX_REQUESTS_PER_WINDOW = "1";
      resetConfig();

      const now = 1_700_000_000_000;
      checkFraud({ ...makeInput(), tradeId: "t1" }, now);
      checkFraud({ ...makeInput(), tradeId: "t2" }, now + 1);

      const flags = getFraudFlags();
      expect(flags[0].flaggedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("non-blocking guarantee", () => {
    it("returns a result even for malformed amountStroops", () => {
      const result = checkFraud(makeInput({ amountStroops: "not-a-number" }));
      // should not throw, flagged only by velocity if any
      expect(result).toHaveProperty("flagged");
    });
  });
});
