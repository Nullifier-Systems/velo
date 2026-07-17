import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../lib/admin-auth.js";
import { getStoreStats } from "../lib/store.js";

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
}
