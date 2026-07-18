import type { FastifyInstance } from "fastify";

/** GET /api/v1/status — public health check and recent activity. */
export async function statusRoutes(app: FastifyInstance) {
  app.get(
    "/status",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async () => {
      const uptime = process.uptime();
      const version = process.env.npm_package_version ?? "0.1.0";
      const network = process.env.STELLAR_NETWORK ?? "testnet";

      return {
        status: "ok",
        uptime,
        timestamp: new Date().toISOString(),
        version,
        network,
        recentActivity: [],
      };
    }
  );
}
