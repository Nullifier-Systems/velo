import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRateReference, RateReference } from "../lib/rates.js";

const getRatesSchema = z.object({
  pair: z.enum(["usdc_xlm", "usdc_usd", "xlm_usd"]).optional(),
});

const getHistorySchema = z.object({
  pair: z.enum(["usdc_xlm", "usdc_usd", "xlm_usd"]),
  period: z.enum(["1h", "6h", "24h", "7d"]).default("24h"),
});

export async function ratesRoutes(app: FastifyInstance) {
  // Get current reference rates
  app.get<{ Querystring: z.infer<typeof getRatesSchema> }>(
    "/rates/reference",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      try {
        const rates = await getRateReference();
        
        // If specific pair requested, return only that pair
        const { pair } = req.query;
        if (pair) {
          const pairData = rates[pair as keyof RateReference];
          if (!pairData) {
            reply.code(400).send({ error: `Invalid pair: ${pair}` });
            return;
          }
          return {
            timestamp: rates.timestamp,
            [pair]: pairData,
          };
        }

        return rates;
      } catch (error) {
        req.log.error(error, "failed to fetch rate reference");
        reply.code(502).send({
          error: "failed to fetch rate reference",
          detail: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  );

  // Get historical rate data (placeholder - would require database)
  app.get<{ Querystring: z.infer<typeof getHistorySchema> }>(
    "/rates/history",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const { pair, period } = req.query;

      // TODO: Implement historical rate storage and retrieval
      // For now, return current rate as a single data point
      try {
        const rates = await getRateReference();
        const pairData = rates[pair as keyof RateReference];
        
        if (!pairData || typeof pairData === "string") {
          reply.code(400).send({ error: `Invalid pair: ${pair}` });
          return;
        }

        // Return mock historical data for demonstration
        const now = new Date();
        const historyPoints = period === "1h" ? 12 : period === "6h" ? 72 : period === "24h" ? 288 : 2016;
        
        const history = Array.from({ length: historyPoints }, (_, i) => ({
          timestamp: new Date(now.getTime() - (i * (period === "1h" ? 5 * 60 * 1000 : period === "6h" ? 5 * 60 * 1000 : period === "24h" ? 5 * 60 * 1000 : 5 * 60 * 1000))).toISOString(),
          rate: pairData.reconciled_rate * (1 + (Math.random() - 0.5) * 0.02), // ±1% variation
          confidence_score: pairData.confidence_score,
        })).reverse();

        return {
          pair,
          period,
          current: pairData,
          history,
        };
      } catch (error) {
        req.log.error(error, "failed to fetch rate history");
        reply.code(502).send({
          error: "failed to fetch rate history",
          detail: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  );

  // Health check for rate sources
  app.get("/rates/health", async (req, reply) => {
    try {
      const rates = await getRateReference();
      
      const health = {
        timestamp: new Date().toISOString(),
        sources: {
          stellar_dex: {
            available: rates.usdc_xlm.sources.some(s => s.name === "stellar_dex"),
            confidence: rates.usdc_xlm.sources.find(s => s.name === "stellar_dex")?.confidence || 0,
          },
          coingecko: {
            available: rates.usdc_xlm.sources.some(s => s.name === "coingecko"),
            confidence: rates.usdc_xlm.sources.find(s => s.name === "coingecko")?.confidence || 0,
          },
        },
        overall_confidence: {
          usdc_xlm: rates.usdc_xlm.confidence_score,
          usdc_usd: rates.usdc_usd.confidence_score,
          xlm_usd: rates.xlm_usd.confidence_score,
        },
        deviation_warnings: {
          usdc_xlm: rates.usdc_xlm.deviation_warning,
          usdc_usd: rates.usdc_usd.deviation_warning,
          xlm_usd: rates.xlm_usd.deviation_warning,
        },
      };

      return health;
    } catch (error) {
      req.log.error(error, "failed to check rates health");
      reply.code(502).send({
        error: "failed to check rates health",
        detail: String(error),
      });
    }
  });
}
