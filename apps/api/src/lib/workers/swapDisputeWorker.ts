/**
 * Atomic Swap Secret Extraction Worker.
 *
 * Watches both legs of every live cross-chain swap and does two things the
 * counterparties would otherwise have to do by hand:
 *
 *   1. **Extract secrets.** When a preimage is revealed on either chain, store
 *      it off-chain immediately. The Stellar leg publishes it in a `released`
 *      event and (since this feature) in contract state, but an event is only
 *      seen by whoever is watching at the time — a relayer that was restarting
 *      loses it, and with it the counterpart leg's collateral. Persisting on
 *      first sight is what makes that unrecoverable case recoverable.
 *
 *   2. **Claim refunds.** When a leg expires with no secret anywhere, claim the
 *      honest party's refund automatically instead of leaving them to notice
 *      and act. `refund()` is permissionless on-chain, so the worker needs no
 *      signature from them.
 *
 * The poll interval is deliberately shorter than a ledger close, so a reveal
 * is picked up within one ledger sequence.
 *
 * Concurrency: this worker races operators calling
 * POST /api/v1/swaps/dispute-claim. Both go through `SwapDisputeStore`'s
 * `SELECT ... FOR UPDATE` claims, so on-chain submission happens exactly once
 * per swap even when they fire simultaneously.
 */
import {
  SwapDisputeStore,
  type SwapDisputeBridge,
} from "../swapDisputeStore.js";
import {
  DEFAULT_SWAP_DISPUTE_POLL_INTERVAL_MS,
  buildSwapDisputeCountdown,
} from "../timeouts.js";
import {
  sendSwapExpiryWarningAlert,
  sendSwapRefundClaimedAlert,
  sendSwapSecretExtractedAlert,
} from "../webhook.js";

/** One observed preimage reveal, from either chain. */
export interface ObservedReveal {
  swapId: string;
  /** 32-byte preimage, hex encoded. */
  preimageHex: string;
  /** Which leg it came from — recorded for operator context only. */
  source: "stellar" | "evm";
}

export interface SwapDisputeWorkerOptions {
  store: SwapDisputeStore;
  /** Current chain tip; drives both expiry and warning decisions. */
  getLedger: () => Promise<number>;
  /**
   * Reveals observed since the last tick, from Stellar event logs and/or EVM
   * logs. Injected so the worker stays testable without a chain.
   */
  pollReveals: () => Promise<ObservedReveal[]>;
  /**
   * Submits the on-chain `refund()` for a swap the worker has exclusively
   * claimed. Runs outside the database lock — a hung RPC must not pin a row.
   * Returning a tx hash is optional and used only for the alert.
   */
  submitRefund?: (bridge: SwapDisputeBridge) => Promise<string | null>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
  onTick?: (summary: SwapDisputeTickSummary) => void;
}

export interface SwapDisputeTickSummary {
  secretsExtracted: number;
  refundsClaimed: number;
  warningsSent: number;
}

/**
 * Runs one full pass. Exported separately from the interval so tests can drive
 * it deterministically instead of waiting on wall-clock timers.
 */
export async function runSwapDisputeTick(
  options: SwapDisputeWorkerOptions,
): Promise<SwapDisputeTickSummary> {
  const { store, getLedger, pollReveals, submitRefund } = options;
  const summary: SwapDisputeTickSummary = {
    secretsExtracted: 0,
    refundsClaimed: 0,
    warningsSent: 0,
  };

  const latestLedger = await getLedger();

  // --- 1. Extract any newly revealed preimages -----------------------------
  //
  // Secrets first, deliberately: a swap whose preimage just landed must not be
  // refunded in the same tick. Refunding it would return the funds while the
  // counterparty still holds a usable secret for the other leg.
  const reveals = await pollReveals();
  for (const reveal of reveals) {
    try {
      const result = await store.recordSecret(reveal.swapId, reveal.preimageHex);
      if (!result.claimedForSettlement) continue;

      summary.secretsExtracted += 1;
      await sendSwapSecretExtractedAlert({
        swapId: result.bridge.swapId,
        secretHash: result.bridge.secretHash,
        initiator: result.bridge.initiatorAddress,
        counterparty: result.bridge.counterpartyAddress,
        extractedAtLedger: latestLedger,
        expirationLedger: result.bridge.expirationLedger,
      });
    } catch (error) {
      // One bad reveal (unknown swap, preimage that does not hash) must not
      // stop the rest of the batch — the remaining secrets are still at risk.
      options.onError?.(error);
    }
  }

  // --- 2. Claim refunds for legs that expired with no secret ---------------
  const expired = await store.listExpiredActive(latestLedger);
  for (const bridge of expired) {
    try {
      const claim = await store.claimRefund(bridge.swapId, latestLedger);
      if (!claim.claimedForRefund) continue; // someone else owns it

      // On-chain submission happens outside the lock.
      const txHash = submitRefund ? await submitRefund(claim.bridge) : null;

      summary.refundsClaimed += 1;
      await sendSwapRefundClaimedAlert({
        swapId: claim.bridge.swapId,
        initiator: claim.bridge.initiatorAddress,
        counterparty: claim.bridge.counterpartyAddress,
        expirationLedger: claim.bridge.expirationLedger,
        latestLedger,
        txHash,
      });

      await store.markResolved(claim.bridge.swapId);
    } catch (error) {
      options.onError?.(error);
    }
  }

  return summary;
}

/**
 * Warns about swaps inside the expiry margin that still have no secret.
 *
 * Separate from the tick above because it is advisory: it fires while an
 * operator can still intervene, and takes no claim on the swap.
 */
export async function warnOnApproachingExpiry(
  bridges: SwapDisputeBridge[],
  latestLedger: number,
): Promise<number> {
  let sent = 0;
  for (const bridge of bridges) {
    if (bridge.state !== "ACTIVE" || bridge.secretPreimage) continue;
    const countdown = buildSwapDisputeCountdown(bridge.expirationLedger, latestLedger);
    if (!countdown.approachingExpiry) continue;

    await sendSwapExpiryWarningAlert({
      swapId: bridge.swapId,
      initiator: bridge.initiatorAddress,
      counterparty: bridge.counterpartyAddress,
      expirationLedger: bridge.expirationLedger,
      latestLedger,
      estimatedSecondsUntilExpiry: countdown.estimatedSecondsUntilExpiry,
    });
    sent += 1;
  }
  return sent;
}

/** Starts the polling loop. Returns a stop function. */
export function startSwapDisputeWorker(options: SwapDisputeWorkerOptions): () => void {
  // An explicit option wins; otherwise the env override, but only when it
  // parses to a usable positive number — an unset or malformed value must fall
  // through to the default rather than becoming NaN and firing continuously.
  const envInterval = Number(process.env.SWAP_DISPUTE_POLL_INTERVAL_MS);
  const pollIntervalMs =
    options.pollIntervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_SWAP_DISPUTE_POLL_INTERVAL_MS);

  async function tick(): Promise<void> {
    try {
      const summary = await runSwapDisputeTick(options);
      options.onTick?.(summary);
    } catch (error) {
      options.onError?.(error);
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  timer.unref?.();

  // Fire once immediately without blocking startup.
  void tick().catch(() => undefined);

  return () => clearInterval(timer);
}
