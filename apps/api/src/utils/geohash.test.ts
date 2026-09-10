import { describe, expect, it } from "vitest";
import {
  encodeGeohash,
  decodeGeohash,
  cellFor,
  haversineKm,
  isPointInPolygon,
  evaluateGeofenceCompliance,
} from "./geohash.js";

describe("geohash", () => {
  it("encodes known reference points correctly", () => {
    // Standard geohash reference vectors.
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    expect(encodeGeohash(48.8566, 2.3522, 5)).toBe("u09tv"); // Paris
    expect(encodeGeohash(-90, -180, 1)).toBe("0");
  });

  it("decodes to a centroid within the cell error bounds", () => {
    const cell = decodeGeohash("u09tv");
    expect(Math.abs(cell.lat - 48.8566)).toBeLessThanOrEqual(cell.latError);
    expect(Math.abs(cell.lon - 2.3522)).toBeLessThanOrEqual(cell.lonError);
  });

  it("round-trips: a decoded centroid re-encodes to the same cell", () => {
    const hash = encodeGeohash(6.5244, 3.3792, 6); // Lagos
    const cell = decodeGeohash(hash);
    expect(encodeGeohash(cell.lat, cell.lon, 6)).toBe(hash);
  });

  it("assigns nearby points at coarse precision to the same cell", () => {
    // Two points ~100 m apart fall in the same precision-6 cell (~1.2 km).
    const a = encodeGeohash(6.5244, 3.3792, 6);
    const b = encodeGeohash(6.5250, 3.3798, 6);
    expect(a).toBe(b);
  });

  it("cellFor returns a stable centroid regardless of where in the cell you are", () => {
    const c1 = cellFor(6.5244, 3.3792, 6);
    const c2 = cellFor(6.5250, 3.3798, 6);
    expect(c1.hash).toBe(c2.hash);
    expect(c1.lat).toBe(c2.lat);
    expect(c1.lon).toBe(c2.lon);
  });

  it("haversine matches a known distance", () => {
    // Lagos to Abuja ~ 525 km.
    const km = haversineKm(6.5244, 3.3792, 9.0765, 7.3986);
    expect(km).toBeGreaterThan(500);
    expect(km).toBeLessThan(560);
  });

  describe("geofence compliance engine (issue #465)", () => {
    const testSanctionZone = {
      id: "zone-1",
      name: "Restricted Airport Hub",
      category: "restricted" as const,
      polygon: [
        { lat: 10.0, lon: 10.0 },
        { lat: 10.0, lon: 20.0 },
        { lat: 20.0, lon: 20.0 },
        { lat: 20.0, lon: 10.0 },
      ],
      isBlacklisted: true,
    };

    it("correctly identifies point inside polygon", () => {
      expect(isPointInPolygon({ lat: 15.0, lon: 15.0 }, testSanctionZone.polygon)).toBe(true);
    });

    it("correctly identifies point outside polygon", () => {
      expect(isPointInPolygon({ lat: 25.0, lon: 25.0 }, testSanctionZone.polygon)).toBe(false);
      expect(isPointInPolygon({ lat: 5.0, lon: 5.0 }, testSanctionZone.polygon)).toBe(false);
    });

    it("blocks transactions inside blacklisted zones", () => {
      const result = evaluateGeofenceCompliance({ lat: 15.0, lon: 15.0 }, [testSanctionZone]);
      expect(result.allowed).toBe(false);
      expect(result.matchedZone?.id).toBe("zone-1");
      expect(result.reason).toContain("Restricted Airport Hub");
    });

    it("allows transactions outside blacklisted zones", () => {
      const result = evaluateGeofenceCompliance({ lat: 5.0, lon: 5.0 }, [testSanctionZone]);
      expect(result.allowed).toBe(true);
      expect(result.matchedZone).toBeUndefined();
    });
  });
});

