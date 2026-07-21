/**
 * Geohash encoding for privacy-preserving proximity matching (issue #216).
 *
 * A geohash maps a (lat, lon) point to a rectangular cell identified by a
 * base-32 string. The longer the string, the smaller the cell. We use the cell
 * as the *only* thing ever exposed for a provider's location: responses are a
 * pure function of the provider's cell, never of its exact coordinates, so an
 * adversary who queries repeatedly can never localize a provider more precisely
 * than one cell.
 *
 * This is a full, standard geohash (Niemeyer's base-32, bit-interleaved),
 * decoded to the exact cell centroid and error bounds — not a naive
 * lat/lon-string truncation, which leaks far more than its digit count implies.
 */

// Geohash base-32 alphabet (note: a, i, l, o are intentionally excluded).
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface GeoCell {
  /** The geohash string. */
  hash: string;
  /** Cell centroid. */
  lat: number;
  lon: number;
  /** Half-height and half-width of the cell in degrees. */
  latError: number;
  lonError: number;
}

/**
 * Approximate maximum cell dimension (metres) at each geohash precision.
 * Used to document and reason about the privacy granularity.
 */
export const GEOHASH_CELL_SIZE_METERS: Record<number, number> = {
  1: 5_000_000,
  2: 1_250_000,
  3: 156_000,
  4: 39_100,
  5: 4_890,
  6: 1_220,
  7: 153,
  8: 38,
};

/** Encode a coordinate to a geohash of the given precision (default 6 ≈ 1.2 km). */
export function encodeGeohash(lat: number, lon: number, precision = 6): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('encodeGeohash requires finite coordinates');
  }
  if (precision < 1 || precision > 12) {
    throw new Error('geohash precision must be between 1 and 12');
  }

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true; // even bits encode longitude, odd bits encode latitude

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        ch = (ch << 1) | 1;
        lonMin = mid;
      } else {
        ch <<= 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latMin = mid;
      } else {
        ch <<= 1;
        latMax = mid;
      }
    }
    even = !even;

    if (bit < 4) {
      bit += 1;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Decode a geohash to its cell centroid and error bounds. */
export function decodeGeohash(hash: string): GeoCell {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;

  for (const char of hash.toLowerCase()) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) throw new Error(`Invalid geohash character: ${char}`);
    for (let mask = 16; mask >= 1; mask >>= 1) {
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (idx & mask) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (idx & mask) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }

  return {
    hash,
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latError: (latMax - latMin) / 2,
    lonError: (lonMax - lonMin) / 2,
  };
}

/** Encode then decode, returning the full cell for a coordinate. */
export function cellFor(lat: number, lon: number, precision = 6): GeoCell {
  return decodeGeohash(encodeGeohash(lat, lon, precision));
}

/** Great-circle distance between two points in kilometres (Haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
