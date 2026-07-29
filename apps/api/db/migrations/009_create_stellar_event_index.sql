BEGIN;

CREATE TABLE stellar_indexer_checkpoints (
  indexer_name       TEXT PRIMARY KEY,
  ledger_sequence    BIGINT NOT NULL CHECK (ledger_sequence >= 0),
  validation_ledger  BIGINT,
  validation_hash    TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stellar_contract_events (
  id                 BIGSERIAL PRIMARY KEY,
  event_id           TEXT NOT NULL,
  event_version      TEXT NOT NULL UNIQUE,
  contract_id        TEXT NOT NULL,
  ledger_sequence    BIGINT NOT NULL,
  event_order        INTEGER NOT NULL,
  transaction_hash   TEXT,
  event_type         TEXT NOT NULL CHECK (event_type IN ('locked', 'released', 'disputed')),
  escrow_id          TEXT NOT NULL,
  amount             NUMERIC(39,0),
  actor               TEXT,
  raw_event           JSONB NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stellar_contract_events_escrow_idx
  ON stellar_contract_events (contract_id, escrow_id, ledger_sequence, event_order);
CREATE INDEX stellar_contract_events_ledger_idx
  ON stellar_contract_events (ledger_sequence);

-- Event rows above are immutable. Canonical chain membership is deliberately
-- kept in this separate, replaceable pointer table so a rollback never updates
-- or deletes historical event payloads.
CREATE TABLE stellar_canonical_events (
  event_id         TEXT PRIMARY KEY,
  event_record_id  BIGINT NOT NULL UNIQUE REFERENCES stellar_contract_events(id),
  canonicalized_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stellar_ledger_fingerprints (
  ledger_sequence BIGINT PRIMARY KEY,
  ledger_hash     TEXT NOT NULL,
  event_count     INTEGER NOT NULL,
  canonical       BOOLEAN NOT NULL DEFAULT TRUE,
  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indexed_escrows (
  contract_id         TEXT NOT NULL,
  escrow_id           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('locked', 'released', 'disputed')),
  locked_amount       NUMERIC(39,0),
  released_amount     NUMERIC(39,0),
  disputed_by         TEXT,
  last_ledger         BIGINT NOT NULL,
  last_event_order    INTEGER NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, escrow_id)
);
CREATE INDEX indexed_escrows_status_idx ON indexed_escrows (status, updated_at DESC);

COMMIT;
