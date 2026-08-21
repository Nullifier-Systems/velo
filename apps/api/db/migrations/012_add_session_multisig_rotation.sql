BEGIN;

-- Session-key multi-sig emergency rotation (#375).
--
-- Two state lanes:
--   1. `session_key_registry`           — one row per delegated session key with
--      its spending quota and lifecycle status. Every spend and every rotation
--      takes a `SELECT ... FOR UPDATE` on this row, so a spend can never
--      interleave with an emergency rotation (see
--      apps/api/src/lib/session-registry-store.ts).
--   2. `session_key_rotation_proposals` — the 2-of-3 admin signature ledger
--      behind POST /api/v1/session/rotate-key and .../approve. `executed` is
--      flipped only after the on-chain `session_key_rotated` effect is
--      confirmed by apps/api/src/lib/workers/sessionRotationWorker.ts.

CREATE TYPE session_key_status AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED');

CREATE TABLE session_key_registry (
    pubkey VARCHAR(56) PRIMARY KEY,
    status session_key_status NOT NULL DEFAULT 'ACTIVE',
    spending_quota BIGINT NOT NULL DEFAULT 0 CHECK (spending_quota >= 0),
    spent_quota BIGINT NOT NULL DEFAULT 0 CHECK (spent_quota >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX session_key_registry_status_idx ON session_key_registry (status);

CREATE TABLE session_key_rotation_proposals (
    proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    old_pubkey VARCHAR(56) NOT NULL REFERENCES session_key_registry(pubkey),
    new_pubkey VARCHAR(56) NOT NULL,
    signatures_collected SMALLINT NOT NULL DEFAULT 1,
    required_signatures SMALLINT NOT NULL DEFAULT 2,
    signer_1 VARCHAR(56) NOT NULL,
    signer_2 VARCHAR(56),
    executed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ,
    -- The threshold is only met by two DIFFERENT admins.
    CONSTRAINT session_key_rotation_distinct_signers
        CHECK (signer_2 IS NULL OR signer_2 <> signer_1)
);

CREATE INDEX session_key_rotation_proposals_old_idx
    ON session_key_rotation_proposals (old_pubkey, created_at DESC);

COMMIT;
