-- 032_add_shielded_provider_staking.sql
-- Zero-Knowledge Anonymous Provider Staking & Shielded Reputation Proofs (#427)

CREATE TABLE IF NOT EXISTS shielded_stake_commitments (
    commitment_hash VARCHAR(64) PRIMARY KEY,
    merkle_leaf_index INT NOT NULL,
    staked_amount_stroops BIGINT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shielded_provider_nullifiers (
    nullifier_hash VARCHAR(64) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shielded_commitments_active
    ON shielded_stake_commitments(is_active)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_shielded_nullifiers_provider
    ON shielded_provider_nullifiers(provider_id);
