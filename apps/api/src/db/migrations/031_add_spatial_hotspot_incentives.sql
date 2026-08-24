-- 031_add_spatial_hotspot_incentives.sql
-- Dynamic Geo-Spatial Liquidity Provider Rebalancing & Hotspot Incentive Engine (Issue #421)

CREATE TABLE IF NOT EXISTS spatial_h3_cell_metrics (
  h3_index VARCHAR(15) PRIMARY KEY,
  active_requests_count INT NOT NULL DEFAULT 0,
  available_providers_count INT NOT NULL DEFAULT 0,
  demand_ratio NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  fee_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_h3_demand ON spatial_h3_cell_metrics(demand_ratio DESC);
