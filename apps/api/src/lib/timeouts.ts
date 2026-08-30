/**
 * Centralized timeout & expiry constants.
 *
 * CRITICAL: Every timeout decision in the system must use constants from this file.
 * Do NOT define timeout constants locally — import from here instead.
 * See docs/TIMEOUT_POLICY.md for the complete policy and rationale.
 */

/**
 * Lock duration (in ledgers) for cash escrow trades.
 *
 * ~100 ledgers at ~9 seconds/ledger = ~15 minutes.
 * Short window for immediate P2P hand-off; buyer can refund after this.
 *
 * Must be < ESCROW_MAX_TIMEOUT_LEDGERS_POLICY.
 */
export const CASH_DEFAULT_TIMEOUT_LEDGERS = 100;

/**
 * Maximum lock duration (in ledgers) enforced by the escrow contract.
 *
 * ~604,800 ledgers = ~7 days.
 * Hard cap; prevents indefinite locks and matches contract policy.
 *
 * Contract code: `const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7;`
 * This MUST match that value exactly.
 *
 * See: contracts/escrow/src/lib.rs line 78
 */
export const ESCROW_MAX_TIMEOUT_LEDGERS_POLICY = 6 * 60 * 24 * 7; // 60,480

/**
 * Dispute resolution window (in ledgers) enforced by the escrow contract.
 *
 * ~259,200 ledgers = ~3 days.
 * Arbitrator has this long to resolve a dispute; after this, funds return to buyer.
 *
 * Contract code: `const DISPUTE_RESOLUTION_WINDOW_LEDGERS: u32 = 12 * 60 * 24 * 3;`
 * This MUST match that value exactly.
 *
 * Invariant: DISPUTE_RESOLUTION_WINDOW_LEDGERS < ESCROW_MAX_TIMEOUT_LEDGERS_POLICY
 * (3 days < 7 days) ✓ verified in tests
 *
 * See: contracts/escrow/src/lib.rs line 90
 */
export const DISPUTE_RESOLUTION_WINDOW_LEDGERS = 12 * 60 * 24 * 3; // 51,840

/**
 * Settlement chain default lock duration (in ledgers).
 *
 * ~8,640 ledgers = ~24 hours.
 * Multi-hop orchestrated settlement needs longer coordination window than P2P.
 *
 * Must be < ESCROW_MAX_TIMEOUT_LEDGERS_POLICY.
 * Use case: cross-chain atomic swaps and complex settlement chains.
 *
 * See: contracts/settlement-chain/src/lib.rs line 59
 */
export const SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS = 24 * 60 * 6; // 8,640

/**
 * Chat message retention window (milliseconds, post-terminal).
 *
 * 30 days after trade reaches terminal state (Released/Refunded/Resolved).
 * Aligned with GDPR right-to-be-forgotten grace period.
 * Can be overridden via CHAT_RETENTION_MS env var.
 */
export const DEFAULT_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Dispute evidence retention window (milliseconds, post-terminal).
 *
 * 90 days after trade reaches terminal state.
 * Longer than chat (30d) because evidence is a legal/compliance artifact.
 * Can be overridden via DISPUTE_EVIDENCE_RETENTION_MS env var.
 */
export const DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Data retention purge worker poll interval (milliseconds).
 *
 * Scans expired trades and deletes chat/evidence at this frequency.
 * Can be overridden via DATA_RETENTION_POLL_INTERVAL_MS env var.
 */
export const DEFAULT_DATA_RETENTION_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-operation RPC timeout budgets (milliseconds).
 *
 * These are NOT trade timeouts — they're network resilience budgets for
 * Stellar RPC calls. If a build+simulate or poll exceeds this, the operation
 * is retried or fails gracefully.
 *
 * See: apps/api/src/lib/stellar.ts RPC_TIMEOUTS export
 */
export const RPC_BUILD_SIM_TIMEOUT_MS = {
  lock: 15_000, // 15s: high complexity, high value
  release: 10_000, // 10s: medium complexity
  refund: 10_000, // 10s: medium complexity
  batchRelease: 10_000, // 10s: same as single release
  generic: 15_000, // 15s: safety margin
} as const;

export const RPC_POLL_TIMEOUT_MS = {
  lock: 45_000, // 45s: give multiple ledgers for confirmation
  release: 30_000, // 30s
  refund: 30_000, // 30s
  batchRelease: 30_000, // 30s
  generic: 30_000, // 30s
} as const;

// ============================================================================
// Validation: Ensure invariants are maintained
// ============================================================================

/**
 * Compile-time check: Dispute window must be within trade timeout.
 * If this fails, update DISPUTE_RESOLUTION_WINDOW_LEDGERS or reconsider design.
 */
// @ts-ignore: This will fail if invariant is violated
const _: unknown = ((): unknown => {
  if (DISPUTE_RESOLUTION_WINDOW_LEDGERS >= ESCROW_MAX_TIMEOUT_LEDGERS_POLICY) {
    throw new Error(
      `Timeout invariant violated: DISPUTE_RESOLUTION_WINDOW_LEDGERS (${DISPUTE_RESOLUTION_WINDOW_LEDGERS}) ` +
        `must be < ESCROW_MAX_TIMEOUT_LEDGERS_POLICY (${ESCROW_MAX_TIMEOUT_LEDGERS_POLICY})`,
    );
  }
  return null;
})();

/**
 * Compile-time check: Cash timeout must be within contract max.
 */
// @ts-ignore: This will fail if invariant is violated
const __: unknown = ((): unknown => {
  if (CASH_DEFAULT_TIMEOUT_LEDGERS > ESCROW_MAX_TIMEOUT_LEDGERS_POLICY) {
    throw new Error(
      `Timeout invariant violated: CASH_DEFAULT_TIMEOUT_LEDGERS (${CASH_DEFAULT_TIMEOUT_LEDGERS}) ` +
        `must be <= ESCROW_MAX_TIMEOUT_LEDGERS_POLICY (${ESCROW_MAX_TIMEOUT_LEDGERS_POLICY})`,
    );
  }
  return null;
})();

/**
 * Compile-time check: Settlement chain timeout must be within contract max.
 */
// @ts-ignore: This will fail if invariant is violated
const ___: unknown = ((): unknown => {
  if (
    SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS > ESCROW_MAX_TIMEOUT_LEDGERS_POLICY
  ) {
    throw new Error(
      `Timeout invariant violated: SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS (${SETTLEMENT_CHAIN_DEFAULT_TIMEOUT_LEDGERS}) ` +
        `must be <= ESCROW_MAX_TIMEOUT_LEDGERS_POLICY (${ESCROW_MAX_TIMEOUT_LEDGERS_POLICY})`,
    );
  }
  return null;
})();

/**
 * Compile-time check: Chat retention must be shorter than evidence retention.
 * (This is a convention, not a hard invariant, but helps with audit trails.)
 */
// @ts-ignore: This will fail if convention is violated
const ____: unknown = ((): unknown => {
  if (DEFAULT_CHAT_RETENTION_MS > DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS) {
    console.warn(
      `Timeout convention: CHAT_RETENTION_MS (${DEFAULT_CHAT_RETENTION_MS}) ` +
        `is longer than EVIDENCE_RETENTION_MS (${DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS}). ` +
        `This is unusual but not invalid — update this check if intentional.`,
    );
  }
  return null;
})();

/**
 * Typical Stellar ledger close time used only for human-readable estimates.
 * On-chain refund eligibility is always ledger-based; this value is never a gate.
 */
export const AVERAGE_LEDGER_CLOSE_SECONDS = 6;

// ============================================================================
// Cross-ledger atomic swap dispute bridge
// ============================================================================

/**
 * How often the swap dispute worker scans for revealed preimages and expiries.
 *
 * Deliberately shorter than one ledger close (~6s): the requirement is that a
 * revealed secret is extracted within one ledger sequence, so the scan has to
 * run at least once per ledger to have a chance of catching it.
 * Can be overridden via SWAP_DISPUTE_POLL_INTERVAL_MS.
 */
export const DEFAULT_SWAP_DISPUTE_POLL_INTERVAL_MS = 5_000;

/**
 * Ledgers of margin before a swap's expiry at which it is treated as at-risk
 * and operators are alerted.
 *
 * ~50 ledgers ≈ 5 minutes. The point is to fire while a refund can still be
 * organised, not to announce the loss afterwards.
 */
export const SWAP_DISPUTE_WARNING_MARGIN_LEDGERS = 50;

/**
 * Extra ledgers to wait after expiry before claiming an automated refund.
 *
 * Zero: the on-chain `refund()` already enforces
 * `current_ledger >= timeout_ledger`, so waiting longer only prolongs the
 * lockup this feature exists to end. Kept as a named constant so the "no extra
 * grace" decision is explicit rather than an accident of the code.
 */
export const SWAP_DISPUTE_REFUND_GRACE_LEDGERS = 0;

/** Lifecycle of one cross-chain swap as tracked by the dispute bridge. */
export interface SwapDisputeCountdown {
  expirationLedger: number;
  latestLedger: number;
  ledgersUntilExpiry: number;
  /** True once the on-chain refund precondition is satisfied. */
  refundClaimable: boolean;
  /** True while inside the warning margin but not yet expired. */
  approachingExpiry: boolean;
  estimatedSecondsUntilExpiry: number;
}

/**
 * Builds the countdown the dispute card and worker both read from.
 *
 * `refundClaimable` mirrors the contract's own precondition exactly
 * (`latestLedger >= expirationLedger`), so the UI never offers a claim the
 * chain would reject.
 */
export function buildSwapDisputeCountdown(
  expirationLedger: number,
  latestLedger: number,
  warningMarginLedgers: number = SWAP_DISPUTE_WARNING_MARGIN_LEDGERS,
): SwapDisputeCountdown {
  const ledgersUntilExpiry = Math.max(0, expirationLedger - latestLedger);
  const refundClaimable =
    latestLedger >= expirationLedger + SWAP_DISPUTE_REFUND_GRACE_LEDGERS;

  return {
    expirationLedger,
    latestLedger,
    ledgersUntilExpiry,
    refundClaimable,
    approachingExpiry: !refundClaimable && ledgersUntilExpiry <= warningMarginLedgers,
    estimatedSecondsUntilExpiry: ledgersUntilExpiry * AVERAGE_LEDGER_CLOSE_SECONDS,
  };
}

/** Public countdown for when permissionless refund becomes available. */
export interface RefundCountdown {
  timeoutLedger: number;
  latestLedger: number;
  ledgersUntilRefund: number;
  refundAvailable: boolean;
  estimatedSecondsUntilRefund: number;
}

/**
 * Build a refund countdown from stored timeout ledger + current chain tip.
 * `ledgersUntilRefund` is 0 once `latestLedger >= timeoutLedger`.
 */
export function buildRefundCountdown(
  timeoutLedger: number,
  latestLedger: number,
): RefundCountdown {
  const ledgersUntilRefund = Math.max(0, timeoutLedger - latestLedger);
  return {
    timeoutLedger,
    latestLedger,
    ledgersUntilRefund,
    refundAvailable: latestLedger >= timeoutLedger,
    estimatedSecondsUntilRefund:
      ledgersUntilRefund * AVERAGE_LEDGER_CLOSE_SECONDS,
  };
}

// Export a summary for logging/debugging
export const TIMEOUT_POLICY_SUMMARY = {
  cashTradeTimeout: `${CASH_DEFAULT_TIMEOUT_LEDGERS} ledgers (~15 min)`,
  escrowMaxTimeout: `${ESCROW_MAX_TIMEOUT_LEDGERS_POLICY} ledgers (~7 days)`,
  disputeWindow: `${DISPUTE_RESOLUTION_WINDOW_LEDGERS} ledgers (~3 days)`,
  chatRetention: `${DEFAULT_CHAT_RETENTION_MS / (24 * 60 * 60 * 1000)} days (post-terminal)`,
  evidenceRetention: `${DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS / (24 * 60 * 60 * 1000)} days (post-terminal)`,
} as const;
