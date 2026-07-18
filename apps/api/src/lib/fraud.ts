/**
 * Lightweight fraud detection for cash requests.
 *
 * Flags (does NOT block) requests where signals look suspicious, e.g. the
 * same buyer address creating many requests in a short window.
 *
 * In-memory tracking — resets on server restart.  Production would back this
 * with Redis or a similar store.
 *
 * ## False-positive considerations
 * - Legitimate power users (merchants, testnet faucets) may hit thresholds
 *   naturally.  The defaults are conservative; operators can tune them via
 *   env vars.
 * - The sliding window only tracks recent activity — historical behaviour
 *   does not contribute to flagging.
 * - Flagged requests are *logged only*; they are never blocked.  Operators
 *   should review flagged patterns before taking any action.
 */

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------

const WINDOW_MS = parseInt(process.env.FRAUD_WINDOW_MS ?? String(10 * 60 * 1000), 10); // 10 min
const MAX_REQUESTS = parseInt(process.env.FRAUD_MAX_REQUESTS ?? "5", 10);

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RequestEntry {
  timestamp: number;
}

// buyer address → sorted list of timestamps (ascending)
const requestLog = new Map<string, RequestEntry[]>();

// Addresses currently flagged and the reason
const flaggedAddresses = new Map<string, { reason: string; flaggedAt: string }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pruneWindow(address: string): void {
  const entries = requestLog.get(address);
  if (!entries) return;
  const cutoff = Date.now() - WINDOW_MS;
  const pruned = entries.filter(e => e.timestamp > cutoff);
  if (pruned.length === 0) {
    requestLog.delete(address);
  } else {
    requestLog.set(address, pruned);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FraudCheckResult {
  flagged: boolean;
  reason?: string;
}

/**
 * Record a request for `buyerAddress` and check whether it should be flagged.
 * Returns `flagged: true` when the buyer has exceeded the configured threshold
 * within the sliding window.
 *
 * This function has **no side effects on the request itself** — it never
 * blocks or modifies the transaction.
 */
export function checkAndRecord(buyerAddress: string): FraudCheckResult {
  // 1. Prune stale entries outside the window
  pruneWindow(buyerAddress);

  // 2. Record this request
  const entries = requestLog.get(buyerAddress) ?? [];
  entries.push({ timestamp: Date.now() });
  requestLog.set(buyerAddress, entries);

  // 3. Evaluate threshold
  if (entries.length > MAX_REQUESTS) {
    const reason =
      `${entries.length} requests in the last ${WINDOW_MS / 1000}s ` +
      `(threshold: ${MAX_REQUESTS})`;
    flaggedAddresses.set(buyerAddress, { reason, flaggedAt: new Date().toISOString() });
    return { flagged: true, reason };
  }

  return { flagged: false };
}

/** Return a snapshot of all currently flagged addresses. */
export function getFlaggedAddresses(): Record<string, { reason: string; flaggedAt: string }> {
  return Object.fromEntries(flaggedAddresses);
}

/** Remove an address from the flagged list (manual override). */
export function unflagAddress(address: string): boolean {
  return flaggedAddresses.delete(address);
}

/** Expose for testing / diagnostics — not intended for production use. */
export function getRequestLog(): Map<string, RequestEntry[]> {
  return requestLog;
}
