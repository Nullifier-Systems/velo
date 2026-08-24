BEGIN;

-- MEV-resistant commit-reveal batch auction engine (#403).
--
-- Orders in a fixed-length window are submitted as opaque commitment hashes
-- (COMMIT phase), then revealed with their real parameters (REVEAL phase),
-- matched, and cleared at a single uniform price (MATCH/SETTLE). This keeps
-- cleartext order parameters off-chain and unknown to relayers until every
-- participant in the round has already committed, removing the ability to
-- front-run or sandwich individual orders.
--
-- Two tables:
--   1. `batch_auction_rounds`   — one row per 10s round + its clearing price.
--   2. `committed_orders`      — commit hashes + deposits, revealed in place
--      once the REVEAL phase opens. Orders that never reveal keep
--      `revealed = false`; the worker marks them `forfeited = true` and their
--      deposit is not returned, which is the spam deterrent for
--      un-revealed commitments (see acceptance criteria on #403).

CREATE TYPE batch_auction_phase AS ENUM ('COMMIT', 'REVEAL', 'MATCH', 'SETTLE', 'CLOSED');
CREATE TYPE order_side AS ENUM ('BUY', 'SELL');

CREATE TABLE batch_auction_rounds (
    round_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phase batch_auction_phase NOT NULL DEFAULT 'COMMIT',
    clearing_price_stroops BIGINT NULL,
    commit_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    reveal_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX batch_auction_rounds_phase_idx
    ON batch_auction_rounds (phase, created_at DESC);

CREATE TABLE committed_orders (
    order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES batch_auction_rounds(round_id),
    commit_hash VARCHAR(64) NOT NULL,
    deposit_amount_stroops BIGINT NOT NULL,
    -- Populated only once revealed, during the REVEAL phase. NULL/false
    -- fields here mean the commitment is still opaque or was never revealed.
    side order_side NULL,
    rate_stroops BIGINT NULL,
    amount_stroops BIGINT NULL,
    revealed BOOLEAN NOT NULL DEFAULT FALSE,
    -- Set by the batch worker once the REVEAL phase closes on any commitment
    -- that never revealed; its deposit is forfeited rather than refunded.
    forfeited BOOLEAN NOT NULL DEFAULT FALSE,
    committed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revealed_at TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX committed_orders_round_idx
    ON committed_orders (round_id, revealed);

COMMIT;
