BEGIN;

-- Multi-Asset Escrow Collateral Flash-Loan Attack Prevention Protocol (#420).
--
-- Providers deposit and lock multi-asset collateral to service cash requests.
-- Instantaneous single-ledger deposits and releases would let flash-loan
-- attackers manipulate provider liquidity allocations, temporarily inflate
-- exchange rates, and extract arbitrage value before returning the borrowed
-- funds within the same Stellar ledger.
--
-- Every collateral deposit therefore records the ledger sequence it was made
-- at plus the ledger at which its mandatory lockup (~5 ledgers / ~25 seconds)
-- expires. Releases must pass a release-check that verifies the cooldown has
-- elapsed under a row lock (SELECT ... FOR UPDATE) so two racing release
-- requests can never both observe an expired cooldown.
--
-- The cooldown monitor worker flips is_locked back to FALSE once
-- cooldown_until_ledger is reached; rows stay for audit purposes.

CREATE TABLE escrow_collateral_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id VARCHAR(64) NOT NULL,
    asset_address VARCHAR(56) NOT NULL,
    amount_stroops BIGINT NOT NULL,
    deposit_ledger INT NOT NULL,
    cooldown_until_ledger INT NOT NULL,
    is_locked BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_collateral_cooldown ON escrow_collateral_deposits(provider_id, cooldown_until_ledger);

COMMIT;
