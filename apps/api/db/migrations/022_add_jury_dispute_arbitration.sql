-- 022_add_jury_dispute_arbitration.sql
-- Decentralized Jury Dispute Arbitration & Escrow Staking/Slashing Protocol (#404)

CREATE TABLE IF NOT EXISTS juror_stakes (
    juror_address VARCHAR(56) PRIMARY KEY,
    staked_amount_stroops BIGINT NOT NULL,
    reputation_score INT NOT NULL DEFAULT 100,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispute_panels (
    panel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id VARCHAR(64) NOT NULL,
    juror_addresses JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'VOTING',
    escrow_amount_stroops BIGINT NOT NULL DEFAULT 0,
    resolution VARCHAR(16),
    buyer_share_bps INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS jury_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    panel_id UUID NOT NULL REFERENCES dispute_panels(panel_id),
    juror_address VARCHAR(56) NOT NULL,
    commit_hash VARCHAR(64) NOT NULL,
    revealed_vote VARCHAR(8),
    vote_payload VARCHAR(256),
    salt_hex VARCHAR(64),
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    revealed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_dispute_panels_trade_id ON dispute_panels(trade_id);
CREATE INDEX IF NOT EXISTS idx_dispute_panels_status ON dispute_panels(status);
CREATE INDEX IF NOT EXISTS idx_jury_votes_panel_id ON jury_votes(panel_id);
CREATE INDEX IF NOT EXISTS idx_jury_votes_juror ON jury_votes(juror_address);
