BEGIN;

-- Cross-Ledger Settlement Time-Lock Atomic Swap Dispute Bridge.
--
-- A cross-chain HTLC swap has two legs. The Stellar leg
-- (contracts/atomic-swap) publishes the revealed preimage in its `released`
-- event precisely so a relayer can claim the counterpart leg on the other
-- chain. Two failure modes follow from that design, and this table exists to
-- close both:
--
--   Asymmetric lockup — the counterparty reveals on chain A and stalls on
--   chain B. Until now the honest party simply waited out the full timeout
--   with their funds locked and no automated claims path.
--
--   Relayer secret leakage — the revealed preimage lives in an event log. If
--   the relayer misses that event before the local HTLC expires, the secret
--   is effectively lost and the collateral is unrecoverable.
--
-- `atomic_swap_dispute_bridges` is one row per swap: it durably records the
-- preimage the moment it is observed on either chain (so a missed event is no
-- longer fatal), and tracks the swap through a small state machine so the
-- worker knows what is still owed.
--
-- Concurrency: `swapDisputeWorker` and an operator-triggered
-- POST /api/v1/swaps/dispute-claim can act on the same swap at the same
-- moment. Both read and write under `SELECT ... FOR UPDATE` on this row, and
-- state transitions are CAS-style (`UPDATE ... WHERE state = $expected`), so
-- a refund is claimed exactly once no matter how many callers race
-- (tests/concurrency/swap_dispute_stress.test.ts).

CREATE TYPE swap_dispute_state AS ENUM (
    -- Swap is live; neither side has revealed and the timeout has not passed.
    'ACTIVE',
    -- A preimage has been observed on-chain and stored in secret_preimage.
    -- The counterpart leg can now be claimed with it.
    'SECRET_EXTRACTED',
    -- expiration_ledger has passed with no secret. A short-lived claim state:
    -- the caller that wins the CAS into this state is the only one permitted
    -- to submit refund() on-chain.
    'REFUND_CLAIMABLE',
    -- Terminal. Either the swap settled with the extracted secret or the
    -- refund landed.
    'RESOLVED'
);

CREATE TABLE atomic_swap_dispute_bridges (
    swap_id VARCHAR(64) PRIMARY KEY,
    initiator_address VARCHAR(56) NOT NULL,
    counterparty_address VARCHAR(56) NOT NULL,
    secret_hash VARCHAR(64) NOT NULL,
    -- NULL until a preimage is observed on either leg. Written once and never
    -- overwritten: the first correct preimage is the only one that matters.
    secret_preimage VARCHAR(64) NULL,
    expiration_ledger INT NOT NULL,
    state swap_dispute_state NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- The worker's hot query is "which live swaps have expired?", i.e. a range
-- scan on expiration_ledger filtered by state. Leading with expiration_ledger
-- keeps that an index range read rather than a full scan as the table grows.
CREATE INDEX idx_swap_expiration ON atomic_swap_dispute_bridges(expiration_ledger, state);

COMMIT;
