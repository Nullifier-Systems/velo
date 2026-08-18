/**
 * Tranche-based partial refund countdown and automated refund worker (Issue #380).
 *
 * The escrow contract already makes refund() permissionless once a trade's
 * timeout_ledger is reached, refunding the sum of every UNRELEASED tranche to
 * the buyer while released tranches stay settled with the seller. This module
 * is the off-chain half that watches for those timeouts and acts on them:
 *
 *   AC1  Warn 100 ledgers before expiry via a push alert (sendRefundCountdownAlert).
 *   AC2  Execute refundEscrow() automatically once the timeout is breached.
 *   AC3  Verify the accounting invariant on the refunded trade:
 *          seller_payouts + buyer_refund + fees == original_amount
 *
 * No contract change is required: plain lock() trades are modelled on-chain as a
 * single tranche, so refund() and this worker treat plain and multi-tranche
 * trades uniformly. See docs/TIMEOUT_POLICY.md for the ledger-timeout policy.
 */
import {
  getAllCashRequests,
  updateStatus,
  type CashRequestRecord,
} from "./store.js";
import { getLatestLedgerSequence, refundEscrow } from "./stellar.js";
import { buildRefundCountdown } from "./timeouts.js";
import { deriveFeeSplit } from "./amount-commitment.js";
import {
  sendRefundAlert,
  sendRefundCountdownAlert,
  sendWebhookAlert,
} from "./webhook.js";
import { sendNotification } from "./notification.js";
import { notifyTradeStatus } from "../routes/chat.js";

/** How many ledgers before timeout to fire the pre-expiry countdown alert (AC1). */
const REFUND_ALERT_THRESHOLD_LEDGERS = Number(
  process.env.REFUND_ALERT_THRESHOLD_LEDGERS ?? 100,
);
/** How often the worker re-scans locked trades for approaching or breached timeouts. */
const REFUND_POLL_INTERVAL_MS = Number(
  process.env.REFUND_POLL_INTERVAL_MS ?? 30_000,
);
/**
 * Platform fee rate used to split each released tranche into seller payout and
 * fee when reporting the accounting invariant. Mirrors the contract's
 * PlatformFeeBps (default 1%). Note the invariant holds for ANY feeBps because
 * payout + fee == tranche amount by construction, so this only affects how the
 * settled portion is attributed, never whether the totals balance.
 */
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 100);

export interface RefundAccounting {
  originalStroops: bigint;
  sellerPayoutStroops: bigint;
  buyerRefundStroops: bigint;
  feeStroops: bigint;
  /** True when seller_payouts + buyer_refund + fees == original_amount (AC3). */
  balances: boolean;
}

export interface RefundCountdownOptions {
  getLatestLedger?: typeof getLatestLedgerSequence;
  refund?: typeof refundEscrow;
  sendCountdownAlert?: typeof sendRefundCountdownAlert;
  sendRefundAlert?: typeof sendRefundAlert;
  notifyStatus?: typeof notifyTradeStatus;
  notifyUser?: typeof sendNotification;
  emitAlert?: typeof sendWebhookAlert;
  onInvariantViolation?: (
    record: CashRequestRecord,
    accounting: RefundAccounting,
  ) => Promise<void> | void;
  feeBps?: number;
  alertThresholdLedgers?: number;
}

export interface RefundCountdownTickResult {
  scanned: number;
  countdownAlertsSent: number;
  refunded: string[];
  invariantViolations: string[];
  errors: number;
}

let schedulerHandle: NodeJS.Timeout | undefined;
/** Prevents overlapping ticks so a slow refund cycle cannot double-submit. */
let tickInFlight = false;
/** Trades already warned this timeout window, so the countdown alert fires once. */
const alertedCountdown = new Set<string>();

/**
 * Reconstructs how a refunded trade's original amount is split across seller
 * payouts (released tranches), the buyer refund (unreleased tranches), and fees,
 * then checks the AC3 invariant. Plain single-tranche trades (no `tranches`
 * array) are treated as one unreleased tranche of the full amount.
 */
export function computeRefundAccounting(
  record: CashRequestRecord,
  feeBps: number,
): RefundAccounting {
  const originalStroops = BigInt(record.amountStroops);
  let sellerPayoutStroops = 0n;
  let buyerRefundStroops = 0n;
  let feeStroops = 0n;

  const tranches =
    record.tranches && record.tranches.length > 0
      ? record.tranches
      : [
          {
            amountStroops: record.amountStroops,
            secretHashHex: record.secretHashHex,
            released: false,
          },
        ];

  for (const tranche of tranches) {
    const trancheAmount = BigInt(tranche.amountStroops);
    if (tranche.released) {
      // Released tranche settled to the seller (payout) and admin (fee).
      const split = deriveFeeSplit(trancheAmount, feeBps);
      sellerPayoutStroops += split.payoutStroops;
      feeStroops += split.feeStroops;
    } else {
      // Unreleased tranche is what refund() returns to the buyer, in full.
      buyerRefundStroops += trancheAmount;
    }
  }

  const balances =
    sellerPayoutStroops + buyerRefundStroops + feeStroops === originalStroops;

  return {
    originalStroops,
    sellerPayoutStroops,
    buyerRefundStroops,
    feeStroops,
    balances,
  };
}

/**
 * One scan of every locked/expired trade with a timeout ledger. Sends countdown
 * alerts for trades approaching timeout (AC1), auto-refunds trades whose timeout
 * has been breached (AC2), and verifies the accounting invariant on each refund
 * (AC3). Exported standalone so it can be driven on-demand from tests without
 * the interval timer.
 */
export async function runRefundCountdownTick(
  options: RefundCountdownOptions = {},
): Promise<RefundCountdownTickResult> {
  const getLatestLedger = options.getLatestLedger ?? getLatestLedgerSequence;
  const refund = options.refund ?? refundEscrow;
  const sendCountdownAlert = options.sendCountdownAlert ?? sendRefundCountdownAlert;
  const sendRefundAlertFn = options.sendRefundAlert ?? sendRefundAlert;
  const notifyStatus = options.notifyStatus ?? notifyTradeStatus;
  const notifyUser = options.notifyUser ?? sendNotification;
  const emitAlert = options.emitAlert ?? sendWebhookAlert;
  const feeBps = options.feeBps ?? PLATFORM_FEE_BPS;
  const alertThreshold =
    options.alertThresholdLedgers ?? REFUND_ALERT_THRESHOLD_LEDGERS;

  const result: RefundCountdownTickResult = {
    scanned: 0,
    countdownAlertsSent: 0,
    refunded: [],
    invariantViolations: [],
    errors: 0,
  };

  let latestLedger: number;
  try {
    latestLedger = await getLatestLedger();
  } catch (err) {
    console.error("[refund-scheduler] failed to fetch latest ledger:", err);
    return result;
  }

  // Both "locked" and "expired" are refund candidates: expireCashRequest() only
  // flips the store status, it does not itself invoke refund() on-chain.
  const candidates = getAllCashRequests().filter(
    (r) =>
      (r.status === "locked" || r.status === "expired") &&
      typeof r.timeoutLedger === "number",
  );
  result.scanned = candidates.length;

  // Keep the dedup set bounded to trades still in flight; a trade that has been
  // refunded (or otherwise left the candidate set) is forgotten.
  const candidateIds = new Set(candidates.map((r) => r.id));
  for (const id of alertedCountdown) {
    if (!candidateIds.has(id)) alertedCountdown.delete(id);
  }

  for (const record of candidates) {
    const timeoutLedger = record.timeoutLedger as number;
    const countdown = buildRefundCountdown(timeoutLedger, latestLedger);

    if (countdown.refundAvailable) {
      // AC2: timeout breached, execute the permissionless refund on-chain.
      try {
        await refund({ contractId: record.contractId, tradeId: record.id });
      } catch (err) {
        console.error(
          `[refund-scheduler] refund failed for trade ${record.id}:`,
          err,
        );
        result.errors++;
        continue; // stays locked/expired, retried next tick
      }

      updateStatus(record.id, "refunded");
      alertedCountdown.delete(record.id);
      result.refunded.push(record.id);

      // Mirror the manual refund route's bookkeeping so both paths converge.
      try {
        await notifyStatus(record.id, "refunded");
        await notifyUser(record, "refunded", "en");
        await sendRefundAlertFn({
          tradeId: record.id,
          amountStroops: record.amountStroops,
          buyer: record.buyer,
          seller: record.seller,
        });
      } catch (err) {
        console.error(
          `[refund-scheduler] post-refund notification failed for ${record.id}:`,
          err,
        );
      }

      // AC3: verify the accounting invariant on the just-refunded trade.
      const accounting = computeRefundAccounting(record, feeBps);
      if (!accounting.balances) {
        result.invariantViolations.push(record.id);
        console.error(
          `[refund-scheduler] accounting invariant violated for trade ${record.id}: ` +
            `seller_payouts(${accounting.sellerPayoutStroops}) + ` +
            `buyer_refund(${accounting.buyerRefundStroops}) + ` +
            `fees(${accounting.feeStroops}) != original(${accounting.originalStroops})`,
        );
        try {
          if (options.onInvariantViolation) {
            await options.onInvariantViolation(record, accounting);
          } else {
            await emitAlert({
              title: "Refund accounting invariant violated",
              text: `Trade \`${record.id}\` failed the refund accounting invariant.`,
              fields: {
                "Trade ID": `\`${record.id}\``,
                "Original (stroops)": String(accounting.originalStroops),
                "Seller payouts": String(accounting.sellerPayoutStroops),
                "Buyer refund": String(accounting.buyerRefundStroops),
                Fees: String(accounting.feeStroops),
              },
            });
          }
        } catch (err) {
          console.error(
            `[refund-scheduler] invariant alert failed for ${record.id}:`,
            err,
          );
        }
      }
      continue;
    }

    // AC1: approaching timeout, send a one-shot countdown alert per window.
    if (
      countdown.ledgersUntilRefund > 0 &&
      countdown.ledgersUntilRefund <= alertThreshold &&
      !alertedCountdown.has(record.id)
    ) {
      try {
        await sendCountdownAlert({
          tradeId: record.id,
          amountStroops: record.amountStroops,
          buyer: record.buyer,
          seller: record.seller,
          timeoutLedger,
          latestLedger,
          ledgersUntilRefund: countdown.ledgersUntilRefund,
          estimatedSecondsUntilRefund: countdown.estimatedSecondsUntilRefund,
        });
        alertedCountdown.add(record.id);
        result.countdownAlertsSent++;
      } catch (err) {
        console.error(
          `[refund-scheduler] countdown alert failed for ${record.id}:`,
          err,
        );
        result.errors++;
      }
    }
  }

  return result;
}

/**
 * Starts the background refund worker. Idempotent: a second call is a no-op
 * unless the first was stopped. Ticks never overlap.
 */
export function startRefundCountdownScheduler(
  intervalMs: number = REFUND_POLL_INTERVAL_MS,
  options?: RefundCountdownOptions,
): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    runRefundCountdownTick(options)
      .catch((err) => console.error("[refund-scheduler] tick failed:", err))
      .finally(() => {
        tickInFlight = false;
      });
  }, intervalMs);
  schedulerHandle.unref?.();
}

export function stopRefundCountdownScheduler(): void {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = undefined;
}

/** Test helper: clears the countdown dedup memory so ticks start fresh. */
export function resetRefundCountdownState(): void {
  alertedCountdown.clear();
}
