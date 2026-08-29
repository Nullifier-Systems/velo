/**
 * Collateral Cooldown Monitor (#420).
 *
 * Background processor for the Multi-Asset Escrow Collateral Flash-Loan
 * Attack Prevention Protocol. Polls the latest Soroban ledger sequence and
 * flips `is_locked = FALSE` on `escrow_collateral_deposits` rows whose
 * cooldown bounds have expired, so providers can withdraw or reallocate
 * collateral exactly once the mandatory ~5-ledger (~25s) lockup is over.
 */
import { CollateralGuardStore } from "../collateralGuard.js";
import { getLatestLedgerSequence } from "../stellar.js";

export interface CollateralCooldownWorkerOptions {
  store: CollateralGuardStore;
  /** One cooldown epoch (~5 ledgers x ~5s) by default. */
  pollIntervalMs?: number;
  /** Injectable ledger source (tests); defaults to Soroban RPC. */
  getCurrentLedger?: () => Promise<number>;
  onUnlocked?: (count: number) => void;
  onError?: (error: unknown) => void;
}

export function startCollateralCooldownWorker(
  options: CollateralCooldownWorkerOptions,
): () => void {
  const {
    store,
    pollIntervalMs = 25_000,
    getCurrentLedger = getLatestLedgerSequence,
    onUnlocked,
    onError,
  } = options;

  async function tick(): Promise<void> {
    try {
      const currentLedger = await getCurrentLedger();
      const count = await store.unlockExpiredDeposits(currentLedger);
      if (count > 0) onUnlocked?.(count);
    } catch (error) {
      onError?.(error);
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
