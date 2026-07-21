/**
 * Privacy generalization for provider proximity matching (issue #216).
 *
 * Providers register with exact coordinates, but those coordinates are treated
 * as secret. Discovery responses are derived *only* from a provider's geohash
 * cell:
 *
 *  - The exact `lat`/`lng` are never returned by discovery.
 *  - The location shown is the provider's cell centroid (a fixed point per
 *    cell), plus the geohash string.
 *  - Distance is computed between the *query cell centroid* and the *provider
 *    cell centroid*, then quantized to a coarse band. Both endpoints are snapped
 *    to cells, so an adversary sweeping their query point sees a step function
 *    that only changes at cell boundaries: they can place a provider in its cell
 *    but never localize it more precisely than one cell (~1.2 km at the default
 *    precision 6).
 *  - Optional k-anonymity suppresses any cell holding fewer than `k` available
 *    providers, so a lone provider is never singled out.
 *
 * Exact coordinates are released only through the reveal-on-match path, to a
 * counterparty who already shares a locked escrow (a confirmed match) with the
 * provider.
 */

import type { ProviderRecord } from "../lib/store.js";
import { cellFor, decodeGeohash, haversineKm, type GeoCell } from "./geohash.js";

/** Default cell precision (6 ≈ 1.2 km cells). */
export const DEFAULT_PRECISION = 6;

/** Upper edges of the distance bands, in kilometres. */
const DISTANCE_BAND_EDGES_KM = [1, 2, 5, 10, 25];

/** Quantize a distance to a coarse, adversary-safe band label. */
export function distanceBand(km: number): string {
  let lower = 0;
  for (const edge of DISTANCE_BAND_EDGES_KM) {
    if (km < edge) return lower === 0 ? `<${edge}km` : `${lower}-${edge}km`;
    lower = edge;
  }
  return `>${lower}km`;
}

export interface PublicProvider {
  id: string;
  name: string;
  tier: ProviderRecord["tier"];
  rate: string;
  status: ProviderRecord["status"];
  /** Coarse geohash cell (the finest location the system will disclose). */
  geohash: string;
  /** Cell centroid — a fixed point per cell, NOT the provider's real position. */
  approx_lat: number;
  approx_lng: number;
  /** Approximate cell radius in metres, so clients can render uncertainty honestly. */
  cell_radius_m: number;
  /** Present only when the query supplied a location: a quantized distance band. */
  distance_band?: string;
}

function cellRadiusMeters(cell: GeoCell): number {
  // Half-diagonal of the cell, converted to metres (~111 km per degree lat).
  const latM = cell.latError * 111_000;
  const lonM = cell.lonError * 111_000 * Math.cos((cell.lat * Math.PI) / 180);
  return Math.round(Math.sqrt(latM * latM + lonM * lonM));
}

/** Generalize a provider to its public, cell-only view. */
export function toPublicProvider(
  provider: ProviderRecord,
  query?: { lat: number; lng: number; precision?: number },
  precision = DEFAULT_PRECISION,
): PublicProvider {
  const cell = cellFor(provider.lat, provider.lng, precision);
  const base: PublicProvider = {
    id: provider.id,
    name: provider.name,
    tier: provider.tier,
    rate: provider.rate,
    status: provider.status,
    geohash: cell.hash,
    approx_lat: round6(cell.lat),
    approx_lng: round6(cell.lon),
    cell_radius_m: cellRadiusMeters(cell),
  };

  if (query) {
    // Snap the query to its own cell centroid before measuring, so the reported
    // distance is a function of (query cell, provider cell) only.
    const queryCell = cellFor(query.lat, query.lng, query.precision ?? precision);
    const km = haversineKm(queryCell.lat, queryCell.lon, cell.lat, cell.lon);
    base.distance_band = distanceBand(km);
  }

  return base;
}

/**
 * Filter providers to those whose cell is within `radiusKm` of the query cell,
 * measured centroid-to-centroid with a one-cell tolerance so a provider sitting
 * near a boundary is not excluded (and the boundary itself does not leak exact
 * distance).
 */
export function withinRadius(
  providers: ProviderRecord[],
  query: { lat: number; lng: number },
  radiusKm: number,
  precision = DEFAULT_PRECISION,
): ProviderRecord[] {
  const queryCell = cellFor(query.lat, query.lng, precision);
  return providers.filter((p) => {
    const cell = cellFor(p.lat, p.lng, precision);
    const km = haversineKm(queryCell.lat, queryCell.lon, cell.lat, cell.lon);
    const tolerance = cellRadiusMeters(cell) / 1000;
    return km - tolerance <= radiusKm;
  });
}

/**
 * Apply k-anonymity: drop providers whose cell holds fewer than `k` available
 * providers. With `k <= 1` this is a no-op.
 */
export function applyKAnonymity(
  publicProviders: PublicProvider[],
  k: number,
): PublicProvider[] {
  if (k <= 1) return publicProviders;
  const counts = new Map<string, number>();
  for (const p of publicProviders) {
    counts.set(p.geohash, (counts.get(p.geohash) ?? 0) + 1);
  }
  return publicProviders.filter((p) => (counts.get(p.geohash) ?? 0) >= k);
}

/** True when a geohash decodes to a valid cell (input validation helper). */
export function isValidGeohash(hash: string): boolean {
  try {
    decodeGeohash(hash);
    return true;
  } catch {
    return false;
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
