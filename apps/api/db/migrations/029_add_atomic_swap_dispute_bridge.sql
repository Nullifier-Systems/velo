-- Migration: 029_add_atomic_swap_dispute_bridge.sql
-- Description: Cross-Ledger Settlement Time-Lock Atomic Swap Dispute Bridge (#446)

DO $$ BEGIN
    CREATE TYPE swap_dispute_state AS ENUM (
        'ACTIVE',
        'SECRET_EXTRACTED',
        'REFUND_CLAIMABLE',
        'RESOLVED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS atomic_swap_dispute_bridges (
    swap_id VARCHAR(64) PRIMARY KEY,
    initiator_address VARCHAR(56) NOT NULL,
    counterparty_address VARCHAR(56) NOT NULL,
    secret_hash VARCHAR(64) NOT NULL,
    secret_preimage VARCHAR(64),
    expiration_ledger BIGINT NOT NULL,
    state swap_dispute_state NOT NULL DEFAULT 'ACTIVE',
    execution_proof TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atomic_swap_dispute_bridges_state ON atomic_swap_dispute_bridges(state);
CREATE INDEX IF NOT EXISTS idx_atomic_swap_dispute_bridges_expiration_ledger ON atomic_swap_dispute_bridges(expiration_ledger);
CREATE INDEX IF NOT EXISTS idx_atomic_swap_dispute_bridges_initiator ON atomic_swap_dispute_bridges(initiator_address);
CREATE INDEX IF NOT EXISTS idx_atomic_swap_dispute_bridges_counterparty ON atomic_swap_dispute_bridges(counterparty_address);
