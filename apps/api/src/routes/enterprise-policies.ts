import type { FastifyInstance } from "fastify";
import { ApiError } from "../lib/errors.js";
import { createEnterpriseStore, type EnterpriseStore } from "../lib/enterprise-store.js";
import { assertValidExpression } from "../lib/abac/policy-engine.js";
import { PolicyEvaluator } from "../lib/abac/policy-evaluator.js";

export interface EnterprisePoliciesOptions {
  store?: EnterpriseStore;
}

export async function enterprisePoliciesRoutes(app: FastifyInstance, opts: EnterprisePoliciesOptions = {}) {
  const store = opts.store ?? createEnterpriseStore((app as unknown as { pg?: never }).pg as never);

  app.post("/enterprise/policies", async (req, reply) => {
    const body = req.body as { tenant_id?: string; role?: string; action?: string; expression?: unknown } | undefined;
    if (!body?.tenant_id || !body?.role || !body?.action || !body?.expression) {
      throw new ApiError(400, "MISSING_FIELD", "tenant_id, role, action, expression are required");
    }
    // Multi-tenant guard: tenant must exist
    const tenant = await store.getTenant(body.tenant_id);
    if (!tenant) throw new ApiError(404, "NOT_FOUND", "Tenant not found");
    try {
      assertValidExpression(body.expression);
    } catch (e) {
      throw new ApiError(400, "INVALID_PARAMETER", String(e));
    }
    const policy = await store.createPolicy({
      tenantId: body.tenant_id,
      role: body.role,
      action: body.action,
      expression: body.expression as never,
    });
    return reply.status(201).send({ data: policy });
  });

  app.get("/enterprise/policies", async (req, reply) => {
    const q = req.query as { tenant_id?: string; role?: string; action?: string };
    if (!q.tenant_id) throw new ApiError(400, "MISSING_FIELD", "tenant_id query param required");
    const policies = await store.listPolicies(q.tenant_id, q.role, q.action);
    return reply.send({ data: policies });
  });

  app.post("/enterprise/policies/evaluate", async (req, reply) => {
    const body = req.body as { tenant_id?: string; role?: string; action?: string; context?: Record<string, unknown> } | undefined;
    if (!body?.tenant_id || !body?.role || !body?.action) {
      throw new ApiError(400, "MISSING_FIELD", "tenant_id, role, action are required");
    }
    const evaluator = new PolicyEvaluator({
      async listPolicies(tenantId, role, action) {
        return store.listPolicies(tenantId, role, action);
      },
    });
    const allowed = await evaluator.isAllowed({
      tenantId: body.tenant_id,
      role: body.role,
      action: body.action,
      context: body.context ?? {},
    });
    return reply.send({ allowed });
  });
}
