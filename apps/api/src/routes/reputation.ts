import type { FastifyInstance } from "fastify";
import { ApiError } from "../lib/errors.js";
import {
  getCachedReputation,
  setCachedReputation,
} from "../lib/reputation-cache.js";
import { getReputationMetrics } from "../lib/store.js";

/** Stellar account (G…) — 56 chars, base32 alphabet excluding 0/O/I/L. */
const STELLAR_G_ADDRESS = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;

/** GET /api/v1/reputation/:address — on-chain trust signal ($0.0005) */
export async function reputationRoutes(app: FastifyInstance) {
  app.get(
    "/reputation/:address",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.0005");
      if (!paid) return;

      const { address } = req.params as { address: string };
      if (!STELLAR_G_ADDRESS.test(address)) {
        throw new ApiError(
          400,
          "INVALID_PARAMETER",
          "Invalid Stellar address: expected a 56-character G-address",
        );
      }

      const cached = await getCachedReputation(address);
      if (cached) {
        return { ...cached, cached: true };
      }

      const metrics = getReputationMetrics(address);
      const payload = { address, ...metrics };
      await setCachedReputation(payload);
      return { ...payload, cached: false };
    },
  );
}
