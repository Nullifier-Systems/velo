import 
  { describe, it, expect, beforeEach, vi } 
from "vitest";
import {
  calculateMedian,
  reconcileRates,
  calculateTwap,
  recordRateSample,
  getTwap,
  TWAP_WINDOW_SAMPLES,
  RateSource,
  ReconciledRate,
  TwapSample,
} from "./rates.js";

// Mock the external dependencies
vi.mock("@stellar/stellar-sdk/rpc", () => ({
  Server: vi.fn(),
}));

describe("Rates Module", () => {
  describe("calculateMedian", () => {
    it("calculates median for odd number of values", () => {
      const result = calculateMedian([1, 2, 3, 4, 5]);
      expect(result).toBe(3);
    });

    it("calculates median for even number of values", () => {
      const result = calculateMedian([1, 2, 3, 4]);
      expect(result).toBe(2.5);
    });

    it("handles single value", () => {
      const result = calculateMedian([5]);
      expect(result).toBe(5);
    });

    it("handles negative values", () => {
      const result = calculateMedian([-5, -3, -1, 0, 2]);
      expect(result).toBe(-1);
    });

    it("handles decimal values", () => {
      const result = calculateMedian([1.5, 2.5, 3.5]);
      expect(result).toBe(2.5);
    });
  });

  describe("reconcileRates", () => {
    it("reconciles single source", () => {
      const sources: RateSource[] = [
        {
          name: "test",
          rate: 3.5,
          confidence: 0.9,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.reconciled_rate).toBe(3.5);
      expect(result.confidence_score).toBe(0.9);
      expect(result.deviation_warning).toBe(false);
      expect(result.sources).toHaveLength(1);
    });

    it("reconciles multiple sources with similar rates", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.5,
          confidence: 0.9,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 3.52,
          confidence: 0.85,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.reconciled_rate).toBeGreaterThan(3.5);
      expect(result.reconciled_rate).toBeLessThan(3.52);
      expect(result.confidence_score).toBeCloseTo(0.875, 2);
      expect(result.deviation_warning).toBe(false);
    });

    it("flags significant deviation", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.5,
          confidence: 0.9,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 4.0, // 14% deviation
          confidence: 0.85,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.deviation_warning).toBe(true);
      expect(result.confidence_score).toBeLessThan(0.875); // Reduced due to deviation
    });

    it("calculates weighted average based on confidence", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.0,
          confidence: 0.5, // Lower confidence
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 4.0,
          confidence: 0.9, // Higher confidence
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      // Weighted average should be closer to source2 due to higher confidence
      expect(result.reconciled_rate).toBeGreaterThan(3.5);
      expect(result.reconciled_rate).toBeLessThan(4.0);
    });

    it("throws error for empty sources", () => {
      expect(() => reconcileRates([])).toThrow("No rate sources provided");
    });

    it("handles three sources with median calculation", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.0,
          confidence: 0.8,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 3.5,
          confidence: 0.9,
          timestamp: new Date(),
        },
        {
          name: "source3",
          rate: 4.0,
          confidence: 0.85,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      // Median is 3.5, weighted average should be close to it
      expect(result.reconciled_rate).toBeCloseTo(3.5, 1);
      // Deviation is 14.2% from median (4.0 vs 3.5), which exceeds 5% threshold
      expect(result.deviation_warning).toBe(true);
    });
  });

  describe("Reconciliation edge cases", () => {
    it("handles extreme deviation", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 1.0,
          confidence: 0.9,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 10.0, // 900% deviation
          confidence: 0.9,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.deviation_warning).toBe(true);
      expect(result.confidence_score).toBeLessThan(0.9); // Significantly reduced
    });

    it("handles identical rates", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.5,
          confidence: 0.9,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 3.5,
          confidence: 0.85,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.reconciled_rate).toBe(3.5);
      expect(result.deviation_warning).toBe(false);
      expect(result.confidence_score).toBeCloseTo(0.875, 2);
    });

    it("handles very low confidence sources", () => {
      const sources: RateSource[] = [
        {
          name: "source1",
          rate: 3.5,
          confidence: 0.1,
          timestamp: new Date(),
        },
        {
          name: "source2",
          rate: 3.6,
          confidence: 0.2,
          timestamp: new Date(),
        },
      ];

      const result = reconcileRates(sources);

      expect(result.confidence_score).toBeCloseTo(0.15, 2);
      expect(result.deviation_warning).toBe(false);
    });
  });

  describe("TWAP collateral valuation (issue #420)", () => {
    const T0 = 1_700_000_000_000;

    const sample = (rate: number, offsetMs: number): TwapSample => ({
      rate,
      timestamp: T0 + offsetMs,
    });

    it("returns null with no samples", () => {
      expect(calculateTwap([])).toBeNull();
      expect(getTwap("usdc_xlm")).toBeNull();
    });

    it("weights each quote by the time it stood until the next one", () => {
      // 3.5 stands for 90s, then 4.5 for the final 10s → TWAP ≈ 3.6, not 4.0.
      const result = calculateTwap([sample(3.5, 0), sample(4.5, 90_000)], T0 + 100_000);
      expect(result).not.toBeNull();
      expect(result!.twap).toBeCloseTo(3.6, 9);
      expect(result!.sample_count).toBe(2);
      expect(result!.window_seconds).toBe(100);
    });

    it("damps a flash-loan-funded spot spike to near irrelevance", () => {
      // 15 minutes of stable 30s-cadence quotes at 3.5, then one spike to
      // 10.0 funded by a flash swap. Spot says 10.0; the TWAP barely moves:
      // one poisoned quote out of 31 carries ~1/31 of the total weight, so
      // the average must stay within a small band above the honest rate.
      const samples = Array.from({ length: 30 }, (_, i) => sample(3.5, i * 30_000));
      samples.push(sample(10.0, 900_000));

      const result = calculateTwap(samples, T0 + 930_000);

      expect(result!.twap).toBeGreaterThan(3.5);
      expect(result!.twap).toBeLessThan(3.75);
    });

    it("falls back to arithmetic mean when all samples share one timestamp", () => {
      const result = calculateTwap(
        [sample(3.0, 0), sample(5.0, 0), sample(4.0, 0)],
        T0,
      );
      expect(result!.twap).toBe(4.0);
      expect(result!.window_seconds).toBe(0);
    });

    it("recordRateSample ignores non-finite and non-positive rates", () => {
      recordRateSample("twap_test_pair", Number.NaN);
      recordRateSample("twap_test_pair", 0);
      recordRateSample("twap_test_pair", -3.5);
      expect(getTwap("twap_test_pair")).toBeNull();
      recordRateSample("twap_test_pair", 3.5);
      expect(getTwap("twap_test_pair")!.twap).toBe(3.5);
    });

    it("caps the series at TWAP_WINDOW_SAMPLES entries", () => {
      for (let i = 0; i < TWAP_WINDOW_SAMPLES + 10; i++) {
        recordRateSample("twap_cap_pair", 1 + i * 0.001, T0 + i * 1000);
      }
      const snapshot = getTwap("twap_cap_pair")!;
      expect(snapshot.sample_count).toBe(TWAP_WINDOW_SAMPLES);
    });
  });
});
