BEGIN;

-- Soroban Smart Contract Upgradability Protocol & Storage State Migration Engine (Issue #464)
--
-- Tracks contract upgrade proposals, target WASM code hashes, storage versioning,
-- multisig admin signatures collected, and execution status.

CREATE TABLE IF NOT EXISTS contract_upgrade_proposals (
    proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(56) NOT NULL,
    new_wasm_hash VARCHAR(64) NOT NULL,
    storage_version INT NOT NULL,
    signatures_collected INT NOT NULL DEFAULT 1,
    executed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contract_upgrade_signatures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id UUID NOT NULL REFERENCES contract_upgrade_proposals(proposal_id) ON DELETE CASCADE,
    signer_address VARCHAR(56) NOT NULL,
    signature VARCHAR(128) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(proposal_id, signer_address)
);

CREATE INDEX IF NOT EXISTS idx_contract_upgrade_contract ON contract_upgrade_proposals(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_upgrade_proposals_status ON contract_upgrade_proposals(executed);

COMMIT;
