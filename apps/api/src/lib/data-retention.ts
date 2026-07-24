/**
 * Automated Data Retention & Deletion Mechanism (Issue #240).
 *
 * Implements automated deletion for high-sensitivity data categories:
 * - Trade Chat History & Keys (Retention window: default 30 days post-finalization)
 * - Dispute Evidence Uploads (Retention window: default 90 days post-finalization)
 *
 * Trade records themselves are retained persistently for financial/tax auditing,
 * dispute tracing, and reputation score integrity.
 */
import { getAllCashRequests, type CashRequestRecord } from "./store.js";
import { getChatInfrastructure, type ChatInfrastructure } from "./chat-infrastructure.js";
import { deleteMessagesForTrade } from "./chat-store.js";
import { deleteKeysForTrade } from "./key-store.js";
import { deleteDisputeEvidenceForTrade } from "./dispute-evidence-store.js";

/** Default retention periods in milliseconds */
export const DEFAULT_CHAT_RETENTION_MS = Number(
  process.env.CHAT_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000 // 30 days
);
export const DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS = Number(
  process.env.DISPUTE_EVIDENCE_RETENTION_MS ?? 90 * 24 * 60 * 60 * 1000 // 90 days
);
export const DEFAULT_DATA_RETENTION_POLL_INTERVAL_MS = Number(
  process.env.DATA_RETENTION_POLL_INTERVAL_MS ?? 60 * 60 * 1000 // 1 hour
);

export interface RetentionPurgeOptions {
  chatRetentionMs?: number;
  disputeEvidenceRetentionMs?: number;
  now?: Date;
  pg?: { query: (sql: string, params?: any[]) => Promise<any> };
  infrastructure?: ChatInfrastructure;
}

export interface RetentionPurgeResult {
  purgedChats: number;
  purgedEvidence: number;
  purgedChatTrades: number;
  purgedEvidenceTrades: number;
}

let schedulerHandle: NodeJS.Timeout | undefined;

/**
 * Helper to determine when a trade reached a terminal state.
 * Prefers `resolvedAt` (if set during dispute/release), falling back to `createdAt`.
 */
export function getTradeFinalizedTimestamp(record: CashRequestRecord): number {
  const tsString = record.resolvedAt ?? record.createdAt;
  const parsed = Date.parse(tsString);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Runs a single tick of the data retention purge worker.
 * Scans terminal trades (`released` / `refunded`), checks retention windows,
 * and permanently deletes expired chat history and dispute evidence.
 *
 * Exported standalone so it can be invoked on-demand in background workers or tests.
 */
export async function runRetentionPurgeTick(
  options: RetentionPurgeOptions = {}
): Promise<RetentionPurgeResult> {
  const chatRetentionMs = options.chatRetentionMs ?? DEFAULT_CHAT_RETENTION_MS;
  const evidenceRetentionMs =
    options.disputeEvidenceRetentionMs ?? DEFAULT_DISPUTE_EVIDENCE_RETENTION_MS;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const infrastructure = options.infrastructure ?? getChatInfrastructure();

  const allTrades = getAllCashRequests();
  let purgedChats = 0;
  let purgedEvidence = 0;
  let purgedChatTrades = 0;
  let purgedEvidenceTrades = 0;

  for (const trade of allTrades) {
    // Only terminal trades (released or refunded) are eligible for retention expiration.
    if (trade.status !== "released" && trade.status !== "refunded") {
      continue;
    }

    const finalizedMs = getTradeFinalizedTimestamp(trade);
    const ageMs = nowMs - finalizedMs;

    // Purge Chat History & Peer Keys if past chat retention window
    if (ageMs >= chatRetentionMs) {
      const deletedInfraChats = await infrastructure.deleteTradeChat(trade.id);
      const deletedStoreChats = deleteMessagesForTrade(trade.id);
      deleteKeysForTrade(trade.id);

      const chatCount = Math.max(deletedInfraChats, deletedStoreChats);
      if (chatCount > 0) {
        purgedChats += chatCount;
        purgedChatTrades++;
        console.log(
          `[data-retention] Purged chat history (${chatCount} message(s)) for trade ${trade.id} (reason: retention_expired)`
        );
      }
    }

    // Purge Dispute Evidence Uploads if past evidence retention window
    if (ageMs >= evidenceRetentionMs) {
      const deletedMemEvidence = deleteDisputeEvidenceForTrade(trade.id);
      let deletedPgEvidence = 0;

      if (options.pg) {
        try {
          const res = await options.pg.query(
            "DELETE FROM dispute_evidence WHERE trade_id = $1",
            [trade.id]
          );
          deletedPgEvidence = res?.rowCount ?? 0;
        } catch (err) {
          console.error(
            `[data-retention] Error deleting SQL dispute evidence for trade ${trade.id}:`,
            err
          );
        }
      }

      const evidenceCount = Math.max(deletedMemEvidence, deletedPgEvidence);
      if (evidenceCount > 0) {
        purgedEvidence += evidenceCount;
        purgedEvidenceTrades++;
        console.log(
          `[data-retention] Purged dispute evidence (${evidenceCount} file(s)) for trade ${trade.id} (reason: retention_expired)`
        );
      }
    }
  }

  if (purgedChats > 0 || purgedEvidence > 0) {
    console.log(
      `[data-retention] Purge complete: ${purgedChats} chat message(s) across ${purgedChatTrades} trade(s), ${purgedEvidence} evidence file(s) across ${purgedEvidenceTrades} trade(s).`
    );
  }

  return {
    purgedChats,
    purgedEvidence,
    purgedChatTrades,
    purgedEvidenceTrades,
  };
}

/**
 * Starts the data retention background scheduler.
 * Idempotent: safe to call multiple times.
 */
export function startDataRetentionScheduler(
  intervalMs: number = DEFAULT_DATA_RETENTION_POLL_INTERVAL_MS,
  options?: RetentionPurgeOptions
): void {
  if (schedulerHandle) return;
  schedulerHandle = setInterval(() => {
    runRetentionPurgeTick(options).catch((err) =>
      console.error("[data-retention] Purge tick failed:", err)
    );
  }, intervalMs);
  schedulerHandle.unref?.();
}

/**
 * Stops the data retention background scheduler.
 */
export function stopDataRetentionScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = undefined;
  }
}
