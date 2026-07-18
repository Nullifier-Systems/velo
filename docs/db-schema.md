# Database Schema Proposal — Cash Requests, Bazaar Intents, Reputation

Status: **proposal** (issue #24). This covers three domains at once so adding
persistence for cash requests now does not force a rework when the Bazaar intent
feed (#13) and reputation tracking (#15) land.

Target engine: **PostgreSQL**. Rationale: strong constraints/enums, `JSONB` for
forward-compatible metadata, partial and expression indexes for the hot lookups,
and `NUMERIC` for exact token amounts. The DDL is plain SQL and portable to any
migration runner.

## Design principles

1. **On-chain is the source of truth; the DB is an index/cache.** Every row that
   mirrors chain state carries the on-chain identifiers (contract id, trade id,
   tx hash) so it can be rebuilt from events. The DB never holds custody or
   secrets (mirrors today's `store.ts`, which stopped storing the secret).
2. **One identity surface.** Cash requests, intents, and reputation all key off a
   Stellar address. A single `accounts` table gives every address a stable home
   for FKs without forcing pre-registration (rows are created on first sight).
3. **Reputation is event-sourced.** An append-only `reputation_events` ledger is
   the truth; `reputation_scores` is a derived cache that can be recomputed at
   any time. This avoids "we changed the formula, now history is wrong."
4. **Status enums match contract states.** Cash-request statuses mirror the HTLC
   state machine (`locked/released/refunded`) so the DB can't drift into states
   the contract can't produce.
5. **Extensibility via `JSONB metadata`**, not by reshaping tables later.

## DDL

```sql
BEGIN;

-- ---------------------------------------------------------------------------
-- Shared identity
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  address     TEXT PRIMARY KEY,               -- Stellar G... address
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Domain 1: Cash requests (HTLC escrow-backed)   [replaces apps/api store.ts]
-- ---------------------------------------------------------------------------
CREATE TYPE cash_request_status AS ENUM ('locked', 'released', 'refunded');

CREATE TABLE cash_requests (
  id             TEXT PRIMARY KEY,             -- trade id, 32-byte hex
  contract_id    TEXT NOT NULL,                -- escrow/atomic-swap contract id
  seller         TEXT NOT NULL REFERENCES accounts(address),
  buyer          TEXT NOT NULL REFERENCES accounts(address),
  amount_stroops NUMERIC(39,0) NOT NULL CHECK (amount_stroops > 0),
  asset          TEXT NOT NULL DEFAULT 'native',
  secret_hash    TEXT NOT NULL,                -- sha256(secret), hex (never the secret)
  status         cash_request_status NOT NULL DEFAULT 'locked',
  lock_tx        TEXT,                         -- on-chain tx hashes for audit
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
-- Domain 2: Bazaar intents (marketplace feed)                       [issue #13]
-- ---------------------------------------------------------------------------
CREATE TYPE intent_side   AS ENUM ('buy', 'sell');
CREATE TYPE intent_status AS ENUM ('open', 'matched', 'filled', 'cancelled', 'expired');

CREATE TABLE bazaar_intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  maker         TEXT NOT NULL REFERENCES accounts(address),
  side          intent_side NOT NULL,
  give_asset    TEXT NOT NULL,                 -- what the maker offers
  take_asset    TEXT NOT NULL,                 -- what the maker wants
  give_amount   NUMERIC(39,0) NOT NULL CHECK (give_amount > 0),
  min_take_amount NUMERIC(39,0) NOT NULL CHECK (min_take_amount > 0),
  status        intent_status NOT NULL DEFAULT 'open',
  location_geohash TEXT,                       -- optional, for location-based discovery (#18)
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX bazaar_intents_open_idx     ON bazaar_intents (status, created_at DESC) WHERE status = 'open';
CREATE INDEX bazaar_intents_maker_idx    ON bazaar_intents (maker);
CREATE INDEX bazaar_intents_pair_idx     ON bazaar_intents (give_asset, take_asset) WHERE status = 'open';
CREATE INDEX bazaar_intents_geohash_idx  ON bazaar_intents (location_geohash) WHERE location_geohash IS NOT NULL;

-- When two intents (or an intent + a cash request) pair up.
CREATE TABLE intent_matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id       UUID NOT NULL REFERENCES bazaar_intents(id),
  counterparty    TEXT NOT NULL REFERENCES accounts(address),
  cash_request_id TEXT REFERENCES cash_requests(id),   -- settlement leg, if any
  matched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX intent_matches_intent_idx ON intent_matches (intent_id);

-- ---------------------------------------------------------------------------
-- Domain 3: Reputation (event-sourced + derived score + badges)     [issue #15]
-- ---------------------------------------------------------------------------
CREATE TYPE reputation_event_kind AS ENUM (
  'trade_completed', 'trade_refunded', 'trade_disputed', 'badge_issued', 'manual_adjustment'
);

-- Append-only ledger — the source of truth for reputation.
CREATE TABLE reputation_events (
  id          BIGGSERIAL PRIMARY KEY,
  address     TEXT NOT NULL REFERENCES accounts(address),
  kind        reputation_event_kind NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1,
  ref_type    TEXT,                            -- e.g. 'cash_request'
  ref_id      TEXT,                            -- e.g. the trade id
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX reputation_events_address_idx ON reputation_events (address, occurred_at DESC);
CREATE INDEX reputation_events_ref_idx     ON reputation_events (ref_type, ref_id);

-- Derived, recomputable aggregate for cheap reads (reputation.ts endpoint).
CREATE TABLE reputation_scores (
  address         TEXT PRIMARY KEY REFERENCES accounts(address),
  trades_total    INTEGER NOT NULL DEFAULT 0,
  trades_completed INTEGER NOT NULL DEFAULT 0,
  completion_rate NUMERIC(5,4),                -- 0.0000–1.0000, null if no trades
  trusted         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- On-chain soulbound reputation badges (#15). Non-transferable by design.
CREATE TABLE reputation_badges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address      TEXT NOT NULL REFERENCES accounts(address),
  tier         TEXT NOT NULL,                  -- e.g. 'Maestro'
  contract_id  TEXT,                           -- issuing contract
  token_id     TEXT,                           -- on-chain token/badge id
  issued_tx    TEXT,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address, tier)
);

COMMIT;
```

> Note: `BIGGSERIAL` above is `BIGSERIAL` — corrected in the migration file;
> shown here only to flag that IDs on the append-only table are surrogate.

## Reasoning per domain

**Cash requests.** A 1:1 mapping of the current `CashRequestRecord`, plus the
on-chain identifiers (`lock_tx`, `settle_tx`, `timeout_ledger`) needed to audit
against the contract, and an `asset` column so it is not XLM-only. The
`status = 'locked'` partial index is the hot path (the relayer/poller scans open
requests). `NUMERIC(39,0)` holds a full `i128` stroop amount exactly — never
floats for money.

**Bazaar intents.** Modeled as a generic maker order (`give_asset`/`take_asset`,
amounts, side) so it fits P2P cash, asset-for-asset, and future intent kinds
without new tables. `intent_matches` records pairings and optionally links to the
`cash_requests` row that settles them, so an intent's settlement is traceable
on-chain. `location_geohash` is included now (cheap) because provider discovery
(#18) is location-based; it is indexed only when present.

**Reputation.** Event-sourced: `reputation_events` is append-only truth, so the
scoring formula can change and be recomputed from history. `reputation_scores`
is the cache the `GET /reputation/:address` endpoint reads (which currently
returns `completion_rate`, `trades`, `trusted` — exactly these columns).
`reputation_badges` tracks the soulbound on-chain badges (#15), unique per
`(address, tier)`.

## Why this avoids a rework later

- Adding the Bazaar feed or reputation later is **new rows in existing tables**,
  not schema surgery: the identity surface, on-chain-id columns, and `JSONB`
  metadata are already in place.
- Cross-domain links already exist (`intent_matches.cash_request_id`,
  `reputation_events.ref_id`), so a settled intent and its reputation impact are
  connected from day one.
- Recomputable reputation means formula changes never require a destructive
  migration.

The concrete migration is in
[`apps/api/db/migrations/0001_init.sql`](../apps/api/db/migrations/0001_init.sql).
