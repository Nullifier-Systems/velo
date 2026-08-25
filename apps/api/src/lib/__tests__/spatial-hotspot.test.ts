import { describe, it, expect, beforeEach } from "vitest";
import {
  H3SpatialIndex,
  calculateDemandRatio,
  calculateFeeMultiplier,
  type SpatialProvider,
} from "../h3-spatial-index.js";
import {
  MultiParametricMatchingEngine,
} from "../matching-engine.js";
import {
  createInMemorySpatialMetricsStore,
  runSpatialMetricsRecalculation,
} from "../workers/spatialMetricsWorker.js";
import { latLngToCell } from "h3-js";

describe("Dynamic Geo-Spatial Liquidity Provider Rebalancing & Hotspot Incentive Engine (Issue #421)", () => {
  let index: H3SpatialIndex;

  beforeEach(() => {
    index = new H3SpatialIndex();
  });

  const createMockProvider = (
    id: string,
    lat: number,
    lng: number,
    tier: "Probationary" | "Standard" | "Trusted" = "Trusted"
  ): SpatialProvider => ({
    id,
    name: `Provider ${id}`,
    lat,
    lng,
    tier: "Trusted",
    rate: "1.0",
    status: "available",
    kycStatus: "approved",
    createdAt: new Date().toISOString(),
  });

  it("calculates demand ratio and dynamic fee multipliers correctly", () => {
    // 0 requests, 1 provider -> ratio 0, multiplier 1.0
    expect(calculateDemandRatio(0, 1)).toBe(0);
    expect(calculateFeeMultiplier(0)).toBe(1.0);

    // 2 requests, 1 provider -> ratio 2.0, multiplier 1.2
    expect(calculateDemandRatio(2, 1)).toBe(2.0);
    expect(calculateFeeMultiplier(2.0)).toBe(1.2);

    // 5 requests, 1 provider -> ratio 5.0, multiplier 1.5
    expect(calculateDemandRatio(5, 1)).toBe(5.0);
    expect(calculateFeeMultiplier(5.0)).toBe(1.5);

    // 15 requests, 1 provider -> ratio 15.0, capped at 2.0
    expect(calculateDemandRatio(15, 1)).toBe(15.0);
    expect(calculateFeeMultiplier(15.0)).toBe(2.0);

    // 0 available providers avoids division by zero
    expect(calculateDemandRatio(10, 0)).toBe(10.0);
    expect(calculateFeeMultiplier(10.0)).toBe(2.0);
  });

  it("indexes active requests, providers, and updates cell metrics", () => {
    const lat = 40.7128;
    const lng = -74.006;
    const cell7 = latLngToCell(lat, lng, 7);

    // Register 1 provider in the cell
    const p1 = createMockProvider("p1", lat, lng);
    index.indexProvider(p1);

    expect(index.getAvailableProvidersCount(cell7)).toBe(1);
    expect(index.getActiveRequestsCount(cell7)).toBe(0);

    // Add 4 active requests
    for (let i = 0; i < 4; i++) {
      index.recordActiveRequest(lat, lng);
    }

    expect(index.getActiveRequestsCount(cell7)).toBe(4);

    const metrics = index.getCellMetrics(cell7);
    expect(metrics).toBeDefined();
    expect(metrics?.demandRatio).toBe(4.0);
    expect(metrics?.feeMultiplier).toBe(1.4);

    // Removing a request lowers demand
    index.removeActiveRequest(lat, lng);
    const updated = index.getCellMetrics(cell7);
    expect(updated?.activeRequestsCount).toBe(3);
    expect(updated?.demandRatio).toBe(3.0);
    expect(updated?.feeMultiplier).toBe(1.3);
  });

  it("verifies provider geofence against target H3 cell boundaries", () => {
    const lat = 51.5074;
    const lng = -0.1278;
    const cell7 = latLngToCell(lat, lng, 7);

    expect(index.verifyProviderGeofence(lat, lng, cell7, 7, 0)).toBe(true);

    // Adjacent coordinate within 1-ring should pass when maxRingDistance >= 1
    const adjacentLat = lat + 0.02; // slightly offset
    const adjacentCell = latLngToCell(adjacentLat, lng, 7);
    expect(index.verifyProviderGeofence(adjacentLat, lng, cell7, 7, 1)).toBe(true);

    // Far away coordinate should fail verification
    expect(index.verifyProviderGeofence(40.7128, -74.006, cell7, 7, 1)).toBe(false);

    // Invalid coordinates / NaN should fail gracefully
    expect(index.verifyProviderGeofence(NaN, lng, cell7, 7, 1)).toBe(false);
    expect(index.verifyProviderGeofence(lat, NaN, "", 7, 1)).toBe(false);
  });

  it("handles multiplier edge cases and custom configuration correctly", () => {
    // Edge case: NaN, negative, or Infinity
    expect(calculateFeeMultiplier(NaN)).toBe(1.0);
    expect(calculateFeeMultiplier(-5.0)).toBe(1.0);
    expect(calculateFeeMultiplier(Infinity)).toBe(1.0);

    // Edge case: custom configurable slope and cap
    const customConfig = {
      BASE_FEE_MULTIPLIER: 1.1,
      MAX_FEE_MULTIPLIER: 2.5,
      DEMAND_RATIO_SLOPE: 0.2,
    };
    expect(calculateFeeMultiplier(3.0, customConfig)).toBe(1.7);
    expect(calculateFeeMultiplier(10.0, customConfig)).toBe(2.5); // capped at 2.5
  });

  it("prunes stale metrics after TTL expires for inactive cells", () => {
    const lat = 34.0522;
    const lng = -118.2437;
    const cell7 = latLngToCell(lat, lng, 7);

    index.recordActiveRequest(lat, lng);
    expect(index.getCellMetrics(cell7)).toBeDefined();

    // Remove active request so cell is inactive
    index.removeActiveRequest(lat, lng);
    expect(index.getActiveRequestsCount(cell7)).toBe(0);

    // Mock old timestamp
    const metrics = index.getCellMetrics(cell7)!;
    metrics.updatedAt = new Date(Date.now() - 400_000).toISOString();

    // Prune metrics with 300s (5 min) TTL
    const pruned = index.pruneStaleMetrics(300_000);
    expect(pruned).toBe(1);
    expect(index.getCellMetrics(cell7)).toBeUndefined();
  });

  it("prioritizes candidates in high-demand hotspot cells in the matching engine", () => {
    const engine = new MultiParametricMatchingEngine();
    const pNormal = createMockProvider("p-normal", 40.7128, -74.006);
    const pHotspot = createMockProvider("p-hotspot", 40.7128, -74.006);

    const scored = engine.scoreCandidates(
      [
        { provider: pNormal, distanceKm: 1.0, feeMultiplier: 1.0 },
        { provider: pHotspot, distanceKm: 1.0, feeMultiplier: 1.8 },
      ],
      5.0
    );

    expect(scored[0].provider.id).toBe("p-hotspot");
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
    expect(scored[0].breakdown.hotspotIncentiveScore).toBe(0.8);
    expect(scored[1].breakdown.hotspotIncentiveScore).toBe(0.0);
  });

  it("recalculation worker aggregates active cells, prunes stale, and handles distributed locking", async () => {
    const store = createInMemorySpatialMetricsStore();
    const lat = 48.8566;
    const lng = 2.3522;

    // 1 provider, 3 requests -> demand ratio 3.0 > 2.0 (Hotspot)
    index.indexProvider(createMockProvider("paris-p1", lat, lng));
    index.recordActiveRequest(lat, lng);
    index.recordActiveRequest(lat, lng);
    index.recordActiveRequest(lat, lng);

    const report = await runSpatialMetricsRecalculation(store, index);
    expect(report.cellsProcessed).toBeGreaterThanOrEqual(1);

    const storedMetrics = await store.getHotspotMetrics(2.0);
    expect(storedMetrics.length).toBeGreaterThanOrEqual(1);

    // Test distributed lock acquisition
    const lock1 = await store.acquireDistributedLock?.();
    expect(lock1).toBe(true);
    const lock2 = await store.acquireDistributedLock?.();
    expect(lock2).toBe(false); // Second concurrent instance blocked
    await store.releaseDistributedLock?.();
  });

  it("converts H3 index to closed GeoJSON polygon ring", async () => {
    const { h3CellToGeoJsonPolygon } = await import("../../routes/spatial-hotspots.js");
    const h3Index = "872830828ffffff";
    const polygon = h3CellToGeoJsonPolygon(h3Index);

    expect(polygon.length).toBe(1);
    expect(polygon[0].length).toBeGreaterThanOrEqual(7);

    const first = polygon[0][0];
    const last = polygon[0][polygon[0].length - 1];
    expect(first[0]).toBe(last[0]);
    expect(first[1]).toBe(last[1]);
  });
});
