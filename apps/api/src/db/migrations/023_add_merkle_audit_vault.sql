CREATE TABLE audit_hash_chain (
    sequence_id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    prev_hash VARCHAR(64) NOT NULL,
    curr_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_roots (
    block_index BIGINT PRIMARY KEY,
    start_sequence BIGINT NOT NULL,
    end_sequence BIGINT NOT NULL,
    merkle_root VARCHAR(64) NOT NULL,
    tx_hash VARCHAR(128) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
