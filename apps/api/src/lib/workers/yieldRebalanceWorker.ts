/**
 * Yield Rebalance Worker (#408).
 *
 * Drives the two loops the issue specifies, once per poll interval:
 *   1. Compounding — accrued strategy APY is folded into each vault's TVL.
 *      Share BALANCES never change here; the exchange-rate ratchet does the
 *      work (the #408 invariant: rates never decrease during harvesting).
 *   2. Buffer optimization — sizes and executes deploy / recall legs around
 *      the dynamic 20% liquid reserve via lib/yield/buffer-optimizer.ts, so
 *      instant cash-trade settlements always have buffer capacity while idle
 *      collateral earns 4–8% APY.
 *
 * Shape follows payout-batcher.ts: a pure `runRebalanceTick(deps)` the tests
 * can drive deterministically, plus `startYieldRebalanceWorker(deps)` which
 * owns the interval and returns a stop handle.
 */

import { YIELD_VAULT, type BufferDecision } from "@velo/shared";
import { optimizeBuffer } from "../yield/buffer-optimizer.js";
import {
  assertExchangeRateNeverDecreases,
  type YieldStrategyAdapter,
} from "../yield/strategy-adapter.js";
import {
  listYieldVaultConfigs,
  saveYieldVaultConfig,
  totalSharesForVault,
  type YieldVaultConfigRecord,
} from "../store.js";

const YEAR_MS = 365n * 24n * 60n * 60n * 1000n;

export interface YieldRebalanceDeps {
  adapter: YieldStrategyAdapter;
  /** Trailing-window settlement demand per vault id, stroops (optional). */
  recentDemand?(vaultId: string): bigint | undefined;
  logger?: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  };
}

export interface RebalanceTickResult {
  vaultId: string;
  decision: BufferDecision;
  appliedAmountStroops: string;
  harvestedYieldStroops: string;
  exchangeRateScaled: string;
}

function scaledRate(tvlStroops: bigint, totalShares: bigint): bigint {
  if (totalShares <= 0n) return YIELD_VAULT.EXCHANGE_RATE_SCALE;
  return (tvlStroops * YIELD_VAULT.EXCHANGE_RATE_SCALE) / totalShares;
}

async function applyDecision(
  deps: YieldRebalanceDeps,
  config: YieldVaultConfigRecord,
  decision: BufferDecision,
): Promise<string> {
  const amount = BigInt(decision.amountStroops);
  if (amount <= 0n || decision.action === "HOLD") return "0";

  const asset = { assetAddress: config.assetAddress, amountStroops: amount };

  if (decision.action === "DEPLOY_TO_VAULT") {
    const receipt = await deps.adapter.deposit(asset);
    if (!receipt.ok) {
      deps.logger?.warn(
        { vaultId: config.vaultId, detail: receipt.detail },
        "deploy leg rejected by strategy",
      );
      return "0";
    }
    // Liquid leaves the escrow into the strategy; TVL composition shifts.
    config.liquidStroops = (
      BigInt(config.liquidStroops) - amount
    ).toString();
    return amount.toString();
  }

  // RECALL_FROM_VAULT — instant top-up of the settlement buffer.
  const receipt = await deps.adapter.withdraw(asset);
  if (!receipt.ok) {
    deps.logger?.warn(
      { vaultId: config.vaultId, detail: receipt.detail },
      "recall leg rejected by strategy",
    );
    return "0";
  }
  config.liquidStroops = (BigInt(config.liquidStroops) + amount).toString();
  return amount.toString();
}
/**
 * One full pass over every configured vault: quote → optimize → execute →
 * compound. Mutates the shared in-memory vault configs (a pg-backed store
 * plugs in at this same boundary once DATABASE_URL is provisioned).
 */
export async function runRebalanceTick(
  deps: YieldRebalanceDeps,
  opts: { pollIntervalMs?: number; vaultId?: string } = {},
): Promise<RebalanceTickResult[]> {
  const pollMs = opts.pollIntervalMs ?? YIELD_VAULT.REBALANCE_POLL_MS;
  const results: RebalanceTickResult[] = [];

  for (const config of listYieldVaultConfigs()) {
    if (opts.vaultId && config.vaultId !== opts.vaultId) continue;

    try {
      const position = await deps.adapter.position(config.assetAddress);
      const deployed = BigInt(position.deployedStroops);
      const liquid = BigInt(config.liquidStroops);
      const tvlBefore = liquid + deployed;

      const decision = optimizeBuffer({
        vaultId: config.vaultId,
        currentTvlStroops: tvlBefore,
        currentLiquidStroops: liquid,
        configuredRatio: config.liquidBufferRatio,
        recentSettlementDemandStroops: deps.recentDemand?.(config.vaultId),
      });

      const applied = await applyDecision(deps, config, decision);

      // Compound this tick's slice of the annual APY onto whatever remains
      // deployed. Pure bigint math — sub-stroop dust truncates away.
      const deployedAfter =
        deployed +
        (decision.action === "DEPLOY_TO_VAULT" ? BigInt(applied) : 0n) -
        (decision.action === "RECALL_FROM_VAULT" ? BigInt(applied) : 0n);
      const harvested =
        (deployedAfter * BigInt(position.apyBps) * BigInt(pollMs)) /
        (10_000n * YEAR_MS);

      const tvlAfter =
        BigInt(config.liquidStroops) + deployedAfter + harvested;
      const previousRate = BigInt(
        config.lastExchangeRateScaled ||
          YIELD_VAULT.EXCHANGE_RATE_SCALE.toString(),
      );
      const nextRate = scaledRate(
        tvlAfter,
        totalSharesForVault(config.vaultId),
      );

      // Fail LOUDLY rather than persist a regression (#408 invariant).
      assertExchangeRateNeverDecreases(
        previousRate,
        nextRate,
        `rebalance:${config.vaultId}`,
      );

      saveYieldVaultConfig({
        ...config,
        currentTvlStroops: tvlAfter.toString(),
        lastExchangeRateScaled: nextRate.toString(),
      });

      results.push({
        vaultId: config.vaultId,
        decision,
        appliedAmountStroops: applied,
        harvestedYieldStroops: harvested.toString(),
        exchangeRateScaled: nextRate.toString(),
      });
    } catch (error) {
      deps.logger?.error(
        { err: error, vaultId: config.vaultId },
        "rebalance tick failed for vault",
      );
    }
  }

  return results;
}
/**
 * Interval owner. Returns a stop handle; the timer is unref'd so a stray
 * worker never keeps a short-lived process alive.
 */
export function startYieldRebalanceWorker(
  deps: YieldRebalanceDeps,
  opts: { pollIntervalMs?: number } = {},
): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? YIELD_VAULT.REBALANCE_POLL_MS;
  let running = true;

  const tick = (): void => {
    if (!running) return;
    void runRebalanceTick(deps, { pollIntervalMs }).catch((error) =>
      deps.logger?.error({ err: error }, "yield rebalance tick crashed"),
    );
  };

  tick();
  const timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();

  return () => {
    running = false;
    clearInterval(timer);
  };
}

