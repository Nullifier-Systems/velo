import type { FastifyInstance } from "fastify";
import { ApiError } from "../lib/errors.js";
import { createEnterpriseStore, type EnterpriseStore } from "../lib/enterprise-store.js";

export interface EnterpriseOrgsOptions {
  store?: EnterpriseStore;
}

export async function enterpriseOrgsRoutes(app: FastifyInstance, opts: EnterpriseOrgsOptions = {}) {
  const store = opts.store ?? createEnterpriseStore((app as unknown as { pg?: { query: (...a: unknown[]) => Promise<{ rows: unknown[] }> } }).pg as never);

  app.post("/enterprise/orgs", async (req, reply) => {
    const body = req.body as { name?: string } | undefined;
    if (!body?.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ApiError(400, "MISSING_FIELD", "name is required");
    }
    const tenant = await store.createTenant({ name: body.name.trim() });
    return reply.status(201).send({ data: tenant });
  });

  app.get("/enterprise/orgs", async (_req, reply) => {
    const tenants = await store.listTenants();
    return reply.send({ data: tenants });
  });

  app.get<{ Params: { id: string } }>("/enterprise/orgs/:id", async (req, reply) => {
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) throw new ApiError(404, "NOT_FOUND", "Tenant not found");
    return reply.send({ data: tenant });
  });
}
