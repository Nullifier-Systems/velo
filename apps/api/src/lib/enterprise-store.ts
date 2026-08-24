/**
 * Enterprise multi-tenant store (#401) — pg + in-memory dual impl.
 * ALWAYS includes WHERE tenant_id = $1. Dual-approval uses atomic
 * UPDATE ... WHERE status='PENDING' AND initiator_id != $approver.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Tenant, AbacPolicy, DualApprovalRequest } from "@velo/shared";

export interface CreateTenantInput {
  name: string;
}

export interface CreatePolicyInput {
  tenantId: string;
  role: string;
  action: string;
  expression: AbacPolicy["expression"];
}

export interface CreateApprovalInput {
  tenantId: string;
  amountStroops: bigint | string;
  initiatorId: string;
}

export interface EnterpriseStore {
  // tenants
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  // policies
  createPolicy(input: CreatePolicyInput): Promise<AbacPolicy>;
  listPolicies(tenantId: string, role?: string, action?: string): Promise<AbacPolicy[]>;
  // dual approvals
  createApproval(input: CreateApprovalInput): Promise<DualApprovalRequest>;
  getApproval(tenantId: string, id: string): Promise<DualApprovalRequest | null>;
  listPendingApprovals(tenantId: string): Promise<DualApprovalRequest[]>;
  approveRequest(tenantId: string, id: string, approverId: string): Promise<DualApprovalRequest | null>;
  expireStaleApprovals(now?: Date): Promise<number>;
}

/* ---------- Postgres ---------- */

function rowToTenant(r: Record<string, unknown>): Tenant {
  return { id: r.id as string, name: r.name as string, created_at: (r.created_at as string) ?? new Date().toISOString() };
}
function rowToPolicy(r: Record<string, unknown>): AbacPolicy {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    role: r.role as string,
    action: r.action as string,
    expression: r.expression as AbacPolicy["expression"],
    created_at: r.created_at as string | undefined,
  };
}
function rowToApproval(r: Record<string, unknown>): DualApprovalRequest {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    amount_stroops: String(r.amount_stroops),
    amountStroops: String(r.amount_stroops),
    initiator_id: r.initiator_id as string,
    approver_id: (r.approver_id as string) ?? null,
    status: r.status as DualApprovalRequest["status"],
    created_at: (r.created_at as string) ?? new Date().toISOString(),
    updated_at: r.updated_at as string | undefined,
    expires_at: r.expires_at as string | undefined,
  };
}

export class PgEnterpriseStore implements EnterpriseStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    const { rows } = await this.pool.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at`, [input.name]);
    return rowToTenant(rows[0] as Record<string, unknown>);
  }
  async getTenant(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(`SELECT id, name, created_at FROM tenants WHERE id = $1`, [id]);
    return rows[0] ? rowToTenant(rows[0] as Record<string, unknown>) : null;
  }
  async listTenants(): Promise<Tenant[]> {
    const { rows } = await this.pool.query(`SELECT id, name, created_at FROM tenants ORDER BY created_at DESC`);
    return rows.map((r) => rowToTenant(r as Record<string, unknown>));
  }

  async createPolicy(input: CreatePolicyInput): Promise<AbacPolicy> {
    const { rows } = await this.pool.query(
      `INSERT INTO abac_policies (tenant_id, role, action, expression) VALUES ($1,$2,$3,$4) RETURNING id, tenant_id, role, action, expression, created_at`,
      [input.tenantId, input.role, input.action, JSON.stringify(input.expression)],
    );
    return rowToPolicy(rows[0] as Record<string, unknown>);
  }
  async listPolicies(tenantId: string, role?: string, action?: string): Promise<AbacPolicy[]> {
    let q = `SELECT id, tenant_id, role, action, expression, created_at FROM abac_policies WHERE tenant_id = $1`;
    const vals: unknown[] = [tenantId];
    if (role) {
      vals.push(role);
      q += ` AND role = $${vals.length}`;
    }
    if (action) {
      vals.push(action);
      q += ` AND action = $${vals.length}`;
    }
    q += ` ORDER BY created_at DESC`;
    const { rows } = await this.pool.query(q, vals);
    return rows.map((r) => rowToPolicy(r as Record<string, unknown>));
  }

  async createApproval(input: CreateApprovalInput): Promise<DualApprovalRequest> {
    const { rows } = await this.pool.query(
      `INSERT INTO dual_approval_requests (tenant_id, amount_stroops, initiator_id) VALUES ($1,$2,$3) RETURNING id, tenant_id, amount_stroops, initiator_id, approver_id, status, created_at, updated_at, expires_at`,
      [input.tenantId, String(input.amountStroops), input.initiatorId],
    );
    return rowToApproval(rows[0] as Record<string, unknown>);
  }
  async getApproval(tenantId: string, id: string): Promise<DualApprovalRequest | null> {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, amount_stroops, initiator_id, approver_id, status, created_at, updated_at, expires_at FROM dual_approval_requests WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? rowToApproval(rows[0] as Record<string, unknown>) : null;
  }
  async listPendingApprovals(tenantId: string): Promise<DualApprovalRequest[]> {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, amount_stroops, initiator_id, approver_id, status, created_at, updated_at, expires_at FROM dual_approval_requests WHERE tenant_id = $1 AND status = 'PENDING' ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows.map((r) => rowToApproval(r as Record<string, unknown>));
  }
  async approveRequest(tenantId: string, id: string, approverId: string): Promise<DualApprovalRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE dual_approval_requests SET status='APPROVED', approver_id=$3, updated_at=NOW()
       WHERE id=$2 AND tenant_id=$1 AND status='PENDING' AND initiator_id != $3 RETURNING id, tenant_id, amount_stroops, initiator_id, approver_id, status, created_at, updated_at, expires_at`,
      [tenantId, id, approverId],
    );
    return rows[0] ? rowToApproval(rows[0] as Record<string, unknown>) : null;
  }
  async expireStaleApprovals(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE dual_approval_requests SET status='EXPIRED', updated_at=NOW() WHERE status='PENDING' AND expires_at < NOW()`,
    );
    return rowCount ?? 0;
  }
}

/* ---------- In-memory ---------- */

export class MemoryEnterpriseStore implements EnterpriseStore {
  tenants = new Map<string, Tenant>();
  policies: AbacPolicy[] = [];
  approvals = new Map<string, DualApprovalRequest>();

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    const t: Tenant = { id: randomUUID(), name: input.name, created_at: new Date().toISOString() };
    this.tenants.set(t.id, t);
    return t;
  }
  async getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }
  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async createPolicy(input: CreatePolicyInput): Promise<AbacPolicy> {
    const p: AbacPolicy = {
      id: randomUUID(),
      tenant_id: input.tenantId,
      role: input.role,
      action: input.action,
      expression: input.expression,
      created_at: new Date().toISOString(),
    };
    this.policies.push(p);
    return p;
  }
  async listPolicies(tenantId: string, role?: string, action?: string): Promise<AbacPolicy[]> {
    return this.policies.filter((p) => p.tenant_id === tenantId && (!role || p.role === role) && (!action || p.action === action));
  }
  async createApproval(input: CreateApprovalInput): Promise<DualApprovalRequest> {
    const now = new Date();
    const r: DualApprovalRequest = {
      id: randomUUID(),
      tenant_id: input.tenantId,
      amount_stroops: String(input.amountStroops),
      amountStroops: String(input.amountStroops),
      initiator_id: input.initiatorId,
      approver_id: null,
      status: "PENDING",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.approvals.set(r.id, r);
    return r;
  }
  async getApproval(tenantId: string, id: string): Promise<DualApprovalRequest | null> {
    const r = this.approvals.get(id);
    return r && r.tenant_id === tenantId ? r : null;
  }
  async listPendingApprovals(tenantId: string): Promise<DualApprovalRequest[]> {
    return [...this.approvals.values()].filter((r) => r.tenant_id === tenantId && r.status === "PENDING");
  }
  async approveRequest(tenantId: string, id: string, approverId: string): Promise<DualApprovalRequest | null> {
    const r = this.approvals.get(id);
    if (!r || r.tenant_id !== tenantId || r.status !== "PENDING" || r.initiator_id === approverId) return null;
    r.status = "APPROVED";
    r.approver_id = approverId;
    r.updated_at = new Date().toISOString();
    return r;
  }
  async expireStaleApprovals(now = new Date()): Promise<number> {
    let count = 0;
    for (const r of this.approvals.values()) {
      if (r.status === "PENDING" && r.expires_at && new Date(r.expires_at) < now) {
        r.status = "EXPIRED";
        r.updated_at = now.toISOString();
        count += 1;
      }
    }
    return count;
  }
}

export function createEnterpriseStore(pool?: Pick<Pool, "query">): EnterpriseStore {
  return pool ? new PgEnterpriseStore(pool) : new MemoryEnterpriseStore();
}
