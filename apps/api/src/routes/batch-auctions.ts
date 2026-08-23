import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { verifyReveal } from "../lib/batch-auction-engine.js";
import {
  addCommittedOrder,
  createRound,
  getCommittedOrder,
  getCurrentCommitRound,
  getLatestRound,
  getRound,
  markRevealed,
} from "../lib/encrypted-order-store.js";

/**
 * Batch auction commit-reveal endpoints (#403).
 *
 *   POST /api/v1/auctions/commit — store an opaque order commitment hash +
 *     deposit against the currently-open COMMIT round.
 *   POST /api/v1/auctions/reveal — reveal a previously committed order's
 *     real parameters; rejected unless they hash to the original commitment.
 *   GET  /api/v1/auctions/state  — current round phase + last clearing price,
 *     for the frontend's phase timer.
 */
export const CommitOrderSchema = z.object({
  roundId: z.string().optional(),
  commitHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "commitHash must be a 64-char hex SHA-256 digest"),
  depositAmountStroops: z.string().regex(/^[0-9]+$/, "depositAmountStroops must be a positive integer string"),
});

export const RevealOrderSchema = z.object({
  orderId: z.string().uuid(),
  roundId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  rateStroops: z.string().regex(/^[0-9]+$/),
  amountStroops: z.string().regex(/^[0-9]+$/),
  saltHex: z.string().regex(/^[0-9a-f]+$/i),
});

export interface BatchAuctionRoutesOptions {
  /** COMMIT phase length in ms — overridable in tests. */
  commitMs?: number;
  /** REVEAL phase length in ms — overridable in tests. */
  revealMs?: number;
}

export async function batchAuctionRoutes(app: FastifyInstance, opts: BatchAuctionRoutesOptions = {}) {
  const commitMs = opts.commitMs ?? 10_000;
  const revealMs = opts.revealMs ?? 10_000;

  app.post("/auctions/commit", async (req, reply) => {
    const parsed = CommitOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", {
        detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    const { commitHash, depositAmountStroops } = parsed.data;

    const round = getCurrentCommitRound() ?? createRound({ commitMs, revealMs });
    if (round.phase !== "COMMIT") {
      throw new ApiError(409, "COMMIT_PHASE_CLOSED", "The current round is no longer accepting commitments.");
    }

    const order = addCommittedOrder({ roundId: round.roundId, commitHash, depositAmountStroops });
    return reply.status(201).send({
      status: "success",
      data: { orderId: order.orderId, roundId: round.roundId, phase: round.phase },
    });
  });

  app.post("/auctions/reveal", async (req, reply) => {
    const parsed = RevealOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", {
        detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    const reveal = parsed.data;

    const round = getRound(reveal.roundId);
    if (!round) {
      throw new ApiError(404, "NOT_FOUND", "Unknown round.");
    }
    if (round.phase !== "REVEAL") {
      throw new ApiError(409, "REVEAL_PHASE_CLOSED", "The round is not currently accepting reveals.");
    }

    const order = getCommittedOrder(reveal.roundId, reveal.orderId);
    if (!order) {
      throw new ApiError(404, "NOT_FOUND", "No commitment found for this order in this round.");
    }
    if (order.revealed) {
      throw new ApiError(409, "ALREADY_REVEALED", "This order has already been revealed.");
    }
    if (!verifyReveal(order.commitHash, reveal)) {
      throw new ApiError(400, "COMMIT_MISMATCH", "Revealed parameters do not match the original commitment hash.");
    }

    markRevealed(reveal.roundId, reveal.orderId, reveal);
    return reply.status(200).send({ status: "success", data: { orderId: reveal.orderId, roundId: reveal.roundId } });
  });

  app.get("/auctions/state", async (_req, reply) => {
    const round = getLatestRound() ?? createRound({ commitMs, revealMs });
    return reply.status(200).send({
      status: "success",
      data: {
        roundId: round.roundId,
        phase: round.phase,
        commitDeadline: round.commitDeadline,
        revealDeadline: round.revealDeadline,
        clearingPriceStroops: round.clearingPriceStroops,
      },
    });
  });
}
