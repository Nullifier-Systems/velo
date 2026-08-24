/**
 * Dynamic liquidity-buffer optimizer (#408).
 *
 * The escrow keeps a fraction of every vault's TVL instantly withdrawable
 * (20% by default) so cash-trade settlements never wait on a strategy
 * unwind; everything above that buffer is deployed into external Soroban
 * yield strategies earning 4–8% APY. This module sizes the deploy / recall
 * legs for one rebalance tick. It is pure bigint math — no IO — so the unit
 * tests and the concurrency stress suite can hammer it directly, mirroring
 * the on-chain entry points in contracts/escrow/src/yield_vault.rs
 * (`deploy_idle_to_vault` / `recall_from_vault`).
 *
 * Policy summary (all ratios handled internally in basis points to avoid
 * float drift):
 *   1. recommendedRatio = max(configuredRatio, demandCoverage) where
 *      demandCoverage covers trailing settlement demand × safety multiplier.
 *   2. targetLiquid = ceil(TVL × recommendedRatio).
 *   3. Liquid below target        → RECALL exactly the gap (≤ deployed).
 *   4. Liquid above target×(1+hy) → DEPLOY the excess when ≥ minDeploy.
 *   5. Otherwise                  → HOLD (hysteresis prevents churn).
 */

import { YIELD_VAULT, type BufferDecision } from "@velo/shared";

const BPS_DENOMINATOR = 10_000n;

export interface BufferOptimizerInput {
  vaultId: string;
  /** Total value locked including deployed-to-strategy funds (stroops). */
  currentTvlStroops: bigint;
  /** Unallocated balance held directly by the escrow (stroops). */
  currentLiquidStroops: bigint;
  /** Configured buffer fraction (e.g. 0.2); clamped to the shared bounds. */
  configuredRatio: number;
  /** Settlement demand observed over the trailing window (stroops). */
  recentSettlementDemandStroops?: bigint;
  /** Safety factor over trailing demand (default 1.5×). */
  demandMultiplier?: number;
  /** Deploy only past buffer×(1+hysteresis) — default YIELD_VAULT value. */
  hysteresisBps?: number;
  /** Floor under which deploying costs more than it earns. */
  minDeployStroops?: bigint;
}

export function clampBufferRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return YIELD_VAULT.DEFAULT_LIQUID_BUFFER_RATIO;
  }
  return Math.min(
    YIELD_VAULT.MAX_LIQUID_BUFFER_RATIO,
    Math.max(YIELD_VAULT.MIN_LIQUID_BUFFER_RATIO, ratio),
  );
}

function ratioToBps(ratio: number): bigint {
  return BigInt(Math.round(clampBufferRatio(ratio) * 10_000));
}

function ceilDiv(numer: bigint, denom: bigint): bigint {
  if (denom <= 0n) throw new RangeError("denominator must be positive");
  return (numer + denom - 1n) / denom;
}

/** Liquid target implied by a ratio, rounded UP (never under-buffered). */
export function targetLiquidFor(tvlStroops: bigint, ratio: number): bigint {
  if (tvlStroops <= 0n) return 0n;
  return ceilDiv(tvlStroops * ratioToBps(ratio), BPS_DENOMINATOR);
}

export function optimizeBuffer(input: BufferOptimizerInput): BufferDecision {
  const tvl =
    input.currentTvlStroops > 0n ? input.currentTvlStroops : 0n;
  const liquid =
    input.currentLiquidStroops < 0n
      ? 0n
      : input.currentLiquidStroops > tvl
        ? tvl
        : input.currentLiquidStroops;

  const hysteresisBps =
    input.hysteresisBps ?? YIELD_VAULT.BUFFER_HYSTERESIS_BPS;
  const minDeploy = input.minDeployStroops ?? YIELD_VAULT.MIN_DEPLOY_STROOPS;

  // 1. Recommended ratio: configured floor vs. demand coverage.
  let recommendedBps = ratioToBps(input.configuredRatio);
  const demand = input.recentSettlementDemandStroops ?? 0n;
  if (tvl > 0n && demand > 0n) {
    const multiplier = Math.max(1, input.demandMultiplier ?? 1.5);
    // bigint-safe ×1.5 style scaling: multiply by 1500‰ then divide.
    const scaledDemand = (demand * BigInt(Math.round(multiplier * 1_000))) / 1_000n;
    const coverageBps = ceilDiv(scaledDemand * BPS_DENOMINATOR, tvl);
    const capped = coverageBps > BPS_DENOMINATOR ? BPS_DENOMINATOR : coverageBps;
    if (capped > recommendedBps) recommendedBps = capped;
  }

  // 2. Targets.
  const targetLiquid = ceilDiv(tvl * recommendedBps, BPS_DENOMINATOR);
  const hysteresisTarget = ceilDiv(
    tvl * (recommendedBps + BigInt(hysteresisBps)),
    BPS_DENOMINATOR,
  );
  const deployedCapacity = tvl - liquid;

  // 3./4./5. Decide.
  if (liquid < targetLiquid) {
    const gap = targetLiquid - liquid;
    const recall = deployedCapacity < gap ? deployedCapacity : gap;
    const shortfall = gap - recall;
    if (recall === 0n) {
      return decision("HOLD", 0n, shortfall);
    }
    return decision(shortfall > 0n ? "HOLD" : "RECALL_FROM_VAULT", recall, shortfall);
  }

  if (liquid > hysteresisTarget) {
    const excess = liquid - hysteresisTarget;
    if (excess < minDeploy) {
      return decision("HOLD", 0n, 0n);
    }
    return decision("DEPLOY_TO_VAULT", excess, 0n);
  }

  return decision("HOLD", 0n, 0n);

  function decision(
    action: BufferDecision["action"],
    amount: bigint,
    shortfall: bigint,
  ): BufferDecision {
    const reason =
      action === "RECALL_FROM_VAULT"
        ? "liquid buffer below target — recalling to restore instant-settlement capacity"
        : action === "DEPLOY_TO_VAULT"
          ? "idle cash exceeds hysteresis band — deploying surplus to yield strategy"
          : shortfall > 0n
            ? "buffer short but nothing left deployed to recall — shortfall reported"
            : "within hysteresis band — no rebalance needed";
    return {
      vaultId: input.vaultId,
      recommendedRatio: Number(recommendedBps) / 10_000,
      targetLiquidStroops: targetLiquid.toString(),
      action,
      amountStroops: amount.toString(),
      shortfallStroops: shortfall.toString(),
      reason,
    };
  }
}