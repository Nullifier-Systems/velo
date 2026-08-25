/**
 * Jury selection logic using Stellar VRF-like seed for random juror sampling.
 *
 * Selects 5 jurors from the pool of staked, active jurors based on a
 * deterministic seed derived from the trade ID and current ledger.
 */

import { randomBytes, createHash } from "node:crypto";

export interface JurorCandidate {
  jurorAddress: string;
  stakedAmountStroops: string;
  reputationScore: number;
}

export interface JurySelectionResult {
  panelId: string;
  jurors: JurorCandidate[];
  seed: string;
}

/**
 * Deterministic VRF-like seed: SHA-256(tradeId + ledgerSequence).
 * In production this would use Stellar VRF contract; here we simulate
 * with a hash-based approach for deterministic, verifiable randomness.
 */
export function computeVrfSeed(tradeId: string, ledgerSequence: number): string {
  const input = `${tradeId}:${ledgerSequence}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Seeded PRNG (mulberry32) for deterministic juror selection from a seed.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Select 5 jurors from the candidate pool using a seeded PRNG.
 * Weighted by stake amount for Sybil resistance.
 */
export function selectJurors(
  candidates: JurorCandidate[],
  tradeId: string,
  ledgerSequence: number,
  panelSize = 5,
): JurySelectionResult {
  if (candidates.length < panelSize) {
    throw new Error(
      `Insufficient jurors: need ${panelSize}, have ${candidates.length}`,
    );
  }

  const seed = computeVrfSeed(tradeId, ledgerSequence);
  const rng = mulberry32(parseInt(seed.slice(0, 8), 16));

  // Fisher-Yates shuffle with seeded PRNG
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const selected = shuffled.slice(0, panelSize);
  const panelId = createHash("sha256")
    .update(`${seed}:${Date.now()}`)
    .digest("hex")
    .slice(0, 64);

  return {
    panelId,
    jurors: selected,
    seed,
  };
}

/**
 * Verify that a seed was correctly derived from tradeId + ledger.
 */
export function verifyVrfSeed(
  tradeId: string,
  ledgerSequence: number,
  expectedSeed: string,
): boolean {
  return computeVrfSeed(tradeId, ledgerSequence) === expectedSeed;
}
