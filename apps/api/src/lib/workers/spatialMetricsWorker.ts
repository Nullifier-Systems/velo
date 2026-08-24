import type { Pool } from "pg";
import {
  globalH3SpatialIndex,
  calculateDemandRatio,
  calculateFeeMultiplier,
  type H3CellMetrics,
} from "../h3-spatial-index.js";

export interface RecalculationReport {
  timestamp: string;
  cellsProcessed: number;
  hotspotsDetected: number;
  metrics: H3CellMetrics[];
}

export interface SpatialMetricsStore {
  saveCellMetrics(metrics: H3CellMetrics): Promise<void>;
  getCellMetrics(h3Index: string): Promise<H3CellMetrics | undefined>;
  getHotspotMetrics(minDemandRatio?: number): Promise<H3CellMetrics[]>;
  getAllCellMetrics(): Promise<H3CellMetrics[]>;
}

/**
 * In-memory fallback metrics store for tests and database-free operations.
 */
export function createInMemorySpatialMetricsStore(): SpatialMetricsStore {
  const store = new Map<string, H3CellMetrics>();

  return {
    async saveCellMetrics(metrics: H3CellMetrics): Promise<void> {
      store.set(metrics.h3Index, { ...metrics });
    },
    async getCellMetrics(h3Index: string): Promise<H3CellMetrics | undefined> {
      return store.get(h3Index);
    },
    async getHotspotMetrics(minDemandRatio: number = 2.0): Promise<H3CellMetrics[]> {
      return Array.from(store.values())
        .filter((m) => m.demandRatio > minDemandRatio)
        .sort((a, b) => b.demandRatio - a.demandRatio);
    },
    async getAllCellMetrics(): Promise<H3CellMetrics[]> {
      return Array.from(store.values());
    },
  };
}

/**
 * PostgreSQL-backed metrics store with SELECT FOR UPDATE row locking.
 */
export function createPostgresSpatialMetricsStore(pool: Pool): SpatialMetricsStore {
  return {
    async saveCellMetrics(metrics: H3CellMetrics): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        // SELECT FOR UPDATE concurrency lock (Issue #421 specification)
        await client.query(
          `SELECT h3_index, demand_ratio, fee_multiplier 
           FROM spatial_h3_cell_metrics 
           WHERE h3_index = $1 
           FOR UPDATE;`,
          [metrics.h3Index]
        );

        await client.query(
          `INSERT INTO spatial_h3_cell_metrics (
             h3_index, active_requests_count, available_providers_count, 
             demand_ratio, fee_multiplier, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (h3_index) DO UPDATE SET
             active_requests_count = EXCLUDED.active_requests_count,
             available_providers_count = EXCLUDED.available_providers_count,
             demand_ratio = EXCLUDED.demand_ratio,
             fee_multiplier = EXCLUDED.fee_multiplier,
             updated_at = NOW();`,
          [
            metrics.h3Index,
            metrics.activeRequestsCount,
            metrics.availableProvidersCount,
            metrics.demandRatio,
            metrics.feeMultiplier,
          ]
        );

        await client.query("COMMIT;");
      } catch (err) {
        await client.query("ROLLBACK;");
        throw err;
      } finally {
        client.release();
      }
    },

    async getCellMetrics(h3Index: string): Promise<H3CellMetrics | undefined> {
      const { rows } = await pool.query(
        `SELECT h3_index, active_requests_count, available_providers_count, 
                demand_ratio, fee_multiplier, updated_at
         FROM spatial_h3_cell_metrics 
         WHERE h3_index = $1;`,
        [h3Index]
      );
      if (rows.length === 0) return undefined;
      const r = rows[0];
      return {
        h3Index: r.h3_index,
        activeRequestsCount: Number(r.active_requests_count),
        availableProvidersCount: Number(r.available_providers_count),
        demandRatio: Number(r.demand_ratio),
        feeMultiplier: Number(r.fee_multiplier),
        updatedAt: r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at),
      };
    },

    async getHotspotMetrics(minDemandRatio: number = 2.0): Promise<H3CellMetrics[]> {
      const { rows } = await pool.query(
        `SELECT h3_index, active_requests_count, available_providers_count, 
                demand_ratio, fee_multiplier, updated_at
         FROM spatial_h3_cell_metrics 
         WHERE demand_ratio > $1
         ORDER BY demand_ratio DESC;`,
        [minDemandRatio]
      );
      return rows.map((r: any) => ({
        h3Index: r.h3_index,
        activeRequestsCount: Number(r.active_requests_count),
        availableProvidersCount: Number(r.available_providers_count),
        demandRatio: Number(r.demand_ratio),
        feeMultiplier: Number(r.fee_multiplier),
        updatedAt: r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at),
      }));
    },

    async getAllCellMetrics(): Promise<H3CellMetrics[]> {
      const { rows } = await pool.query(
        `SELECT h3_index, active_requests_count, available_providers_count, 
                demand_ratio, fee_multiplier, updated_at
         FROM spatial_h3_cell_metrics 
         ORDER BY updated_at DESC;`
      );
      return rows.map((r: any) => ({
        h3Index: r.h3_index,
        activeRequestsCount: Number(r.active_requests_count),
        availableProvidersCount: Number(r.available_providers_count),
        demandRatio: Number(r.demand_ratio),
        feeMultiplier: Number(r.fee_multiplier),
        updatedAt: r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at),
      }));
    },
  };
}

/**
 * Standalone calculation function: recalculate demand and fee multipliers across all active H3 cells.
 */
export async function runSpatialMetricsRecalculation(
  store?: SpatialMetricsStore,
  index = globalH3SpatialIndex
): Promise<RecalculationReport> {
  const recalculated = index.recalculateAllCellMetrics();
  let hotspotsDetected = 0;

  for (const metric of recalculated) {
    if (metric.demandRatio > 2.0) {
      hotspotsDetected++;
    }
    if (store) {
      try {
        await store.saveCellMetrics(metric);
      } catch (err) {
        console.error(`[SpatialMetricsWorker] Failed to persist metric for cell ${metric.h3Index}:`, err);
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    cellsProcessed: recalculated.length,
    hotspotsDetected,
    metrics: recalculated,
  };
}

/**
 * H3 Spatial Metrics Recalculator Worker.
 * Runs every 30 seconds to refresh demand density and dynamic fee multipliers.
 */
export class SpatialMetricsWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private intervalMs: number;
  private store: SpatialMetricsStore;

  constructor(options?: { intervalMs?: number; store?: SpatialMetricsStore; dbPool?: Pool }) {
    this.intervalMs = options?.intervalMs ?? 30_000; // default 30s as per Issue #421
    if (options?.store) {
      this.store = options.store;
    } else if (options?.dbPool) {
      this.store = createPostgresSpatialMetricsStore(options.dbPool);
    } else {
      this.store = createInMemorySpatialMetricsStore();
    }
  }

  public setStore(store: SpatialMetricsStore): void {
    this.store = store;
  }

  public getStore(): SpatialMetricsStore {
    return this.store;
  }

  public async tick(): Promise<RecalculationReport> {
    return runSpatialMetricsRecalculation(this.store);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run initial tick immediately
    this.tick().catch((err) => {
      console.error("[SpatialMetricsWorker] Initial tick error:", err);
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[SpatialMetricsWorker] Periodic tick error:", err);
      });
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  public getActiveStatus(): boolean {
    return this.isRunning;
  }
}

export const globalSpatialMetricsWorker = new SpatialMetricsWorker();
