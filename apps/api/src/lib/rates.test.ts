import 
  { describe, it, expect, beforeEach, vi } 
from "vitest";
import {
  calculateMedian,
  reconcileRates,
  RateSource,
  ReconciledRate,
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
      expect(result.deviation_warning).toBe(false);
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
});
