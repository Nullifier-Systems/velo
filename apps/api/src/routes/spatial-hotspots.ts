import type { FastifyInstance } from "fastify";
import { cellToBoundary, cellToLatLng } from "h3-js";
import { z } from "zod";
import { globalH3SpatialIndex } from "../lib/h3-spatial-index.js";
import { globalSpatialMetricsWorker } from "../lib/workers/spatialMetricsWorker.js";

/**
 * Determine hex color representation for hotspot visualizations.
 * Green: <= 1.2x, Orange: 1.2x - 1.6x, Red: > 1.6x
 */
export function getHotspotColor(feeMultiplier: number): "green" | "orange" | "red" {
  if (feeMultiplier > 1.6) return "red";
  if (feeMultiplier > 1.2) return "orange";
  return "green";
}

/**
 * Convert H3 cell index into GeoJSON Polygon coordinates [ [lng, lat], ... ].
 */
export function h3CellToGeoJsonPolygon(h3Index: string): number[][][] {
  try {
    const boundary = cellToBoundary(h3Index); // Array of [lat, lng]
    if (!boundary || boundary.length === 0) return [];

    // GeoJSON coordinates standard: [lng, lat]
    const coords: number[][] = boundary.map(([lat, lng]) => [lng, lat]);

    // Ensure polygon ring is closed (first point == last point)
    if (coords.length > 0) {
      coords.push([...coords[0]]);
    }

    return [coords];
  } catch (err) {
    return [];
  }
}

/**
 * Spatial Hotspots and Dynamic Geo-Spatial Liquidity Provider Rebalancing Routes (Issue #421)
 */
export async function spatialHotspotsRoutes(app: FastifyInstance) {
  // GET /spatial/hotspots — Returns GeoJSON spatial hotspot overlay layer for mobile clients
  app.get("/spatial/hotspots", async (req, reply) => {
    const querySchema = z.object({
      min_demand_ratio: z.coerce.number().min(0).optional().default(2.0),
      all: z.coerce.boolean().optional().default(false),
    });

    const parsed = querySchema.safeParse(req.query ?? {});
    const minDemandRatio = parsed.success ? parsed.data.min_demand_ratio : 2.0;
    const returnAll = parsed.success ? parsed.data.all : false;

    // First check PG database if available, otherwise read from in-memory globalH3SpatialIndex
    let cellMetrics = [];

    if ((app as any).pg) {
      try {
        const store = globalSpatialMetricsWorker.getStore();
        cellMetrics = returnAll
          ? await store.getAllCellMetrics()
          : await store.getHotspotMetrics(minDemandRatio);
      } catch (err) {
        req.log.warn(err, "Failed to query spatial_h3_cell_metrics from DB, falling back to memory");
        cellMetrics = returnAll
          ? globalH3SpatialIndex.getAllCellMetrics()
          : globalH3SpatialIndex.getHotspotCells(minDemandRatio);
      }
    } else {
      cellMetrics = returnAll
        ? globalH3SpatialIndex.getAllCellMetrics()
        : globalH3SpatialIndex.getHotspotCells(minDemandRatio);
    }

    // Build GeoJSON FeatureCollection
    const features = [];
    let maxMultiplier = 1.0;

    for (const metric of cellMetrics) {
      if (metric.feeMultiplier > maxMultiplier) {
        maxMultiplier = metric.feeMultiplier;
      }

      const polygon = h3CellToGeoJsonPolygon(metric.h3Index);
      let centerLat = 0;
      let centerLng = 0;

      try {
        const center = cellToLatLng(metric.h3Index);
        centerLat = center[0];
        centerLng = center[1];
      } catch {
        // ignore fallback center
      }

      features.push({
        type: "Feature",
        id: metric.h3Index,
        geometry: {
          type: "Polygon",
          coordinates: polygon,
        },
        properties: {
          h3Index: metric.h3Index,
          activeRequestsCount: metric.activeRequestsCount,
          availableProvidersCount: metric.availableProvidersCount,
          demandRatio: metric.demandRatio,
          feeMultiplier: metric.feeMultiplier,
          boostPercentage: Math.round((metric.feeMultiplier - 1.0) * 100),
          color: getHotspotColor(metric.feeMultiplier),
          center: { lat: centerLat, lng: centerLng },
          updatedAt: metric.updatedAt,
        },
      });
    }

    return reply.code(200).send({
      type: "FeatureCollection",
      features,
      metadata: {
        totalHotspots: features.length,
        maxMultiplier,
        minDemandRatioThreshold: minDemandRatio,
        generatedAt: new Date().toISOString(),
      },
    });
  });

  // GET /spatial/cell-metrics/:h3Index — Get metrics for a specific H3 cell
  app.get("/spatial/cell-metrics/:h3Index", async (req, reply) => {
    const params = req.params as { h3Index: string };
    const { h3Index } = params;

    let metric = globalH3SpatialIndex.getCellMetrics(h3Index);
    if (!metric && (app as any).pg) {
      try {
        const store = globalSpatialMetricsWorker.getStore();
        metric = await store.getCellMetrics(h3Index);
      } catch (err) {
        req.log.warn(err, "Failed to query cell metric from DB");
      }
    }

    if (!metric) {
      // Recalculate on demand
      metric = globalH3SpatialIndex.recalculateCellMetrics(h3Index);
    }

    return reply.code(200).send({
      metric,
      color: getHotspotColor(metric.feeMultiplier),
      polygon: h3CellToGeoJsonPolygon(h3Index),
    });
  });

  // POST /spatial/hotspots/recalculate — Manually trigger recalculation
  app.post("/spatial/hotspots/recalculate", async (req, reply) => {
    const report = await globalSpatialMetricsWorker.tick();
    return reply.code(200).send({
      success: true,
      report,
    });
  });
}
