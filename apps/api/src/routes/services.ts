import type { FastifyInstance } from "fastify";

/** GET /api/v1/services — free catalog for agent autodiscovery. */
export async function servicesRoutes(app: FastifyInstance) {
  app.get(
    "/services",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async () => ({
      services: [
        { endpoint: "GET /api/v1/cash/agents", price_usdc: "0.001" },
        { endpoint: "POST /api/v1/cash/request", price_usdc: "0.01" },
        { endpoint: "POST /api/v1/cash/request/prepare", price_usdc: "0.01" },
        { endpoint: "POST /api/v1/cash/request/submit", price_usdc: "0.01" },
        { endpoint: "GET /api/v1/reputation/:address", price_usdc: "0.0005" },
      ],
    })
  );
}
