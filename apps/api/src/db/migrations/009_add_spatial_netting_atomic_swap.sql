CREATE TYPE netting_session_status AS ENUM ('GRAPH_BUILDING', 'LOCKED', 'EXECUTING', 'SETTLED', 'FAILED');
CREATE TYPE swap_htlc_status AS ENUM ('OPEN', 'SECRET_REVEALED', 'CLAIMED', 'REFUNDED');

-- Table: liquidity_netting_batches
CREATE TABLE liquidity_netting_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index VARCHAR(15) NOT NULL,
    net_cleared_amount BIGINT NOT NULL,
    participant_count INT NOT NULL,
    status netting_session_status NOT NULL DEFAULT 'GRAPH_BUILDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMP WITH TIME ZONE NULL
);

-- Table: atomic_swap_legs
CREATE TABLE atomic_swap_legs (
    swap_id VARCHAR(64) PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES liquidity_netting_batches(id) ON DELETE CASCADE,
    sender_address VARCHAR(56) NOT NULL,
    receiver_address VARCHAR(56) NOT NULL,
    amount BIGINT NOT NULL,
    hash_lock VARCHAR(64) NOT NULL,
    secret_preimage VARCHAR(64) NULL,
    timeout_ledger INT NOT NULL,
    status swap_htlc_status NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_netting_h3_status ON liquidity_netting_batches(h3_index, status);
CREATE INDEX idx_swap_hash_lock ON atomic_swap_legs(hash_lock);
