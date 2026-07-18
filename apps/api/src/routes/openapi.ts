import type { FastifyInstance } from "fastify";
import { openApiDocument } from "../openapi.js";

/** GET /api/v1/openapi.json — free machine-readable API specification. */
export async function openapiRoutes(app: FastifyInstance) {
  app.get(
    "/openapi.json",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async () => openApiDocument
  );
}
