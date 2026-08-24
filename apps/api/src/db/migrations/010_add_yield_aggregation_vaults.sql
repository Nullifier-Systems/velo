-- Automated Liquidity Reserve Rebalancing & Cross-Asset Yield Aggregation Vault (#408)
-- Sequential next migration after 009_add_enterprise_tenant_rbac.sql.
-- Issue description referenced 026_add_yield_aggregation_vaults.sql; this file
-- is intentionally 010 to keep the migrator sequential (same precedent as #401,
-- where the issue-referenced 019 became 009). See PR description.
--
-- yield_vault_configs     : one row per settlement asset routed into an
--                           external Soroban yield vault. liquid_buffer_ratio
--                           is the dynamic instant-withdrawal reserve target.
-- provider_vault_shares   : share-token position per provider per vault.
--                           Share BALANCES only change on deposit/withdraw —
--                           harvested yield raises the exchange rate instead
--                           (invariant: rate never decreases during harvest).

CREATE TABLE IF NOT EXISTS yield_vault_configs (
    vault_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_address VARCHAR(56) NOT NULL UNIQUE,
    liquid_buffer_ratio NUMERIC(3,2) NOT NULL DEFAULT 0.20 CHECK (
        liquid_buffer_ratio >= 0 AND liquid_buffer_ratio <= 1
    ),
    current_tvl_stroops BIGINT NOT NULL DEFAULT 0 CHECK (current_tvl_stroops >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_vault_shares (
    provider_id VARCHAR(64) NOT NULL,
    vault_id UUID NOT NULL REFERENCES yield_vault_configs(vault_id) ON DELETE CASCADE,
    share_balance BIGINT NOT NULL DEFAULT 0 CHECK (share_balance >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_vault_shares_vault ON provider_vault_shares (vault_id);