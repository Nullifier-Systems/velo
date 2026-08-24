/**
 * ABAC policy evaluator — loads tenant+role+action policies and checks context (#401).
 * Always includes WHERE tenant_id = $1 (multi-tenant rule).
 */

import type { AbacPolicy } from "@velo/shared";
import { evaluateExpression, assertValidExpression, type EvalContext } from "./policy-engine.js";

export interface PolicyStore {
  listPolicies(tenantId: string, role: string, action: string): Promise<AbacPolicy[]>;
}

export interface EvaluateRequest {
  tenantId: string;
  role: string;
  action: string;
  context: EvalContext;
}

export class PolicyEvaluator {
  constructor(private readonly store: PolicyStore) {}

  /**
   * Returns true if at least one policy for (tenant,role,action) evaluates to true.
   * Deny-by-default: no matching policy => false.
   */
  async isAllowed(req: EvaluateRequest): Promise<boolean> {
    const policies = await this.store.listPolicies(req.tenantId, req.role, req.action);
    if (policies.length === 0) return false;
    for (const p of policies) {
      assertValidExpression(p.expression);
      if (evaluateExpression(p.expression, req.context)) return true;
    }
    return false;
  }

  /** Pg-backed store — enforces WHERE tenant_id = $1 */
  static pgStore(pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): PolicyStore {
    return {
      async listPolicies(tenantId, role, action) {
        const { rows } = await pool.query(
          `SELECT id, tenant_id, role, action, expression, created_at
           FROM abac_policies
           WHERE tenant_id = $1 AND role = $2 AND action = $3`,
          [tenantId, role, action],
        );
        return rows as AbacPolicy[];
      },
    };
  }

  /** In-memory store for tests / local dev */
  static memoryStore(policies: AbacPolicy[]): PolicyStore {
    return {
      async listPolicies(tenantId, role, action) {
        return policies.filter((p) => p.tenant_id === tenantId && p.role === role && p.action === action);
      },
    };
  }
}
