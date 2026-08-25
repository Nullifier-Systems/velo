import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pgPool } from "../app.js";
import { getLatestLedgerSequence, submitRefundTx } from "../lib/stellar.js";
import { getCashRequest, updateStatus } from "../lib/store.js";
import { CONTRACTS } from "@velo/shared";
import { createClient } from "redis";

export const TriggerTrancheRefundSchema = z.object({
  tradeId: z.string().length(64, "Trade ID must be a 64-character hex string"),
});

export const trancheRefundRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/tranche-refund/trigger", async (req, reply) => {
    try {
      const parsed = TriggerTrancheRefundSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
      }

      const { tradeId } = parsed.data;

      if (!pgPool) {
         return reply.status(500).send({ error: "DATABASE_NOT_CONFIGURED" });
      }

      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");

        const result = await client.query(
          `SELECT trade_id, unreleased_tranches, unreleased_amount, status, timeout_ledger_sequence 
           FROM tranche_refund_schedules 
           WHERE trade_id = $1 
           FOR UPDATE`,
          [tradeId]
        );

        if (result.rowCount === 0) {
          await client.query("ROLLBACK");
          return reply.status(404).send({ error: "NOT_FOUND", message: "Trade schedule not found." });
        }

        const schedule = result.rows[0];

        if (schedule.status === 'REFUND_EXECUTED' || schedule.status === 'CANCELLED') {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: {
              code: "TRANCHE_ALREADY_SETTLED",
              message: "Tranche trade has already been fully released or refunded.",
              requestId: req.id
            }
          });
        }

        const currentLedger = await getLatestLedgerSequence();
        if (currentLedger <= schedule.timeout_ledger_sequence) {
          await client.query("ROLLBACK");
          return reply.status(400).send({
            error: {
              code: "TIMEOUT_NOT_REACHED",
              message: "Current Stellar ledger height has not reached the expiration threshold.",
              requestId: req.id
            }
          });
        }

        // Update DB
        await client.query(
          `UPDATE tranche_refund_schedules SET status = 'REFUND_EXECUTED', updated_at = CURRENT_TIMESTAMP WHERE trade_id = $1`,
          [tradeId]
        );

        // Update in-memory store
        const trade = getCashRequest(tradeId);
        if (trade) {
          updateStatus(tradeId, "refunded");
        }

        await client.query("COMMIT");

        // Async Relayer Offload
        const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
        const redis = createClient({ url: redisUrl });
        await redis.connect();
        
        await redis.xAdd('velo:tranche-refund-queue', '*', { tradeId });
        await redis.quit();

        return reply.status(200).send({
          tradeId,
          refundedAmount: schedule.unreleased_amount,
          refundedTranches: schedule.unreleased_tranches,
          status: 'REFUND_EXECUTED'
        });

      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      req.log.error(err, "Tranche refund trigger failed");
      return reply.status(500).send({ error: "INTERNAL_SERVER_ERROR" });
    }
  });
};
