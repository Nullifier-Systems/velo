BEGIN;

-- Bidirectional state channels for off-chain micropayment streaming.
--
-- state_channels: Channel metadata and status tracking.
-- state_channel_commits: Off-chain state signatures (vector clock ordered).
-- state_channel_settlements: On-chain settlement submissions and outcomes.
-- state_channel_audit_log: Dispute evidence and challenge records.

CREATE TYPE channel_status AS ENUM ('OPEN', 'CLOSING', 'CLOSED', 'DISPUTED');

CREATE TABLE state_channels (
    channel_id VARCHAR(64) PRIMARY KEY,
    party_a VARCHAR(56) NOT NULL REFERENCES accounts(address),
    party_b VARCHAR(56) NOT NULL REFERENCES accounts(address),
    total_deposit_stroops BIGINT NOT NULL CHECK (total_deposit_stroops > 0),
    nonce BIGINT NOT NULL DEFAULT 0,
    status channel_status NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT parties_differ CHECK (party_a < party_b)
);

CREATE INDEX state_channels_status_idx ON state_channels (status);
CREATE INDEX state_channels_parties_idx ON state_channels (party_a, party_b);

-- Off-chain state commits with vector clock ordering.
-- sequence_number ensures total order; signature proves authorization.
CREATE TABLE state_channel_commits (
    commit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id VARCHAR(64) NOT NULL REFERENCES state_channels(channel_id) ON DELETE CASCADE,
    sequence_number BIGINT NOT NULL,
    signer VARCHAR(56) NOT NULL,
    state_root VARCHAR(64) NOT NULL,
    signature VARCHAR(128) NOT NULL,
    party_a_balance BIGINT NOT NULL CHECK (party_a_balance >= 0),
    party_b_balance BIGINT NOT NULL CHECK (party_b_balance >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Composite uniqueness: one commit per sequence per channel.
    CONSTRAINT unique_sequence_per_channel UNIQUE (channel_id, sequence_number)
);

CREATE INDEX state_channel_commits_channel_seq_idx
    ON state_channel_commits (channel_id, sequence_number DESC);
CREATE INDEX state_channel_commits_signer_idx
    ON state_channel_commits (channel_id, signer);

-- On-chain settlement submissions and outcomes.
CREATE TABLE state_channel_settlements (
    settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id VARCHAR(64) NOT NULL REFERENCES state_channels(channel_id) ON DELETE CASCADE,
    final_sequence_number BIGINT NOT NULL,
    initiator VARCHAR(56) NOT NULL,
    party_a_final_balance BIGINT NOT NULL,
    party_b_final_balance BIGINT NOT NULL,
    merkle_root VARCHAR(64) NOT NULL,
    submitted_txn_hash VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX state_channel_settlements_channel_idx
    ON state_channel_settlements (channel_id, created_at DESC);
CREATE INDEX state_channel_settlements_txn_idx
    ON state_channel_settlements (submitted_txn_hash);

-- Dispute evidence and challenge records for penalty enforcement.
CREATE TABLE state_channel_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id VARCHAR(64) NOT NULL REFERENCES state_channels(channel_id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    challenger VARCHAR(56) NOT NULL,
    challenged_sequence BIGINT NOT NULL,
    evidence_root VARCHAR(64),
    penalty_amount BIGINT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX state_channel_audit_log_channel_idx
    ON state_channel_audit_log (channel_id, created_at DESC);
CREATE INDEX state_channel_audit_log_event_idx
    ON state_channel_audit_log (event_type, status);

COMMIT;
