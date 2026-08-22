BEGIN;

-- Real-time ledger indexer + automated circuit-breaker state (#374).
--
-- Four state lanes:
--   1. `ledger_event_audit_log`  — partitioned append-only ledger event feed.
--   2. `system_invariant_state`  — per-contract running totals used by the
--      formal reserve-conservation checker on every closed ledger.
--   3. `circuit_breaker_incidents` — append-only audit of every violation and
--      every manual admin override (the "black box" for arbitration).
--   4. Single-leader election via `pg_try_advisory_xact_lock(889001)` — see
--      apps/api/src/lib/workers/stellarIndexerWorker.ts.

CREATE TYPE invariant_check_status AS ENUM ('HEALTHY', 'WARNING', 'VIOLATED', 'HALTED');
CREATE TYPE circuit_breaker_action AS ENUM ('NO_ACTION', 'PAUSE_SINGLE_ESCROW', 'GLOBAL_SYSTEM_PAUSE');

-- Partitioned table for high-throughput ledger event logs. The PK includes
-- ledger_sequence so the partition key is a prefix of every unique index —
-- required for Postgres declarative range partitioning.
CREATE TABLE ledger_event_audit_log (
    ledger_sequence INT NOT NULL,
    tx_hash VARCHAR(64) NOT NULL,
    contract_id VARCHAR(56) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    vector_clock BIGINT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ledger_sequence, tx_hash)
) PARTITION BY RANGE (ledger_sequence);

-- Initial ledger partition (first 1M ledgers). Operators add further
-- partitions with `CREATE TABLE ledger_event_audit_log_pN PARTITION OF
-- ledger_event_audit_log FOR VALUES FROM (N) TO (M);` ahead of ledger growth.
CREATE TABLE ledger_event_audit_log_p1 PARTITION OF ledger_event_audit_log
    FOR VALUES FROM (0) TO (1000000);

CREATE INDEX ledger_event_audit_log_contract_idx
    ON ledger_event_audit_log (contract_id, ledger_sequence DESC);
CREATE INDEX ledger_event_audit_log_vc_idx
    ON ledger_event_audit_log (vector_clock);

-- Per-contract running invariant state, the source of truth the formal
-- checker reconciles against the on-chain contract balance.
CREATE TABLE system_invariant_state (
    contract_id VARCHAR(56) PRIMARY KEY,
    total_locked_stroops BIGINT NOT NULL DEFAULT 0,
    total_allocated_stroops BIGINT NOT NULL DEFAULT 0,
    fee_accumulator_stroops BIGINT NOT NULL DEFAULT 0,
    last_processed_ledger INT NOT NULL,
    status invariant_check_status NOT NULL DEFAULT 'HEALTHY',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX system_invariant_state_status_idx
    ON system_invariant_state (status, last_processed_ledger DESC);

-- Append-only incident log. `action_taken` records what the automated
-- arbitration engine (or a manual admin override) did; `tx_pause_hash` links
-- the incident to the on-chain pause transaction.
CREATE TABLE circuit_breaker_incidents (
    incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(56) NOT NULL REFERENCES system_invariant_state(contract_id),
    violated_invariant VARCHAR(128) NOT NULL,
    evidence_payload JSONB NOT NULL,
    action_taken circuit_breaker_action NOT NULL,
    tx_pause_hash VARCHAR(64) NULL,
    resolved_at TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX circuit_breaker_incidents_contract_idx
    ON circuit_breaker_incidents (contract_id, incident_id DESC);

COMMIT;
