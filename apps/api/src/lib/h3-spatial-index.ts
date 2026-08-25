import { latLngToCell, gridDisk } from "h3-js";
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

export type H3Resolution = 7 | 8 | 9;

// Hexagon edge length approximate radii in kilometers for gridDisk determination
export const H3_HEX_RADIUS_KM: Record<H3Resolution, number> = {
  7: 2.8,  // ~5.2 km diameter cell
  8: 1.0,  // ~1.9 km diameter cell
  9: 0.38, // ~0.7 km diameter cell
};

/**
 * Spatial Index for Cash Liquidity Providers using Uber H3.
 * Maintains O(1) cell buckets across resolutions 7, 8, and 9.
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
      this.providerLocations.delete(providerId);
    }
    this.providerMap.delete(providerId);
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
  ): { provider: SpatialProvider; distanceKm: number; h3Index: string }[] {
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

    const results: { provider: SpatialProvider; distanceKm: number; h3Index: string }[] = [];

    for (const id of candidateIds) {
      const p = this.providerMap.get(id);
      if (!p) continue;
      if (p.status !== "available" || p.kycStatus !== "approved") continue;

      // Calculate exact distance in km using haversineKm
      const distKm = haversineKm(userLat, userLng, p.lat, p.lng);

      if (distKm <= radiusKm) {
        const pLoc = this.providerLocations.get(id);
        const pCell = pLoc?.cells.get(res) ?? latLngToCell(p.lat, p.lng, res);
        results.push({
          provider: p,
          distanceKm: distKm,
          h3Index: pCell,
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
   * Clear all indexed providers.
   */
  public clear(): void {
    this.buckets.get(7)!.clear();
    this.buckets.get(8)!.clear();
    this.buckets.get(9)!.clear();
    this.providerLocations.clear();
    this.providerMap.clear();
  }
}

// Global Singleton Spatial Index Instance
export const globalH3SpatialIndex = new H3SpatialIndex();

export function getH3Index(lat: number, lng: number, resolution: number): string {
    return latLngToCell(lat, lng, resolution);
}
