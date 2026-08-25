import { latLngToCell, gridDisk, cellToBoundary } from "h3-js";
import { haversineKm } from "../utils/geohash.js";

export interface SpatialProvider {
  id: string;
  name: string;
  lat: number;
  lng: number;
  tier: "Probationary" | "Standard" | "Trusted";
  rate: string;
  status: "available" | "unavailable";
  kycStatus: "pending" | "approved" | "rejected";
  ipAddress?: string;
  deviceId?: string;
  createdAt: string;
  stellarAddress?: string;
  reputationScore?: number;
  availableBalanceStroops?: bigint;
  pendingQueueDepth?: number;
  version?: number;
}

export interface H3CellMetrics {
  h3Index: string;
  activeRequestsCount: number;
  availableProvidersCount: number;
  demandRatio: number;
  feeMultiplier: number;
  updatedAt: string;
}

export type H3Resolution = 7 | 8 | 9;

// Hexagon edge length approximate radii in kilometers for gridDisk determination
export const H3_HEX_RADIUS_KM: Record<H3Resolution, number> = {
  7: 2.8,  // ~5.2 km diameter cell
  8: 1.0,  // ~1.9 km diameter cell
  9: 0.38, // ~0.7 km diameter cell
};

export interface SpatialMetricsConfig {
  BASE_FEE_MULTIPLIER: number;
  MAX_FEE_MULTIPLIER: number;
  DEMAND_RATIO_SLOPE: number;
  HOTSPOT_DEMAND_RATIO_THRESHOLD: number;
  DEFAULT_RESOLUTION: H3Resolution;
  MAX_GEOFENCE_RING_DISTANCE: number;
  METRIC_TTL_MS: number;
}

/**
 * Centralized configurable thresholds and weights for spatial hotspot incentive engine.
 */
export const SPATIAL_METRICS_CONFIG: SpatialMetricsConfig = {
  BASE_FEE_MULTIPLIER: 1.0,
  MAX_FEE_MULTIPLIER: 2.0,
  DEMAND_RATIO_SLOPE: 0.1, // formula: min(BASE + (demand_ratio * SLOPE), MAX)
  HOTSPOT_DEMAND_RATIO_THRESHOLD: 2.0,
  DEFAULT_RESOLUTION: 7,
  MAX_GEOFENCE_RING_DISTANCE: 1, // allows 1-ring neighbor tolerance for GPS drift
  METRIC_TTL_MS: 300_000, // 5 minutes TTL for stale metric pruning
};

/**
 * Calculate dynamic fee multiplier based on demand ratio.
 * Formula: min(BASE_FEE_MULTIPLIER + (demand_ratio * DEMAND_RATIO_SLOPE), MAX_FEE_MULTIPLIER)
 * Base: 1.00, Max: 2.00, Slope: 0.10
 */
export function calculateFeeMultiplier(
  demandRatio: number,
  customConfig?: Partial<SpatialMetricsConfig>
): number {
  const base = customConfig?.BASE_FEE_MULTIPLIER ?? SPATIAL_METRICS_CONFIG.BASE_FEE_MULTIPLIER;
  const max = customConfig?.MAX_FEE_MULTIPLIER ?? SPATIAL_METRICS_CONFIG.MAX_FEE_MULTIPLIER;
  const slope = customConfig?.DEMAND_RATIO_SLOPE ?? SPATIAL_METRICS_CONFIG.DEMAND_RATIO_SLOPE;

  if (isNaN(demandRatio) || demandRatio <= 1.0 || !isFinite(demandRatio)) {
    return base;
  }

  const calculated = base + demandRatio * slope;
  const clamped = Math.min(max, Math.max(base, calculated));
  return Math.round(clamped * 100) / 100;
}

/**
 * Calculate demand ratio for an H3 cell.
 * demand_ratio = active_requests_count / max(available_providers_count, 1)
 */
export function calculateDemandRatio(
  activeRequestsCount: number,
  availableProvidersCount: number
): number {
  if (isNaN(activeRequestsCount) || activeRequestsCount <= 0) return 0;
  const denominator = Math.max(1, isNaN(availableProvidersCount) ? 1 : availableProvidersCount);
  const ratio = activeRequestsCount / denominator;
  return Math.round(ratio * 100) / 100;
}

/**
 * Spatial Index for Cash Liquidity Providers using Uber H3.
 * Maintains O(1) cell buckets across resolutions 7, 8, and 9.
 * Includes Dynamic Geo-Spatial Liquidity Provider Rebalancing & Hotspot Incentive Engine.
 */
export class H3SpatialIndex {
  // Cell buckets: resolution -> cellId -> Set of provider IDs
  private buckets: Map<H3Resolution, Map<string, Set<string>>> = new Map([
    [7, new Map()],
    [8, new Map()],
    [9, new Map()],
  ]);

  // Provider location registry: providerId -> { lat, lng, cells: Map<resolution, cellId> }
  private providerLocations: Map<
    string,
    { lat: number; lng: number; cells: Map<H3Resolution, string> }
  > = new Map();

  // Registry of provider objects
  private providerMap: Map<string, SpatialProvider> = new Map();

  // Active cash requests tracking: resolution -> cellId -> count
  private activeRequests: Map<H3Resolution, Map<string, number>> = new Map([
    [7, new Map()],
    [8, new Map()],
    [9, new Map()],
  ]);

  // Cached H3 Cell Metrics for Resolution 7 hotspots
  private cellMetricsMap: Map<string, H3CellMetrics> = new Map();

  constructor() {}

  /**
   * Index or update a provider's location in H3 spatial buckets (Resolutions 7, 8, 9).
   */
  public indexProvider(provider: SpatialProvider): void {
    this.removeProvider(provider.id);

    this.providerMap.set(provider.id, provider);

    const cells = new Map<H3Resolution, string>();
    const resolutions: H3Resolution[] = [7, 8, 9];

    for (const res of resolutions) {
      const cellId = latLngToCell(provider.lat, provider.lng, res);
      cells.set(res, cellId);

      const resMap = this.buckets.get(res)!;
      if (!resMap.has(cellId)) {
        resMap.set(cellId, new Set());
      }
      resMap.get(cellId)!.add(provider.id);
    }

    this.providerLocations.set(provider.id, {
      lat: provider.lat,
      lng: provider.lng,
      cells,
    });

    // Auto-update cell metrics for Resolution 7
    const res7Cell = cells.get(7);
    if (res7Cell) {
      this.recalculateCellMetrics(res7Cell);
    }
  }

  /**
   * Remove a provider from all spatial buckets.
   */
  public removeProvider(providerId: string): void {
    const prev = this.providerLocations.get(providerId);
    if (prev) {
      for (const [res, cellId] of prev.cells.entries()) {
        const resMap = this.buckets.get(res);
        if (resMap && resMap.has(cellId)) {
          const set = resMap.get(cellId)!;
          set.delete(providerId);
          if (set.size === 0) {
            resMap.delete(cellId);
          }
        }
      }
      const res7Cell = prev.cells.get(7);
      this.providerLocations.delete(providerId);
      this.providerMap.delete(providerId);

      if (res7Cell) {
        this.recalculateCellMetrics(res7Cell);
      }
    } else {
      this.providerMap.delete(providerId);
    }
  }

  /**
   * Record a new active cash request in an H3 cell.
   */
  public recordActiveRequest(lat: number, lng: number): string {
    const cell7 = latLngToCell(lat, lng, 7);
    const map7 = this.activeRequests.get(7)!;
    map7.set(cell7, (map7.get(cell7) ?? 0) + 1);

    this.recalculateCellMetrics(cell7);
    return cell7;
  }

  /**
   * Record request by explicit cell ID.
   */
  public recordActiveRequestInCell(cell7: string): void {
    const map7 = this.activeRequests.get(7)!;
    map7.set(cell7, (map7.get(cell7) ?? 0) + 1);
    this.recalculateCellMetrics(cell7);
  }

  /**
   * Remove an active cash request from an H3 cell.
   */
  public removeActiveRequest(lat: number, lng: number): void {
    const cell7 = latLngToCell(lat, lng, 7);
    this.removeActiveRequestFromCell(cell7);
  }

  /**
   * Remove active request by explicit cell ID.
   */
  public removeActiveRequestFromCell(cell7: string): void {
    const map7 = this.activeRequests.get(7)!;
    const current = map7.get(cell7) ?? 0;
    if (current <= 1) {
      map7.delete(cell7);
    } else {
      map7.set(cell7, current - 1);
    }
    this.recalculateCellMetrics(cell7);
  }

  /**
   * Get active requests count for a cell.
   */
  public getActiveRequestsCount(cell7: string): number {
    return this.activeRequests.get(7)?.get(cell7) ?? 0;
  }

  /**
   * Get available providers count in a cell (Resolution 7).
   */
  public getAvailableProvidersCount(cell7: string): number {
    const providerIds = this.buckets.get(7)?.get(cell7);
    if (!providerIds) return 0;

    let availableCount = 0;
    for (const id of providerIds) {
      const p = this.providerMap.get(id);
      if (p && p.status === "available" && p.kycStatus === "approved") {
        availableCount++;
      }
    }
    return availableCount;
  }

  /**
   * Recalculate metrics for a specific H3 cell.
   */
  public recalculateCellMetrics(cell7: string): H3CellMetrics {
    const activeRequests = this.getActiveRequestsCount(cell7);
    const availableProviders = this.getAvailableProvidersCount(cell7);
    const demandRatio = calculateDemandRatio(activeRequests, availableProviders);
    const feeMultiplier = calculateFeeMultiplier(demandRatio);

    const metrics: H3CellMetrics = {
      h3Index: cell7,
      activeRequestsCount: activeRequests,
      availableProvidersCount: availableProviders,
      demandRatio,
      feeMultiplier,
      updatedAt: new Date().toISOString(),
    };

    this.cellMetricsMap.set(cell7, metrics);
    return metrics;
  }

  /**
   * Recalculate all active cells in the index.
   */
  public recalculateAllCellMetrics(): H3CellMetrics[] {
    const allCells = new Set<string>();

    // Collect all cells with active requests
    const activeMap = this.activeRequests.get(7);
    if (activeMap) {
      for (const cell of activeMap.keys()) {
        allCells.add(cell);
      }
    }

    // Collect all cells with providers
    const providerBucket = this.buckets.get(7);
    if (providerBucket) {
      for (const cell of providerBucket.keys()) {
        allCells.add(cell);
      }
    }

    const results: H3CellMetrics[] = [];
    for (const cell of allCells) {
      results.push(this.recalculateCellMetrics(cell));
    }
    return results;
  }

  /**
   * Get metrics for a specific cell.
   */
  public getCellMetrics(cell7: string): H3CellMetrics | undefined {
    return this.cellMetricsMap.get(cell7);
  }

  /**
   * Get all cached cell metrics.
   */
  public getAllCellMetrics(): H3CellMetrics[] {
    return Array.from(this.cellMetricsMap.values());
  }

  /**
   * Get high-demand hotspot cells (where demand_ratio > minDemandRatio, default 2.0).
   */
  public getHotspotCells(minDemandRatio: number = 2.0): H3CellMetrics[] {
    return Array.from(this.cellMetricsMap.values())
      .filter((m) => m.demandRatio > minDemandRatio)
      .sort((a, b) => b.demandRatio - a.demandRatio);
  }

  /**
   * Prune stale cached metrics that have no active requests, no providers,
   * or have not been updated within ttlMs.
   */
  public pruneStaleMetrics(ttlMs: number = SPATIAL_METRICS_CONFIG.METRIC_TTL_MS): number {
    const now = Date.now();
    let prunedCount = 0;
    for (const [cell7, metrics] of this.cellMetricsMap.entries()) {
      const activeCount = this.getActiveRequestsCount(cell7);
      const providerCount = this.getAvailableProvidersCount(cell7);
      const updatedAtMs = new Date(metrics.updatedAt).getTime();
      if (activeCount === 0 && providerCount === 0 && (now - updatedAtMs > ttlMs)) {
        this.cellMetricsMap.delete(cell7);
        prunedCount++;
      }
    }
    return prunedCount;
  }

  /**
   * Geofence Verification: Verify provider GPS coordinates match an H3 cell.
   * By default, allows a 1-ring neighbor tolerance (maxRingDistance = 1) to accommodate
   * natural GPS drift and border crossing at hexagonal boundaries while preventing arbitrary spoofing.
   * If strict cell equality is desired, pass maxRingDistance = 0.
   */
  public verifyProviderGeofence(
    lat: number,
    lng: number,
    targetH3Index: string,
    resolution: H3Resolution = 7,
    maxRingDistance: number = SPATIAL_METRICS_CONFIG.MAX_GEOFENCE_RING_DISTANCE
  ): boolean {
    if (isNaN(lat) || isNaN(lng) || !targetH3Index) return false;
    try {
      const computedCell = latLngToCell(lat, lng, resolution);
      if (computedCell.toLowerCase() === targetH3Index.toLowerCase()) {
        return true;
      }
      if (maxRingDistance > 0) {
        const neighborRing = gridDisk(targetH3Index, maxRingDistance);
        return neighborRing.some(
          (cell) => cell.toLowerCase() === computedCell.toLowerCase()
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get hotspot fee multiplier for a coordinate location.
   */
  public getHotspotMultiplier(lat: number, lng: number, resolution: H3Resolution = 7): number {
    const cellId = latLngToCell(lat, lng, resolution);
    const metrics = this.cellMetricsMap.get(cellId);
    return metrics ? metrics.feeMultiplier : 1.0;
  }

  /**
   * Determine optimal H3 resolution based on search radius in kilometers.
   */
  public getResolutionForRadius(radiusKm: number): H3Resolution {
    if (radiusKm <= 2.0) return 9;
    if (radiusKm <= 8.0) return 8;
    return 7;
  }

  /**
   * O(1) Spatial Proximity Query using H3 gridDisk (boundary hex crossing support).
   */
  public findProvidersInRadius(
    userLat: number,
    userLng: number,
    radiusKm: number,
    requestedResolution?: H3Resolution
  ): { provider: SpatialProvider; distanceKm: number; h3Index: string; feeMultiplier: number }[] {
    const res = requestedResolution ?? this.getResolutionForRadius(radiusKm);
    const centerCell = latLngToCell(userLat, userLng, res);

    // Calculate kRing (gridDisk distance) required to cover radiusKm
    const hexRadius = H3_HEX_RADIUS_KM[res];
    const kRing = Math.max(1, Math.ceil(radiusKm / (hexRadius * 1.5)));

    // Retrieve center cell + surrounding boundary hex cells
    const neighborCells = gridDisk(centerCell, kRing);
    const candidateIds = new Set<string>();

    const resMap = this.buckets.get(res);
    if (resMap) {
      for (const cellId of neighborCells) {
        const providerSet = resMap.get(cellId);
        if (providerSet) {
          for (const id of providerSet) {
            candidateIds.add(id);
          }
        }
      }
    }

    const results: {
      provider: SpatialProvider;
      distanceKm: number;
      h3Index: string;
      feeMultiplier: number;
    }[] = [];

    for (const id of candidateIds) {
      const p = this.providerMap.get(id);
      if (!p) continue;
      if (p.status !== "available" || p.kycStatus !== "approved") continue;

      // Calculate exact distance in km using haversineKm
      const distKm = haversineKm(userLat, userLng, p.lat, p.lng);

      if (distKm <= radiusKm) {
        const pLoc = this.providerLocations.get(id);
        const pCell = pLoc?.cells.get(res) ?? latLngToCell(p.lat, p.lng, res);
        const pCell7 = pLoc?.cells.get(7) ?? latLngToCell(p.lat, p.lng, 7);
        const cellMetrics = this.cellMetricsMap.get(pCell7);

        results.push({
          provider: p,
          distanceKm: distKm,
          h3Index: pCell,
          feeMultiplier: cellMetrics?.feeMultiplier ?? 1.0,
        });
      }
    }

    return results;
  }

  /**
   * Get total indexed provider count.
   */
  public size(): number {
    return this.providerMap.size;
  }

  /**
   * Clear all indexed providers, requests, and metrics.
   */
  public clear(): void {
    this.buckets.get(7)!.clear();
    this.buckets.get(8)!.clear();
    this.buckets.get(9)!.clear();
    this.providerLocations.clear();
    this.providerMap.clear();
    this.activeRequests.get(7)!.clear();
    this.activeRequests.get(8)!.clear();
    this.activeRequests.get(9)!.clear();
    this.cellMetricsMap.clear();
  }
}

// Global Singleton Spatial Index Instance
export const globalH3SpatialIndex = new H3SpatialIndex();

