import type { FastifyInstance } from "fastify";
import { getProviderTrades } from "../lib/store.js";

/**
 * GET /api/v1/export/trades?format=csv|json
 *
 * Exports the authenticated provider's completed trade history as CSV or JSON.
 * Uses x-provider-address header for authentication (same pattern as provider.ts).
 */
export async function exportRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { format?: string } }>(
    "/export/trades",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const providerAddress = req.headers["x-provider-address"];
      if (!providerAddress || typeof providerAddress !== "string") {
        reply.code(401).send({ error: "Unauthorized: Missing x-provider-address header" });
        return;
      }

      const format = (req.query.format ?? "json").toLowerCase();
      if (format !== "csv" && format !== "json") {
        reply.code(400).send({ error: "Invalid format. Use 'csv' or 'json'." });
        return;
      }

      const trades = getProviderTrades(providerAddress);
      const completedTrades = trades.filter(t => t.status === "released");

      if (format === "json") {
        reply.header("Content-Type", "application/json");
        reply.header(
          "Content-Disposition",
          `attachment; filename="trades-${providerAddress.slice(0, 8)}.json"`
        );
        return reply.send(
          completedTrades.map(t => ({
            id: t.id,
            contract_id: t.contractId,
            seller: t.seller,
            buyer: t.buyer,
            amount_stroops: t.amountStroops,
            status: t.status,
            created_at: t.createdAt,
          }))
        );
      }

      // CSV format
      const header = "id,contract_id,seller,buyer,amount_stroops,status,created_at";
      const rows = completedTrades.map(t =>
        [
          t.id,
          t.contractId,
          t.seller,
          t.buyer,
          t.amountStroops,
          t.status,
          t.createdAt,
        ].join(",")
      );
      const csv = [header, ...rows].join("\n");

      reply.header("Content-Type", "text/csv");
      reply.header(
        "Content-Disposition",
        `attachment; filename="trades-${providerAddress.slice(0, 8)}.csv"`
      );
      return reply.send(csv);
    }
  );
}
