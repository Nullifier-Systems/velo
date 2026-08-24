CREATE TYPE consensus_status AS ENUM ('PROPOSED', 'VOTING', 'AGGREGATED', 'SUBMITTED', 'FAILED');

CREATE TABLE relayer_nodes (
    peer_id VARCHAR(64) PRIMARY KEY,
    bls_pubkey VARCHAR(192) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE consensus_round_logs (
    round_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swap_id VARCHAR(64) NOT NULL,
    threshold_required INT NOT NULL,
    signatures_collected INT NOT NULL DEFAULT 0,
    aggregate_signature TEXT NULL,
    status consensus_status NOT NULL DEFAULT 'PROPOSED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);