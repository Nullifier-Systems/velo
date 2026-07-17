import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../lib/admin-auth.js";
import { getStoreStats } from "../lib/store.js";
import { getFraudFlags } from "../lib/fraud-detection.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/status", async (req, reply) => {
    if (!requireAdminAuth(req, reply)) return;

    return {
      ok: true,
      version: "0.1.0",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      store: getStoreStats(),
    };
  });

  /**
   * GET /api/v1/admin/fraud-flags
   *
   * Returns all cash requests that have been flagged as suspicious.
   * Requests are flagged but never blocked — investigate before taking action.
   *
   * Requires: Authorization: Bearer <ADMIN_API_KEY>
   *
   * Response shape:
   *   { total: number, flags: FraudFlag[] }
   *
   * FraudFlag fields:
   *   tradeId        — the trade ID of the flagged request
   *   buyer          — Stellar address of the buyer
   *   seller         — Stellar address of the seller
   *   amountStroops  — raw stroop amount (string)
   *   reasons        — human-readable list of triggered signals
   *   windowCount    — number of requests seen from this buyer in the window
   *   flaggedAt      — ISO-8601 timestamp of when the flag was raised
   */
  app.get("/admin/fraud-flags", async (req, reply) => {
    if (!requireAdminAuth(req, reply)) return;

    const flags = getFraudFlags();
    return {
      total: flags.length,
      flags,
    };
  });
}
