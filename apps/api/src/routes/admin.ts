import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { refundEscrow, submitRefundTx, buildRefundTx } from "../lib/stellar.js";
import { getCashRequest, updateStatus, getStoreStats } from "../lib/store.js";
import { notifyTradeStatus } from "./chat.js";
import { z } from "zod";
import { parseBody } from "../lib/validation.js";

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const adminKey = req.headers["x-admin-api-key"];
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      req.log.error("ADMIN_API_KEY env variable is not set!");
      return reply.status(500).send({ error: "Admin environment configuration error." });
    }

    if (!adminKey || adminKey !== expectedKey) {
      return reply.status(401).send({ error: "Unauthorized access to internal ops endpoints." });
    }
  });

  /**
   * GET /admin/stats — store-level statistics (in-memory replacement for DB query).
   */
  app.get("/admin/stats", async (_req, reply) => {
    return reply.status(200).send(getStoreStats());
  });

  /**
   * POST /admin/trades/:id/refund — manually trigger a refund for a stuck trade.
   */
  app.post<{ Params: { id: string }; Body: { signed_xdr?: string } }>(
    "/admin/trades/:id/refund",
    async (req, reply) => {
      const { id } = req.params;
      const operatorName = req.headers["x-admin-operator-name"] || "System Admin";

      const record = getCashRequest(id);
      if (!record) {
        return reply.status(404).send({ error: "Trade request not found." });
      }

      if (record.status !== "locked") {
        return reply.status(400).send({
          error: `Cannot refund. Only locked trades can be refunded. Current status is '${record.status}'.`,
        });
      }

      try {
        req.log.warn(`Manual refund initiated for trade ID ${id} by ${operatorName}`);

        if (req.body?.signed_xdr) {
          await submitRefundTx(req.body.signed_xdr);
        } else {
          await refundEscrow({
            contractId: record.contractId,
            tradeId: record.id,
          });
        }
      } catch (err) {
        req.log.error(err, "refund on-chain call failed during admin override");
        return reply.status(502).send({
          error: "On-chain refund execution failed",
          detail: String(err),
        });
      }

      updateStatus(id, "refunded");
      notifyTradeStatus(id, "refunded");

      return reply.status(200).send({
        status: "success",
        message: "Manual refund processed successfully.",
        trade_id: id,
        new_status: "refunded",
      });
    }
  );
}
