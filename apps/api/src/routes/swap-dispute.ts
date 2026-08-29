/**
 * Cross-Ledger Settlement Time-Lock Atomic Swap Dispute Bridge — HTTP surface.
 *
 * A cross-chain swap has two legs on two chains. If the counterparty reveals
 * on their leg and stalls on ours — or simply vanishes — the honest party's
 * funds sit locked until the timeout with no automated way out. These routes
 * are that way out:
 *
 *   POST /swaps/dispute-claim   — settle with an extracted secret, or claim an
 *                                 automated refund once the leg has expired
 *   GET  /swaps/dispute/:swapId — current bridge state and expiry countdown
 *
 * Concurrency: the worker and an operator can hit the same swap in the same
 * moment. Every state transition goes through `SwapDisputeStore` under
 * `SELECT ... FOR UPDATE`, so a refund is claimed exactly once no matter how
 * many callers race (tests/concurrency/swap_dispute_stress.test.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../lib/validation.js";
import { ApiError, ErrorCode } from "../lib/errors.js";
import {
  InvalidPreimageError,
  SwapDisputeNotFoundError,
  SwapDisputeStore,
  type SwapDisputeBridge,
} from "../lib/swapDisputeStore.js";
import { buildSwapDisputeCountdown } from "../lib/timeouts.js";
import { getLatestLedgerSequence } from "../lib/stellar.js";
import {
  sendSwapRefundClaimedAlert,
  sendSwapSecretExtractedAlert,
} from "../lib/webhook.js";

const HEX_64 = /^[0-9a-fA-F]{64}$/;

const disputeClaimSchema = z.object({
  swap_id: z.string().min(1).max(64),
  /**
   * Optional: a preimage the caller has observed on the counterpart chain.
   * When present the swap settles instead of refunding — a swap whose secret
   * is known must never be refunded, or the counterparty could still use that
   * preimage to take the other leg after we handed the funds back.
   */
  secret_preimage: z.string().regex(HEX_64, "secret_preimage must be 32 hex bytes").optional(),
});

export interface SwapDisputeRouteOptions {
  store?: SwapDisputeStore;
  /** Injectable for tests; defaults to the live chain tip. */
  getLedger?: () => Promise<number>;
}

function serializeBridge(bridge: SwapDisputeBridge, latestLedger: number) {
  const countdown = buildSwapDisputeCountdown(bridge.expirationLedger, latestLedger);
  return {
    swap_id: bridge.swapId,
    initiator_address: bridge.initiatorAddress,
    counterparty_address: bridge.counterpartyAddress,
    secret_hash: bridge.secretHash,
    // The preimage itself is returned only once extracted; it is not a secret
    // at that point (it is on-chain), and the counterpart leg needs it.
    secret_preimage: bridge.secretPreimage,
    expiration_ledger: bridge.expirationLedger,
    state: bridge.state,
    countdown,
  };
}

export async function swapDisputeRoutes(
  app: FastifyInstance,
  opts: SwapDisputeRouteOptions = {},
) {
  const store = opts.store ?? new SwapDisputeStore();
  // Wrapped rather than referenced directly: registration must not touch the
  // stellar module's exports, so suites that partially mock it (app.test.ts)
  // can still build the app without stubbing every ledger helper.
  const getLedger = opts.getLedger ?? (() => getLatestLedgerSequence());

  app.get<{ Params: { swapId: string } }>("/swaps/dispute/:swapId", async (req) => {
    const bridge = await store.getBridge(req.params.swapId);
    if (!bridge) {
      throw new ApiError(404, ErrorCode.NOT_FOUND, "Swap dispute bridge not found");
    }
    return serializeBridge(bridge, await getLedger());
  });

  /**
   * Resolves a stalled swap one of two ways, and never both:
   *
   *   * a preimage was supplied or already extracted → settle with it;
   *   * the leg has expired with no preimage anywhere → claim the refund.
   *
   * Returns 200 with the resulting bridge state as execution proof. A caller
   * that lost the race gets 409 rather than a second on-chain submission.
   */
  app.post("/swaps/dispute-claim", async (req, reply) => {
    const body = parseBody(disputeClaimSchema, req.body, reply);
    if (!body) return reply;

    const latestLedger = await getLedger();

    let bridge: SwapDisputeBridge;
    try {
      const existing = await store.getBridge(body.swap_id);
      if (!existing) {
        throw new ApiError(404, ErrorCode.NOT_FOUND, "Swap dispute bridge not found");
      }
      bridge = existing;

      // --- Settlement path: a secret exists or was just handed to us --------
      const preimage = body.secret_preimage ?? bridge.secretPreimage;
      if (preimage) {
        const result = await store.recordSecret(body.swap_id, preimage);
        if (result.claimedForSettlement) {
          await sendSwapSecretExtractedAlert({
            swapId: result.bridge.swapId,
            secretHash: result.bridge.secretHash,
            initiator: result.bridge.initiatorAddress,
            counterparty: result.bridge.counterpartyAddress,
            extractedAtLedger: latestLedger,
            expirationLedger: result.bridge.expirationLedger,
          });
        }
        return reply.code(200).send({
          outcome: "secret_extracted",
          claimed: result.claimedForSettlement,
          ...serializeBridge(result.bridge, latestLedger),
        });
      }

      // --- Refund path: expired with no secret anywhere ---------------------
      const claim = await store.claimRefund(body.swap_id, latestLedger);
      if (!claim.claimedForRefund) {
        // Every refusal is a state conflict — asking too early, losing the
        // race, or a swap that already settled. The message distinguishes
        // them; the status code does not need to.
        throw new ApiError(
          409,
          ErrorCode.WRONG_STATUS,
          refusalMessage(claim.reason, claim.bridge, latestLedger),
        );
      }

      await sendSwapRefundClaimedAlert({
        swapId: claim.bridge.swapId,
        initiator: claim.bridge.initiatorAddress,
        counterparty: claim.bridge.counterpartyAddress,
        expirationLedger: claim.bridge.expirationLedger,
        latestLedger,
      });

      return reply.code(200).send({
        outcome: "refund_claimed",
        claimed: true,
        ...serializeBridge(claim.bridge, latestLedger),
      });
    } catch (error) {
      if (error instanceof SwapDisputeNotFoundError) {
        throw new ApiError(404, ErrorCode.NOT_FOUND, error.message);
      }
      if (error instanceof InvalidPreimageError) {
        throw new ApiError(400, ErrorCode.VALIDATION_ERROR, error.message);
      }
      throw error;
    }
  });
}

/** Human-readable explanation for a refused refund claim. */
function refusalMessage(
  reason: "claimed" | "not_expired" | "secret_already_extracted" | "resolved" | null,
  bridge: SwapDisputeBridge,
  latestLedger: number,
): string {
  switch (reason) {
    case "not_expired":
      return `Swap has not expired yet: ${bridge.expirationLedger - latestLedger} ledger(s) remaining`;
    case "secret_already_extracted":
      return "Swap secret was already extracted; settle with the preimage instead of refunding";
    case "resolved":
      return "Swap is already resolved";
    case "claimed":
    default:
      return "Refund has already been claimed for this swap";
  }
}
