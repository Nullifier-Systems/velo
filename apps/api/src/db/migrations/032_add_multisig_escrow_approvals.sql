BEGIN;

-- Multi-Sig Escrow Threshold Release & Key Recovery Protocol (issue #433).
--
-- The Soroban escrow contract already had a `release_escrow` entrypoint
-- that pays out a trade once threshold-of-N ed25519 signatures are
-- presented (contracts/escrow/src/lib.rs), but nothing on-chain bound the
-- accepted key list to the trade's actual buyer/seller — the caller could
-- supply two throwaway keys of their own and drain any locked trade. That
-- is fixed on-chain by `register_trade_signers` (set-once, requires both
-- buyer and seller auth). This migration adds the off-chain side: a place
-- to collect signer approvals asynchronously (buyer, seller, and a backup
-- signer do not sign in the same moment or session) before the API bundles
-- them into a single `release_escrow` call once threshold is met.
--
-- `multisig_escrow_releases` is one row per trade's release attempt — it
-- pins down `recipient_address` / `release_amount_stroops` / `nonce` so
-- every signer is guaranteed to be signing the exact same payload the
-- contract will verify. `multisig_escrow_approvals` is the append-only set
-- of signatures collected against that pinned payload. Both are read and
-- written under `SELECT ... FOR UPDATE` on `multisig_escrow_releases` so
-- concurrent approve calls on the same trade can only trigger the on-chain
-- release exactly once (tests/concurrency/multisig_release_stress.test.ts).

CREATE TABLE multisig_escrow_releases (
    trade_id VARCHAR(64) PRIMARY KEY REFERENCES cash_requests(id) ON DELETE CASCADE,
    recipient_address VARCHAR(56) NOT NULL,
    release_amount_stroops NUMERIC(39,0) NOT NULL,
    nonce BIGINT NOT NULL,
    threshold INT NOT NULL,
    -- 'releasing' is a short-lived claim state: the row that wins the
    -- CAS-style UPDATE ... WHERE status = 'pending' out of a threshold-met
    -- race is the only caller allowed to submit release_escrow on-chain
    -- (see MultisigEscrowStore.claimReleaseIfThresholdMet).
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'releasing', 'released', 'failed')),
    release_tx_hash TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE multisig_escrow_approvals (
    approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id VARCHAR(64) NOT NULL REFERENCES multisig_escrow_releases(trade_id) ON DELETE CASCADE,
    signer_address VARCHAR(56) NOT NULL,
    signer_pubkey_hex VARCHAR(64) NOT NULL,
    signature VARCHAR(128) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(trade_id, signer_address)
);

CREATE INDEX idx_multisig_approvals_trade ON multisig_escrow_approvals(trade_id);

COMMIT;
