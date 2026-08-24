/**
 * Automated Liquidity Reserve Rebalancing & Cross-Asset Yield
 * Aggregation Vault types (#408).
 *
 * Single source of truth for the API route layer
 * (apps/api/src/routes/yield-vaults.ts), the rebalance worker
 * (apps/api/src/lib/workers/yieldRebalanceWorker.ts) and the provider
 * portal UI (mobile/frontend/src/pages/ProviderYieldPortal.tsx).
 */

/** A configured yield vault for one settlement asset. Mirrors `yield_vault_configs`. */
export interface YieldVaultConfig {
  vaultId: string;
  /** Stellar asset contract address (C…) of the vaulted asset. */
  assetAddress: string;
  /** Fraction (0..1) of TVL kept instantly withdrawable, e.g. 0.20. */
  liquidBufferRatio: number;
  /** Total value locked including funds deployed into strategies (stroops). */
  currentTvlStroops: string;
}

/** Per-provider share position. Mirrors `provider_vault_shares`. */
export interface ProviderVaultShare {
  providerId: string;
  vaultId: string;
  shareBalance: string;
}

/** One APY observation used to draw the portal chart. */
export interface ApySample {
  timestamp: string;
  apyBps: number;
}

/** Result of POST /api/v1/yield/harvest. */
export interface HarvestResult {
  vaultId: string;
  assetAddress: string;
  yieldStroops: string;
  tvlAfterStroops: string;
  /** Scaled exchange rate after harvest: assets * SCALE / shares. */
  exchangeRateScaled: string;
  previousExchangeRateScaled: string;
  harvestedAt: string;
}

/** Where a strategy adapter currently holds funds for one asset. */
export interface StrategyPosition {
  assetAddress: string;
  strategyName: string;
  deployedStroops: string;
  /** Strategy-reported APY in basis points (400 = 4%). */
  apyBps: number;
}

/** Output of one buffer-optimizer pass for a vault. */
export interface BufferDecision {
  vaultId: string;
  recommendedRatio: number;
  targetLiquidStroops: string;
  action: "DEPLOY_TO_VAULT" | "RECALL_FROM_VAULT" | "HOLD";
  amountStroops: string;
  shortfallStroops: string;
  reason: string;
}

/** Plan for funding an instant cash-trade settlement (#408 acceptance #2). */
export interface LiquidityDrawPlan {
  requiredStroops: string;
  liquidReserveStroops: string;
  recallFromVaultStroops: string;
  shortfallStroops: string;
  source: "BUFFER_ONLY" | "BUFFER_PLUS_VAULT_RECALL" | "INSUFFICIENT";
}

/**
 * Shared constants for the yield aggregation stack so the migration SQL,
 * contract (`RATE_SCALE` in contracts/escrow/src/yield_vault.rs), API,
 * worker, and frontend can never drift apart.
 */
export const YIELD_VAULT = {
  /** Dynamic liquid reserve target from the issue spec (20% of TVL). */
  DEFAULT_LIQUID_BUFFER_RATIO: 0.2,
  MIN_LIQUID_BUFFER_RATIO: 0.05,
  MAX_LIQUID_BUFFER_RATIO: 1,
  /**
   * Idle cash is only deployed once it exceeds buffer*(1+hysteresis) so the
   * rebalance worker does not churn the vault on every tick.
   */
  BUFFER_HYSTERESIS_BPS: 250,
  /**
   * Fixed-point scale for share exchange rates — MUST match `RATE_SCALE`
   * in contracts/escrow/src/yield_vault.rs.
   */
  EXCHANGE_RATE_SCALE: 1_000_000_000_000n,
  /** Below this the deploy leg costs more gas than it earns. */
  MIN_DEPLOY_STROOPS: 1_000_000n,
  /** Worker cadence: drives compounding + buffer optimization. */
  REBALANCE_POLL_MS: 5 * 60 * 1000,
  /** Expected external strategy APY band from the issue (4–8%). */
  MIN_APY_BPS: 400,
  MAX_APY_BPS: 800,
} as const;
