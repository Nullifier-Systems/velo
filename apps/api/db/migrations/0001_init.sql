-- Velo persistence — initial schema (issue #24)
--
-- Covers three domains up front so cash-request persistence does not force a
-- rework when the Bazaar intent feed (#13) and reputation (#15) land.
-- Rationale and design notes: docs/db-schema.md
--
-- Apply with any migration runner, e.g.:
--   psql "$DATABASE_URL" -f apps/api/db/migrations/0001_init.sql

BEGIN;

-- gen_random_uuid() is core since PG13; pgcrypto covers older servers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared identity
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  address     TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Domain 1: Cash requests (HTLC escrow-backed)
-- ---------------------------------------------------------------------------
CREATE TYPE cash_request_status AS ENUM ('locked', 'released', 'refunded');

CREATE TABLE cash_requests (
  id             TEXT PRIMARY KEY,
  contract_id    TEXT NOT NULL,
  seller         TEXT NOT NULL REFERENCES accounts(address),
  buyer          TEXT NOT NULL REFERENCES accounts(address),
  amount_stroops NUMERIC(39,0) NOT NULL CHECK (amount_stroops > 0),
  asset          TEXT NOT NULL DEFAULT 'native',
  secret_hash    TEXT NOT NULL,
  status         cash_request_status NOT NULL DEFAULT 'locked',
  lock_tx        TEXT,
  settle_tx      TEXT,
  timeout_ledger BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ,
  metadata       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX cash_requests_seller_idx ON cash_requests (seller);
CREATE INDEX cash_requests_buyer_idx  ON cash_requests (buyer);
CREATE INDEX cash_requests_open_idx   ON cash_requests (status) WHERE status = 'locked';

-- ---------------------------------------------------------------------------
-- Domain 2: Bazaar intents
-- ---------------------------------------------------------------------------
CREATE TYPE intent_side   AS ENUM ('buy', 'sell');
CREATE TYPE intent_status AS ENUM ('open', 'matched', 'filled', 'cancelled', 'expired');

CREATE TABLE bazaar_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  maker           TEXT NOT NULL REFERENCES accounts(address),
  side            intent_side NOT NULL,
  give_asset      TEXT NOT NULL,
  take_asset      TEXT NOT NULL,
  give_amount     NUMERIC(39,0) NOT NULL CHECK (give_amount > 0),
  min_take_amount NUMERIC(39,0) NOT NULL CHECK (min_take_amount > 0),
  status          intent_status NOT NULL DEFAULT 'open',
  location_geohash TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX bazaar_intents_open_idx    ON bazaar_intents (status, created_at DESC) WHERE status = 'open';
CREATE INDEX bazaar_intents_maker_idx   ON bazaar_intents (maker);
CREATE INDEX bazaar_intents_pair_idx    ON bazaar_intents (give_asset, take_asset) WHERE status = 'open';
CREATE INDEX bazaar_intents_geohash_idx ON bazaar_intents (location_geohash) WHERE location_geohash IS NOT NULL;

CREATE TABLE intent_matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id       UUID NOT NULL REFERENCES bazaar_intents(id),
  counterparty    TEXT NOT NULL REFERENCES accounts(address),
  cash_request_id TEXT REFERENCES cash_requests(id),
  matched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX intent_matches_intent_idx ON intent_matches (intent_id);

-- ---------------------------------------------------------------------------
-- Domain 3: Reputation (event-sourced + derived score + soulbound badges)
-- ---------------------------------------------------------------------------
CREATE TYPE reputation_event_kind AS ENUM (
  'trade_completed', 'trade_refunded', 'trade_disputed', 'badge_issued', 'manual_adjustment'
);

CREATE TABLE reputation_events (
  id          BIGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES accounts(address),
  kind        reputation_event_kind NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  ref_type    TEXT,
  ref_id      TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX reputation_events_address_idx ON reputation_events (address, occurred_at DESC);
CREATE INDEX reputation_events_ref_idx     ON reputation_events (ref_type, ref_id);

CREATE TABLE reputation_scores (
  address          TEXT PRIMARY KEY REFERENCES accounts(address),
  trades_total     INTEGER NOT NULL DEFAULT 0,
  trades_completed INTEGER NOT NULL DEFAULT 0,
  completion_rate  NUMERIC(5,4),
  trusted          BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reputation_badges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address     TEXT NOT NULL REFERENCES accounts(address),
  tier        TEXT NOT NULL,
  contract_id TEXT,
  token_id    TEXT,
  issued_tx   TEXT,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address, tier)
);

COMMIT;
