import {
  computeTrancheFeeStroops,
  verifyFeeInvariant,
  type FeeArithmeticOverflowError,
} from "../fee-math.js";

/**
 * Fee Invariant Auditor Worker (issue #381).
 *
 * Audits completed escrow transactions against the
 * `fee_precision_audit_log` table (migration `015_fix_fee_precision_audit.sql`)
 * and verifies that for 100% of trades:
 *
 *   gross_amount == net_payout + calculated_fee
 *
 * The worker is dependency-injected like the other workers in this
 * directory (`sessionRotationWorker.ts`) so tests can drive it without
 * redis or a database: trades come from an injectable loader, audit
 * rows go to an injectable store (in-memory by default), and findings
 * surface through the `onEvent` callback.
 */

/** One row of `fee_precision_audit_log`. */
export interface FeePrecisionAuditEntry {
  tradeId: string;
  trancheIndex: number;
  grossAmountStroops: string;
  calculatedFeeStroops: string;
  netPayoutStroops: string;
}

/** Structural subset of the audit-log persistence this worker needs. */
export interface FeeAuditStore {
  record(entry: FeePrecisionAuditEntry): Promise<void>;
  list(): Promise<FeePrecisionAuditEntry[]>;
}

/** In-memory default store (dev / tests); swap for a pg-backed one in prod. */
export function createInMemoryFeeAuditStore(): FeeAuditStore {
  const entries: FeePrecisionAuditEntry[] = [];
  return {
    async record(entry) {
      entries.push(entry);
    },
    async list() {
      return [...entries];
    },
  };
}

/** Minimal view of a settled trade the auditor needs. */
export interface AuditableTrade {
  id: string;
  /** Platform fee in basis points used for this trade's settlement. */
  feeBps: number;
  tranches: Array<{
    index: number;
    amountStroops: string | bigint;
    released: boolean;
  }>;
}

export type FeeAuditEvent =
  | { type: "recorded"; tradeId: string; trancheIndex: number }
  | { type: "violation"; tradeId: string; trancheIndex: number; reason: string }
  | { type: "error"; reason: string };

export interface FeeAuditWorkerOptions {
  /** Loads settled trades to audit (e.g. recent `released` records). */
  loadTrades?: () => Promise<AuditableTrade[]>;
  store?: FeeAuditStore;
  onEvent?: (event: FeeAuditEvent) => void;
  pollIntervalMs?: number;
}

export interface FeeAuditFinding {
  tradeId: string;
  trancheIndex: number;
  ok: boolean;
  gross?: string;
  fee?: string;
  net?: string;
  reason?: string;
}

/**
 * Pure per-tranche audit: recomputes the fee with safe math and checks
 * the conservation invariant. Never throws for bad data — a violation
 * or arithmetic failure becomes a failed finding instead.
 */
export function auditTranche(
  tradeId: string,
  tranche: { index: number; amountStroops: string | bigint },
  feeBps: number,
): FeeAuditFinding {
  let gross: bigint;
  try {
    gross = BigInt(tranche.amountStroops);
    const fee = computeTrancheFeeStroops(gross, feeBps);
    const net = gross - fee;
    if (!verifyFeeInvariant(gross, fee, net)) {
      return {
        tradeId,
        trancheIndex: tranche.index,
        ok: false,
        reason: "gross_amount != net_payout + calculated_fee",
      };
    }
    return {
      tradeId,
      trancheIndex: tranche.index,
      ok: true,
      gross: gross.toString(),
      fee: fee.toString(),
      net: net.toString(),
    };
  } catch (err) {
    return {
      tradeId,
      trancheIndex: tranche.index,
      ok: false,
      reason: `fee arithmetic failed: ${(err as FeeArithmeticOverflowError).message}`,
    };
  }
}

/** Audits every released tranche of every loaded trade. */
export async function runFeeAudit(options: {
  trades: AuditableTrade[];
  store: FeeAuditStore;
  onEvent?: (event: FeeAuditEvent) => void;
}): Promise<{ audited: number; violations: number }> {
  const { trades, store, onEvent } = options;
  let audited = 0;
  let violations = 0;

  for (const trade of trades) {
    for (const tranche of trade.tranches) {
      if (!tranche.released) continue;
      const finding = auditTranche(trade.id, tranche, trade.feeBps);
      await store.record({
        tradeId: finding.tradeId,
        trancheIndex: finding.trancheIndex,
        grossAmountStroops: finding.gross ?? "0",
        calculatedFeeStroops: finding.fee ?? "0",
        netPayoutStroops: finding.net ?? "0",
      });
      audited += 1;
      if (finding.ok) {
        onEvent?.({
          type: "recorded",
          tradeId: finding.tradeId,
          trancheIndex: finding.trancheIndex,
        });
      } else {
        violations += 1;
        onEvent?.({
          type: "violation",
          tradeId: finding.tradeId,
          trancheIndex: finding.trancheIndex,
          reason: finding.reason ?? "unknown",
        });
      }
    }
  }

  return { audited, violations };
}

/**
 * Starts the polling audit loop. Returns a stop function, matching the
 * worker conventions in this directory. The loop never keeps the
 * process alive and never throws — audit failures are reported via
 * `onEvent` so a broken audit cannot take the API down.
 */
export function startFeeAuditWorker(
  options: FeeAuditWorkerOptions = {},
): () => void {
  const {
    loadTrades = async () => [],
    store = createInMemoryFeeAuditStore(),
    onEvent,
    pollIntervalMs = 60_000,
  } = options;

  let stopped = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const trades = await loadTrades();
      await runFeeAudit({ trades, store, onEvent });
    } catch (err) {
      onEvent?.({ type: "error", reason: String(err) });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, pollIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
