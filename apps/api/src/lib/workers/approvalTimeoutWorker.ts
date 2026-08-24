/**
 * Dual-control expiration worker (#401).
 * Checks pending approvals every 60s and auto-expires those unapproved after 24 hours.
 */
import type { EnterpriseStore } from "../enterprise-store.js";

export interface ApprovalTimeoutWorkerOptions {
  store: EnterpriseStore;
  pollIntervalMs?: number;
  onExpired?: (count: number) => void;
  onError?: (error: unknown) => void;
}

export function startApprovalTimeoutWorker(options: ApprovalTimeoutWorkerOptions): () => void {
  const { store, pollIntervalMs = 60_000, onExpired, onError } = options;

  async function tick(): Promise<void> {
    try {
      const count = await store.expireStaleApprovals();
      if (count > 0) onExpired?.(count);
    } catch (err) {
      onError?.(err);
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  timer.unref?.();

  // fire once without blocking startup
  void tick().catch(() => undefined);

  return () => clearInterval(timer);
}
