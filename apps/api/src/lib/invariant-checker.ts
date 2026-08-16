import type { CircuitBreakerAction, InvariantCheckStatus } from "@velo/shared";

/**
 * Formal reserve-conservation invariant checker (#374).
 *
 * Mirrors `contracts/invariant-verifier/src/checker.rs` INV-01/INV-07 at the
 * API layer: on every closed ledger the real-time indexer reconstructs the
 * escrow contract's *expected* balance from its own indexed state and
 * reconciles it against the *actual* on-chain contract balance:
 *
 *   expected_total = sum(trade_balances) + fee_accumulator
 *   drift         = |expected_total - actual_onchain_balance|
 *
 * A non-zero drift past tolerance is a formal violation of conservation of
 * value — the automated circuit breaker must halt the compromised escrow.
 */

/** Running totals mirrored from `system_invariant_state`. */
export interface InvariantBalanceSnapshot {
  /** Sum of amounts held by trades in a non-terminal state (locked/disputed). */
  totalLockedStroops: bigint;
  /** Sum of amounts allocated to tranches but not yet released. */
  totalAllocatedStroops: bigint;
  /** Accumulated platform fees not yet swept to the admin. */
  feeAccumulatorStroops: bigint;
  /** Actual on-chain token balance of the escrow contract. */
  actualContractBalanceStroops: bigint;
  /** Ledger the snapshot was taken at. */
  ledger: number;
}

export interface InvariantCheckResult {
  status: InvariantCheckStatus;
  violatedInvariant?: string;
  /** expected_total = sum(trade_balances) + fee_accumulator. */
  expectedTotalStroops: bigint;
  actualTotalStroops: bigint;
  /** |expected - actual|; 0 when the invariant holds exactly. */
  driftStroops: bigint;
  /** Recommended circuit-breaker action for this verdict. */
  action: CircuitBreakerAction;
  evidence: Record<string, string | number>;
}

export interface InvariantCheckerOptions {
  /**
   * Tolerance above which the invariant is flagged VIOLATED. Defaults to 0 —
   * any drift is a violation. Fee sweeps and oracle read races can produce
   * sub-stroop dust, so production deployments may set a small epsilon.
   */
  toleranceStroops?: bigint;
  /**
   * Drift below `toleranceStroops` but above this value is a WARNING instead
   * of HEALTHY. Defaults to 0 (only exact matches are HEALTHY).
   */
  warningThresholdStroops?: bigint;
}

export const INVARIANT_RESERVE_CONSERVATION = "INV-07_RESERVE_CONSERVATION";

/**
 * Evaluate the reserve-conservation invariant against a balance snapshot.
 * Pure function — no I/O — so it is trivially unit-testable and reusable
 * by both the real-time worker and offline audit tooling.
 */
export function evaluateReserveConservation(
  snapshot: InvariantBalanceSnapshot,
  options: InvariantCheckerOptions = {},
): InvariantCheckResult {
  const toleranceStroops = options.toleranceStroops ?? 0n;
  const warningThresholdStroops = options.warningThresholdStroops ?? 0n;

  const expectedTotalStroops =
    snapshot.totalLockedStroops +
    snapshot.totalAllocatedStroops +
    snapshot.feeAccumulatorStroops;

  const actualTotalStroops = snapshot.actualContractBalanceStroops;
  const driftStroops =
    expectedTotalStroops > actualTotalStroops
      ? expectedTotalStroops - actualTotalStroops
      : actualTotalStroops - expectedTotalStroops;

  const evidence = {
    expected_total: expectedTotalStroops.toString(),
    actual_balance: actualTotalStroops.toString(),
    drift: driftStroops.toString(),
    ledger: snapshot.ledger,
    total_locked: snapshot.totalLockedStroops.toString(),
    total_allocated: snapshot.totalAllocatedStroops.toString(),
    fee_accumulator: snapshot.feeAccumulatorStroops.toString(),
  };

  if (driftStroops > toleranceStroops) {
    return {
      status: "VIOLATED",
      violatedInvariant: INVARIANT_RESERVE_CONSERVATION,
      expectedTotalStroops,
      actualTotalStroops,
      driftStroops,
      action: "PAUSE_SINGLE_ESCROW",
      evidence,
    };
  }

  if (driftStroops > warningThresholdStroops) {
    return {
      status: "WARNING",
      expectedTotalStroops,
      actualTotalStroops,
      driftStroops,
      action: "NO_ACTION",
      evidence,
    };
  }

  return {
    status: "HEALTHY",
    expectedTotalStroops,
    actualTotalStroops,
    driftStroops,
    action: "NO_ACTION",
    evidence,
  };
}
