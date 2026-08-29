import type { SpatialProvider } from "./h3-spatial-index.js";

export interface MatchingWeights {
  w1_proximity: number;
  w2_reputation: number;
  w3_feeSlippage: number;
  w4_pendingQueue: number;
  w5_hotspotIncentive?: number;
}

export const DEFAULT_MATCHING_WEIGHTS: MatchingWeights = {
  w1_proximity: 0.35,
  w2_reputation: 0.25,
  w3_feeSlippage: 0.15,
  w4_pendingQueue: 0.1,
  w5_hotspotIncentive: 0.15,
};

export interface ScoredCandidate {
  provider: SpatialProvider;
  score: number;
  distanceKm: number;
  feeMultiplier?: number;
  breakdown: {
    proximityScore: number;
    reputationScore: number;
    feeSlippageScore: number;
    queuePenalty: number;
    hotspotIncentiveScore?: number;
  };
}

/**
 * Multi-Parametric Matching Engine for Cash Requests & Provider Liquidity.
 * 
 * Formula:
 * Score = w1 * Proximity + w2 * ProviderReputation + w3 * FeeSlippage - w4 * PendingQueueDepth + w5 * HotspotIncentive
 */
export class MultiParametricMatchingEngine {
  private weights: MatchingWeights;

  constructor(weights: MatchingWeights = DEFAULT_MATCHING_WEIGHTS) {
    this.weights = weights;
  }

  /**
   * Compute normalized Proximity Score [0.0, 1.0].
   */
  private computeProximityScore(distanceKm: number, maxRadiusKm: number): number {
    if (maxRadiusKm <= 0) return 1.0;
    const norm = distanceKm / maxRadiusKm;
    return Math.max(0.0, Math.min(1.0, 1.0 - norm));
  }

  /**
   * Compute normalized Reputation Score [0.0, 1.0].
   */
  private computeReputationScore(provider: SpatialProvider): number {
    if (typeof provider.reputationScore === "number") {
      return Math.max(0.0, Math.min(1.0, provider.reputationScore / 1000.0));
    }
    // Fallback based on tier
    switch (provider.tier) {
      case "Trusted":
        return 0.9;
      case "Standard":
        return 0.75;
      case "Probationary":
      default:
        return 0.5;
    }
  }

  /**
   * Compute normalized Fee Slippage Score [0.0, 1.0].
   * Rate = 1.0 is standard (0% fee diff). Higher rates penalize slippage.
   */
  private computeFeeSlippageScore(provider: SpatialProvider): number {
    const rateNum = parseFloat(provider.rate ?? "1.0");
    if (isNaN(rateNum)) return 0.5;
    const diff = Math.abs(rateNum - 1.0);
    // Max allowable rate diff tolerance 10% (0.10)
    return Math.max(0.0, Math.min(1.0, 1.0 - diff / 0.10));
  }

  /**
   * Compute normalized Pending Queue Depth Penalty [0.0, 1.0].
   */
  private computePendingQueuePenalty(provider: SpatialProvider): number {
    const depth = provider.pendingQueueDepth ?? 0;
    // Cap penalty at 10 pending requests
    return Math.min(1.0, depth / 10.0);
  }

  /**
   * Compute normalized Hotspot Incentive Score [0.0, 1.0].
   * Multiplier ranges from 1.0 (0.0 score) to 2.0 (1.0 score).
   */
  private computeHotspotIncentiveScore(feeMultiplier?: number): number {
    if (!feeMultiplier || feeMultiplier <= 1.0) return 0.0;
    return Math.max(0.0, Math.min(1.0, (feeMultiplier - 1.0) / 1.0));
  }

  /**
   * Score and rank candidate providers for a given user location and search radius.
   */
  public scoreCandidates(
    candidates: { provider: SpatialProvider; distanceKm: number; feeMultiplier?: number }[],
    maxRadiusKm: number
  ): ScoredCandidate[] {
    const scored: ScoredCandidate[] = [];
    const wHotspot = this.weights.w5_hotspotIncentive ?? 0.15;

    for (const { provider, distanceKm, feeMultiplier } of candidates) {
      const proximityScore = this.computeProximityScore(distanceKm, maxRadiusKm);
      const reputationScore = this.computeReputationScore(provider);
      const feeSlippageScore = this.computeFeeSlippageScore(provider);
      const queuePenalty = this.computePendingQueuePenalty(provider);
      const hotspotIncentiveScore = this.computeHotspotIncentiveScore(feeMultiplier);

      const score =
        this.weights.w1_proximity * proximityScore +
        this.weights.w2_reputation * reputationScore +
        this.weights.w3_feeSlippage * feeSlippageScore -
        this.weights.w4_pendingQueue * queuePenalty +
        wHotspot * hotspotIncentiveScore;

      scored.push({
        provider,
        score,
        distanceKm,
        feeMultiplier,
        breakdown: {
          proximityScore,
          reputationScore,
          feeSlippageScore,
          queuePenalty,
          hotspotIncentiveScore,
        },
      });
    }

    // Sort descending by multi-parametric score
    return scored.sort((a, b) => b.score - a.score);
  }
}

export const globalMatchingEngine = new MultiParametricMatchingEngine();

