-- Enterprise Multi-Tenant RBAC/ABAC & KMS Key Delegation (#401)
-- Sequential next migration after 008_add_zk_nullifier_pipeline.sql.
-- Issue description referenced 019_add_enterprise_tenant_rbac.sql; this file
-- is intentionally 009 to keep the migrator sequential. See PR description.

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS abac_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    expression JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_abac_policies_tenant ON abac_policies (tenant_id);
CREATE INDEX IF NOT EXISTS idx_abac_policies_role_action ON abac_policies (tenant_id, role, action);

CREATE TABLE IF NOT EXISTS dual_approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    amount_stroops BIGINT NOT NULL,
    initiator_id VARCHAR(64) NOT NULL,
    approver_id VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_dual_approval_tenant_status ON dual_approval_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dual_approval_expires ON dual_approval_requests (status, expires_at);

-- Compatibility shim: issue spec used alias 019. Some tooling may look for
-- 019_add_enterprise_tenant_rbac.sql; we keep the canonical file as 009 and
-- document the alias here. Do not create a duplicate 019 file that would
-- cause double migration.
