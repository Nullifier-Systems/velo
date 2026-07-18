export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Calculates bounding-box coordinates for a given search point and radius.
 * @param lat Target Latitude (degrees)
 * @param lon Target Longitude (degrees)
 * @param radiusInKm Search radius in kilometers
 */
export function getBoundingBox(lat: number, lon: number, radiusInKm: number): BoundingBox {
  const kmPerDegreeLat = 111;
  // Account for longitude shrinkage as we move away from the equator
  const kmPerDegreeLon = 111 * Math.cos(lat * (Math.PI / 180));

  const latDelta = radiusInKm / kmPerDegreeLat;
  const lonDelta = radiusInKm / kmPerDegreeLon;

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}