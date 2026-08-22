import type { FastifyInstance } from "fastify";
import { ApiError } from "../lib/errors.js";
import { createEnterpriseStore, type EnterpriseStore } from "../lib/enterprise-store.js";
import { PolicyEvaluator } from "../lib/abac/policy-evaluator.js";
import { AwsKmsDriver } from "../lib/kms/aws-kms-driver.js";
import { GcpKmsDriver } from "../lib/kms/gcp-kms-driver.js";
import { VaultKmsDriver } from "../lib/kms/vault-kms-driver.js";
import type { KmsDriver } from "../lib/kms/kms-driver.interface.js";

export interface EnterpriseApprovalsOptions {
  store?: EnterpriseStore;
  kmsDrivers?: Record<string, KmsDriver>;
  /** Hook for on-chain submission — returns tx hash */
  submitTx?: (payload: { tenantId: string; amountStroops: string }) => Promise<string>;
}

function resolveKmsDriver(provider: string, drivers: Record<string, KmsDriver>): KmsDriver {
  const d = drivers[provider];
  if (!d) throw new ApiError(400, "INVALID_PARAMETER", `Unknown KMS provider: ${provider}`);
  return d;
}

export async function enterpriseApprovalsRoutes(app: FastifyInstance, opts: EnterpriseApprovalsOptions = {}) {
  const store = opts.store ?? createEnterpriseStore((app as unknown as { pg?: never }).pg as never);
  const drivers: Record<string, KmsDriver> = opts.kmsDrivers ?? {
    aws: new AwsKmsDriver(),
    gcp: new GcpKmsDriver(),
    vault: new VaultKmsDriver(),
  };
  const submitTx = opts.submitTx ?? (async () => `tx_${Math.random().toString(16).slice(2)}`);

  // Create dual-approval request
  app.post("/enterprise/approvals", async (req, reply) => {
    const body = req.body as { tenant_id?: string; amount_stroops?: string | number; initiator_id?: string } | undefined;
    if (!body?.tenant_id || body.amount_stroops == null || !body.initiator_id) {
      throw new ApiError(400, "MISSING_FIELD", "tenant_id, amount_stroops, initiator_id are required");
    }
    const tenant = await store.getTenant(body.tenant_id);
    if (!tenant) throw new ApiError(404, "NOT_FOUND", "Tenant not found");
    const approval = await store.createApproval({
      tenantId: body.tenant_id,
      amountStroops: String(body.amount_stroops),
      initiatorId: body.initiator_id,
    });
    return reply.status(201).send({ data: approval });
  });

  app.get("/enterprise/approvals", async (req, reply) => {
    const q = req.query as { tenant_id?: string };
    if (!q.tenant_id) throw new ApiError(400, "MISSING_FIELD", "tenant_id query param required");
    const list = await store.listPendingApprovals(q.tenant_id);
    return reply.send({ data: list });
  });

  /**
   * POST /api/v1/enterprise/approvals/approve — spec route
   * ABAC evaluation + 4-eyes atomic approval + KMS signing -> tx hash
   */
  app.post("/enterprise/approvals/approve", async (req, reply) => {
    const body = req.body as
      | {
          tenant_id?: string;
          approval_id?: string;
          approver_id?: string;
          role?: string;
          kms_provider?: string;
          kms_key_id?: string;
        }
      | undefined;
    if (!body?.tenant_id || !body?.approval_id || !body?.approver_id) {
      throw new ApiError(400, "MISSING_FIELD", "tenant_id, approval_id, approver_id are required");
    }

    // ABAC check if role provided and policies exist
    if (body.role) {
      const evaluator = new PolicyEvaluator({
        async listPolicies(tenantId, role, action) {
          return store.listPolicies(tenantId, role, action);
        },
      });
      const allowed = await evaluator.isAllowed({
        tenantId: body.tenant_id,
        role: body.role,
        action: "approve",
        context: { approver_id: body.approver_id, tenant_id: body.tenant_id },
      });
      // Only enforce if policies exist for this role/action
      const policies = await store.listPolicies(body.tenant_id, body.role, "approve");
      if (policies.length > 0 && !allowed) {
        throw new ApiError(403, "FORBIDDEN", "ABAC policy denies approval");
      }
    }

    // Atomic 4-eyes: initiator != approver, status must be PENDING (single UPDATE .. WHERE .. RETURNING)
    const approved = await store.approveRequest(body.tenant_id, body.approval_id, body.approver_id);
    if (!approved) {
      // Distinguish not-found vs conflict for better DX
      const existing = await store.getApproval(body.tenant_id, body.approval_id);
      if (!existing) throw new ApiError(404, "NOT_FOUND", "Approval request not found");
      if (existing.initiator_id === body.approver_id) throw new ApiError(403, "FORBIDDEN", "Approver cannot be initiator (4-eyes)");
      throw new ApiError(409, "CONFLICT", `Approval not in PENDING state (current: ${existing.status})`);
    }

    // KMS signing — delegate without cleartext key
    let signature: string | undefined;
    if (body.kms_provider && body.kms_key_id) {
      const driver = resolveKmsDriver(body.kms_provider, drivers);
      const res = await driver.sign({ keyId: body.kms_key_id, payloadHex: Buffer.from(approved.id).toString("hex") });
      signature = res.signatureHex;
    }

    // On-chain tx (mockable)
    const txHash = await submitTx({ tenantId: body.tenant_id, amountStroops: approved.amount_stroops });

    return reply.status(200).send({ tx_hash: txHash, txHash, approval: approved, signature });
  });

  // Legacy alias: POST /enterprise/approvals/:id/approve
  app.post<{ Params: { id: string } }>("/enterprise/approvals/:id/approve", async (req, reply) => {
    const body = req.body as { tenant_id?: string; approver_id?: string; role?: string; kms_provider?: string; kms_key_id?: string } | undefined;
    // Reuse by injecting approval_id from path
    (req as unknown as { body: unknown }).body = {
      tenant_id: body?.tenant_id,
      approval_id: req.params.id,
      approver_id: body?.approver_id,
      role: body?.role,
      kms_provider: body?.kms_provider,
      kms_key_id: body?.kms_key_id,
    };
    // Re-dispatch through same handler logic inline
    const b = (req as unknown as { body: { tenant_id?: string; approval_id?: string; approver_id?: string; role?: string; kms_provider?: string; kms_key_id?: string } }).body;
    if (!b?.tenant_id || !b?.approval_id || !b?.approver_id) {
      throw new ApiError(400, "MISSING_FIELD", "tenant_id, approver_id are required");
    }
    if (b.role) {
      const evaluator = new PolicyEvaluator({
        async listPolicies(tenantId, role, action) {
          return store.listPolicies(tenantId, role, action);
        },
      });
      const policies = await store.listPolicies(b.tenant_id, b.role, "approve");
      if (policies.length > 0) {
        const allowed = await evaluator.isAllowed({
          tenantId: b.tenant_id,
          role: b.role,
          action: "approve",
          context: { approver_id: b.approver_id, tenant_id: b.tenant_id },
        });
        if (!allowed) throw new ApiError(403, "FORBIDDEN", "ABAC policy denies approval");
      }
    }
    const approved = await store.approveRequest(b.tenant_id, b.approval_id, b.approver_id);
    if (!approved) {
      const existing = await store.getApproval(b.tenant_id, b.approval_id);
      if (!existing) throw new ApiError(404, "NOT_FOUND", "Approval request not found");
      if (existing.initiator_id === b.approver_id) throw new ApiError(403, "FORBIDDEN", "Approver cannot be initiator (4-eyes)");
      throw new ApiError(409, "CONFLICT", `Approval not in PENDING state (current: ${existing.status})`);
    }
    let signature: string | undefined;
    if (b.kms_provider && b.kms_key_id) {
      const driver = resolveKmsDriver(b.kms_provider, drivers);
      const res = await driver.sign({ keyId: b.kms_key_id, payloadHex: Buffer.from(approved.id).toString("hex") });
      signature = res.signatureHex;
    }
    const txHash = await submitTx({ tenantId: b.tenant_id, amountStroops: approved.amount_stroops });
    return reply.status(200).send({ tx_hash: txHash, txHash, approval: approved, signature });
  });
}
