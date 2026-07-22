/**
 * Provider payout batching — the off-chain half.
 *
 * Opt-in per provider (see POST /provider/payout-settings). When a
 * "batched" provider's trade is released via POST /cash/request/:id/release,
 * the revealed secret is queued instead of settled immediately
 * (store.ts#enqueueForBatch). This module periodically checks each
 * provider's queue and, once it has crossed a schedule window or a count
 * threshold, submits everything queued for that provider in one
 * batch_release() call (contracts/escrow) — one on-chain transaction
 * instead of one per trade.
 *
 * See docs/provider-payout-batching.md for the tradeoffs (payout latency
 * vs. fee savings) and why this doesn't weaken the escrow's trustless
 * guarantee.
 */
import { batchReleaseEscrow } from "./stellar.js";
import { getPendingBatchesByProvider, updateStatus, CashRequestRecord } from "./store.js";
import { notifyTradeStatus } from "../routes/chat.js";
import { sendNotification } from "./notification.js";

/** Max time a trade waits in queue before its provider's batch is forced out. */
const BATCH_WINDOW_MS = Number(process.env.PAYOUT_BATCH_WINDOW_MS ?? 5 * 60 * 1000);
/** Flush a provider's queue as soon as it reaches this many trades, without waiting for the window. */
const BATCH_THRESHOLD_COUNT = Number(process.env.PAYOUT_BATCH_THRESHOLD_COUNT ?? 5);
/** How often the scheduler re-checks queues. Independent of, and smaller than, the window so threshold triggers fire promptly. */
const BATCH_POLL_INTERVAL_MS = Number(process.env.PAYOUT_BATCH_POLL_INTERVAL_MS ?? 30_000);
/** Per-transaction cap — mirrors the escrow contract's MAX_BATCH_SIZE, which rejects an oversized batch outright. */
const BATCH_MAX_SIZE = Number(process.env.PAYOUT_BATCH_MAX_SIZE ?? 25);

let schedulerHandle: NodeJS.Timeout | undefined;

/** True once a provider's queue is old enough or large enough to settle. */
function shouldFlush(items: CashRequestRecord[]): boolean {
    if (items.length === 0) return false;
    if (items.length >= BATCH_THRESHOLD_COUNT) return true;
    const oldest = items[0]; // getPendingBatchesByProvider() returns oldest-first
    const queuedAt = new Date(oldest.batchQueuedAt ?? oldest.createdAt).getTime();
    return Date.now() - queuedAt >= BATCH_WINDOW_MS;
}

/**
 * Settles one provider's queue in a single batch_release() invocation.
 * Trades the contract actually released move to "released"; anything it
 * skipped (or the whole call failing) stays "pending_batch" and is picked
 * up again on the next tick — never silently dropped.
 */
async function flushProviderBatch(sellerAddress: string, items: CashRequestRecord[]): Promise<void> {
    const contractId = items[0].contractId;
    const batch = items.filter((r) => r.contractId === contractId).slice(0, BATCH_MAX_SIZE);

    let releasedHex: string[];
    try {
        releasedHex = await batchReleaseEscrow({
            contractId,
            releases: batch.map((r) => ({ tradeId: r.id, secretHex: r.secretHex })),
        });
    } catch (err) {
        console.error(`[payout-batcher] batch_release failed for provider ${sellerAddress}:`, err);
        return;
    }

    const releasedSet = new Set(releasedHex);
    for (const record of batch) {
        if (!releasedSet.has(record.id)) continue;
        updateStatus(record.id, "released");
        notifyTradeStatus(record.id, "released");
        await sendNotification(record, "released", "en");
    }
}

/** Checks every provider's queue and flushes the ones ready to settle. Exported standalone so it can be triggered on-demand (e.g. from tests) without waiting on the interval timer. */
export async function runBatchTick(): Promise<void> {
    const byProvider = getPendingBatchesByProvider();
    for (const [sellerAddress, items] of byProvider) {
        if (!shouldFlush(items)) continue;
        await flushProviderBatch(sellerAddress, items);
    }
}

/** Starts the background scheduler. Idempotent — a second call is a no-op unless the first was stopped. */
export function startPayoutBatchScheduler(intervalMs: number = BATCH_POLL_INTERVAL_MS): void {
    if (schedulerHandle) return;
    schedulerHandle = setInterval(() => {
        runBatchTick().catch((err) => console.error("[payout-batcher] tick failed:", err));
    }, intervalMs);
    schedulerHandle.unref?.();
}

export function stopPayoutBatchScheduler(): void {
    if (schedulerHandle) clearInterval(schedulerHandle);
    schedulerHandle = undefined;
}
