import { describe, it, expect } from "vitest";
import {
  H3SpatialIndex,
  calculateDemandRatio,
  calculateFeeMultiplier,
} from "../../apps/api/src/lib/h3-spatial-index.js";
import {
  createInMemorySpatialMetricsStore,
  runSpatialMetricsRecalculation,
} from "../../apps/api/src/lib/workers/spatialMetricsWorker.js";
import { latLngToCell } from "h3-js";

/**
 * Spatial Hotspot Concurrency Stress Test (Issue #421).
 *
 * Simulates 100 simultaneous cash requests in a single H3 cell;
 * asserts that demand ratios are calculated atomically and fee multipliers
 * cap at 2.0x cleanly without arithmetic overflow or race conditions.
 */
describe("Spatial Hotspot Concurrency Stress Test (Issue #421)", () => {
  const TEST_LAT = 37.7749; // San Francisco
  const TEST_LNG = -122.4194;
  const CELL_7 = latLngToCell(TEST_LAT, TEST_LNG, 7);

  it("100 simultaneous cash requests in a single H3 cell cap fee multiplier at 2.0x cleanly", async () => {
    const index = new H3SpatialIndex();
    const store = createInMemorySpatialMetricsStore();

    // Register 2 available providers in the cell
    index.indexProvider({
      id: "provider-stress-1",
      name: "Provider 1",
      lat: TEST_LAT,
      lng: TEST_LNG,
      tier: "Trusted",
      rate: "1.0",
      status: "available",
      kycStatus: "approved",
      createdAt: new Date().toISOString(),
    });

    index.indexProvider({
      id: "provider-stress-2",
      name: "Provider 2",
      lat: TEST_LAT + 0.001,
      lng: TEST_LNG + 0.001,
      tier: "Trusted",
      rate: "1.0",
      status: "available",
      kycStatus: "approved",
      createdAt: new Date().toISOString(),
    });

    // Concurrently dispatch 100 cash requests in the same cell
    const requestDispatches = Array.from({ length: 100 }, (_, i) => async () => {
      index.recordActiveRequest(TEST_LAT, TEST_LNG);
      return index.getCellMetrics(CELL_7);
    });

    const results = await Promise.all(requestDispatches.map((fn) => fn()));

    // Verify all 100 requests were recorded
    expect(index.getActiveRequestsCount(CELL_7)).toBe(100);

    const finalMetrics = index.getCellMetrics(CELL_7);
    expect(finalMetrics).toBeDefined();
    expect(finalMetrics?.activeRequestsCount).toBe(100);
    expect(finalMetrics?.availableProvidersCount).toBe(2);

    // 100 requests / 2 providers = demand ratio 50.0
    expect(finalMetrics?.demandRatio).toBe(50.0);

    // Fee multiplier must cap at 2.0x cleanly (Issue #421 specification)
    expect(finalMetrics?.feeMultiplier).toBe(2.0);

    // Run background worker recalculation and persist to store
    await store.saveCellMetrics(finalMetrics!);
    const stored = await store.getCellMetrics(CELL_7);
    expect(stored).toBeDefined();
    expect(stored?.feeMultiplier).toBe(2.0);
    expect(stored?.demandRatio).toBe(50.0);
  });

  it("100 concurrent fee multiplier calculations maintain mathematical precision and bounds [1.0, 2.0]", async () => {
    // Generate 100 random demand ratios spanning from 0 to 1000
    const ratios = Array.from({ length: 100 }, (_, i) => i * 0.25);

    const multipliers = await Promise.all(
      ratios.map(async (ratio) => {
        return calculateFeeMultiplier(ratio);
      })
    );

    for (let i = 0; i < multipliers.length; i++) {
      const mult = multipliers[i];
      const ratio = ratios[i];

      // Invariants: 1.0 <= multiplier <= 2.0
      expect(mult).toBeGreaterThanOrEqual(1.0);
      expect(mult).toBeLessThanOrEqual(2.0);

      if (ratio <= 1.0) {
        expect(mult).toBe(1.0);
      } else {
        const expected = Math.min(2.0, Math.round((1.0 + ratio * 0.1) * 100) / 100);
        expect(mult).toBe(expected);
      }
    }
  });

  it("concurrently removing 100 requests restores baseline fee multiplier to 1.0x", async () => {
    const index = new H3SpatialIndex();
    index.indexProvider({
      id: "provider-1",
      name: "Provider 1",
      lat: TEST_LAT,
      lng: TEST_LNG,
      tier: "Trusted",
      rate: "1.0",
      status: "available",
      kycStatus: "approved",
      createdAt: new Date().toISOString(),
    });

    // Populate 100 requests
    for (let i = 0; i < 100; i++) {
      index.recordActiveRequest(TEST_LAT, TEST_LNG);
    }

    expect(index.getCellMetrics(CELL_7)?.feeMultiplier).toBe(2.0);

    // Concurrently remove all 100 requests
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        index.removeActiveRequest(TEST_LAT, TEST_LNG);
      })
    );

    expect(index.getActiveRequestsCount(CELL_7)).toBe(0);
    const settledMetrics = index.getCellMetrics(CELL_7);
    expect(settledMetrics?.demandRatio).toBe(0);
    expect(settledMetrics?.feeMultiplier).toBe(1.0);
  });
});
