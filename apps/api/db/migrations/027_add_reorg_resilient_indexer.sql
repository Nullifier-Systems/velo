BEGIN;

-- Table to track ledger headers for DAG-based reorg detection
CREATE TABLE indexer_block_headers (
    ledger_sequence INT PRIMARY KEY,
    block_hash VARCHAR(64) NOT NULL,
    parent_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient parent hash lookups during reorg detection
CREATE INDEX indexer_block_headers_parent_hash_idx ON indexer_block_headers(parent_hash);

-- Table to store undo logs for atomic rollback during reorgs
CREATE TABLE indexer_undo_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_sequence INT NOT NULL,
    table_name VARCHAR(64) NOT NULL,
    previous_row_data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient undo log retrieval during rollback
CREATE INDEX indexer_undo_logs_ledger_sequence_idx ON indexer_undo_logs(ledger_sequence);
CREATE INDEX indexer_undo_logs_table_name_idx ON indexer_undo_logs(table_name);

-- Table to track reorg events for monitoring and debugging
CREATE TABLE indexer_reorg_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    fork_ledger INT NOT NULL,
    rollback_depth INT NOT NULL,
    reason TEXT NOT NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution_details JSONB
);

-- Index for querying reorg history
CREATE INDEX indexer_reorg_events_detected_at_idx ON indexer_reorg_events(detected_at DESC);

-- Table to track RPC node health and failover events
CREATE TABLE indexer_rpc_node_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rpc_url TEXT NOT NULL,
    is_healthy BOOLEAN NOT NULL DEFAULT TRUE,
    last_check TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_failure_reason TEXT,
    last_success_at TIMESTAMP WITH TIME ZONE
);

-- Index for querying healthy RPC nodes
CREATE INDEX indexer_rpc_node_health_healthy_idx ON indexer_rpc_node_health(is_healthy, last_check);

COMMIT;
