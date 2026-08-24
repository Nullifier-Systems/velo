import { describe, expect, it } from "vitest";
import { YIELD_VAULT } from "@velo/shared";
import {
  clampBufferRatio,
  optimizeBuffer,
  targetLiquidFor,
} from "../buffer-optimizer.js";

/**
 * Unit coverage for the dynamic liquidity-buffer optimizer (#408).
 *
 * Note on shortfall: the optimizer derives recall capacity as
 * TVL − liquid, and targets are always ≤ TVL (ratios clamp to ≤ 1), so a
 * shortfall is unreachable by construction — the branch in code is purely
 * defensive against future input shapes.
 */
describe("buffer optimizer (#408)", () => {
  const base = {
    vaultId: "vault-1",
    currentTvlStroops: 1_000_000n,
    currentLiquidStroops: 900_000n,
    configuredRatio: 0.2,
  };

  it("deploys idle cash beyond the hysteresis band", () => {
    // target = ceil(1M × 20%) = 200k; band top = ceil(1M × 22.5%) = 225k.
    const decision = optimizeBuffer({ ...base, minDeployStroops: 1n });
    expect(decision.action).toBe("DEPLOY_TO_VAULT");
    expect(decision.targetLiquidStroops).toBe("200000");
    expect(decision.amountStroops).toBe("675000"); // 900k − 225k
    expect(decision.shortfallStroops).toBe("0");
  });

  it("holds inside the hysteresis band to avoid churn", () => {
    const decision = optimizeBuffer({
      ...base,
      currentLiquidStroops: 210_000n,
      minDeployStroops: 1n,
    });
    expect(decision.action).toBe("HOLD");
    expect(decision.amountStroops).toBe("0");
  });

  it("respects the minimum-deploy floor", () => {
    const decision = optimizeBuffer({
      ...base,
      minDeployStroops: 800_001n, // excess is only 675k
    });
    expect(decision.action).toBe("HOLD");
  });

  it("blocks tiny vaults under the shared default floor", () => {
    const decision = optimizeBuffer(base); // default floor: 1_000_000 stroops
    expect(decision.action).toBe("HOLD");
    expect(BigInt(YIELD_VAULT.MIN_DEPLOY_STROOPS)).toBe(1_000_000n);
  });

  it("recalls when trailing settlement demand outgrows the buffer", () => {
    const decision = optimizeBuffer({
      ...base,
      currentLiquidStroops: 150_000n,
      recentSettlementDemandStroops: 400_000n,
      minDeployStroops: 1n,
    });
    // Demand×1.5 = 600k → 60% coverage ratio beats the 20% config.
    expect(decision.recommendedRatio).toBe(0.6);
    expect(decision.targetLiquidStroops).toBe("600000");
    expect(decision.action).toBe("RECALL_FROM_VAULT");
    expect(decision.amountStroops).toBe("450000"); // 600k target − 150k liquid
    expect(decision.shortfallStroops).toBe("0");
  });

  it("caps the recommended ratio at 100% of TVL", () => {
    const decision = optimizeBuffer({
      ...base,
      currentLiquidStroops: 0n,
      recentSettlementDemandStroops: 10_000_000n,
      minDeployStroops: 1n,
    });
    expect(decision.recommendedRatio).toBe(1);
    expect(decision.targetLiquidStroops).toBe("1000000");
    expect(decision.action).toBe("RECALL_FROM_VAULT");
    expect(decision.amountStroops).toBe("1000000");
  });

  it("rounds the liquid target UP so the buffer is never under-funded", () => {
    expect(targetLiquidFor(10_000_001n, 0.2)).toBe(2_000_001n);
    expect(targetLiquidFor(10_000_000n, 0.2)).toBe(2_000_000n);
    expect(targetLiquidFor(0n, 0.9)).toBe(0n);
  });

  it("clamps ratios into the shared bounds", () => {
    expect(clampBufferRatio(0.01)).toBe(YIELD_VAULT.MIN_LIQUID_BUFFER_RATIO);
    expect(clampBufferRatio(5)).toBe(YIELD_VAULT.MAX_LIQUID_BUFFER_RATIO);
    expect(clampBufferRatio(Number.NaN)).toBe(
      YIELD_VAULT.DEFAULT_LIQUID_BUFFER_RATIO,
    );
    expect(clampBufferRatio(0.42)).toBe(0.42);
  });

  it("ignores negative or inconsistent reserve inputs defensively", () => {
    const decision = optimizeBuffer({
      ...base,
      currentLiquidStroops: -5n,
      minDeployStroops: 1n,
    });
    // Negative liquid clamps to zero → full recall up to the target.
    expect(decision.action).toBe("RECALL_FROM_VAULT");
    expect(decision.amountStroops).toBe("200000");
  });
});
