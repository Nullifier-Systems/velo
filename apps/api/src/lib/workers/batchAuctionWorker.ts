import { BATCH_AUCTION } from "@velo/shared";
import { clearBatch } from "../batch-auction-engine.js";
import {
  createRound,
  forfeitUnrevealed,
  getCommittedOrders,
  getCurrentCommitRound,
  getReveals,
  setRoundPhase,
} from "../encrypted-order-store.js";

export interface BatchAuctionWorkerOptions {
  commitMs?: number;
  revealMs?: number;
  onRoundSettled?: (result: { roundId: string; clearingPriceStroops: string | null }) => void;
}

/**
 * Drives the 10-second COMMIT -> REVEAL -> MATCH -> SETTLE batch auction
 * state machine (#403).
 *
 *   COMMIT  — a round accepts new commit-hash orders until `commitDeadline`.
 *   REVEAL  — order parameters are revealed and hash-verified until
 *             `revealDeadline`; commitments that never reveal are flagged
 *             `forfeited` here so their deposit is not returned.
 *   MATCH   — revealed orders are cleared at a single uniform price
 *             (batch-auction-engine.ts).
 *   SETTLE  — clearing price is recorded on the round; a new COMMIT round
 *             opens immediately so submissions are never blocked.
 *
 * Ticks on a 1s timer rather than being scheduled per-phase so a slow
 * process (e.g. a debugger pause) can never leave a round stuck — every
 * tick just checks "are we past this round's deadline yet."
 */
export function startBatchAuctionWorker(options: BatchAuctionWorkerOptions = {}): () => void {
  const commitMs = options.commitMs ?? BATCH_AUCTION.COMMIT_PHASE_MS;
  const revealMs = options.revealMs ?? BATCH_AUCTION.REVEAL_PHASE_MS;

  let current = getCurrentCommitRound() ?? createRound({ commitMs, revealMs });

  const timer = setInterval(() => {
    tick();
  }, 1_000);
  timer.unref();

  function tick(): void {
    const now = Date.now();

    if (current.phase === "COMMIT" && now >= Date.parse(current.commitDeadline)) {
      current = setRoundPhase(current.roundId, "REVEAL") ?? current;
      return;
    }

    if (current.phase === "REVEAL" && now >= Date.parse(current.revealDeadline)) {
      forfeitUnrevealed(current.roundId);
      current = setRoundPhase(current.roundId, "MATCH") ?? current;
      return;
    }

    if (current.phase === "MATCH") {
      const committed = getCommittedOrders(current.roundId);
      const revealed = getReveals(current.roundId);
      const result = clearBatch(committed, revealed);
      current =
        setRoundPhase(current.roundId, "SETTLE", {
          clearingPriceStroops: result.clearingPriceStroops,
          settledAt: new Date().toISOString(),
        }) ?? current;
      options.onRoundSettled?.({
        roundId: current.roundId,
        clearingPriceStroops: result.clearingPriceStroops,
      });
      return;
    }

    if (current.phase === "SETTLE") {
      setRoundPhase(current.roundId, "CLOSED");
      current = createRound({ commitMs, revealMs });
      return;
    }
  }

  return () => clearInterval(timer);
}
