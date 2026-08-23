/**
 * Enterprise Multi-Tenant RBAC/ABAC & KMS Key Delegation types (#401)
 * Single source of truth for API, workers, and frontend.
 */

export type TenantId = string;

export interface Tenant {
  id: TenantId;
  name: string;
  created_at: string;
}

export type AbacAction = string;
export type AbacRole = string;

/**
 * ABAC policy AST expression stored as JSONB in abac_policies.expression.
 * Minimal boolean AST supporting enterprise policy authoring.
 */
export type AbacExpression =
  | { op: "eq"; left: string; right: unknown }
  | { op: "neq"; left: string; right: unknown }
  | { op: "gt"; left: string; right: number }
  | { op: "gte"; left: string; right: number }
  | { op: "lt"; left: string; right: number }
  | { op: "lte"; left: string; right: number }
  | { op: "in"; left: string; right: unknown[] }
  | { op: "and"; args: AbacExpression[] }
  | { op: "or"; args: AbacExpression[] }
  | { op: "not"; arg: AbacExpression }
  | { op: "true" }
  | { op: "false" };

export interface AbacPolicy {
  id: string;
  tenant_id: TenantId;
  role: AbacRole;
  action: AbacAction;
  expression: AbacExpression;
  created_at?: string;
}

export type DualApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface DualApprovalRequest {
  id: string;
  tenant_id: TenantId;
  amount_stroops: string;
  amountStroops?: string;
  initiator_id: string;
  approver_id: string | null;
  status: DualApprovalStatus;
  created_at: string;
  updated_at?: string;
  expires_at?: string;
}

export type KmsProvider = "aws" | "gcp" | "vault";

export interface KmsKeyRef {
  provider: KmsProvider;
  keyId: string;
  alias?: string;
}

export interface EnterpriseApprovalContext {
  tenantId: TenantId;
  role: string;
  action: string;
  attributes: Record<string, unknown>;
}

export const ENTERPRISE = {
  DUAL_APPROVAL_TTL_MS: 24 * 60 * 60 * 1000,
  DUAL_APPROVAL_POLL_MS: 60_000,
  HIGH_VALUE_THRESHOLD_STROOPS: 10_000_000_000n,
} as const;
