-- ZK Range-Proof Attestation Tables
-- Stores Pedersen commitments, range proof submissions, and verification results

CREATE TABLE IF NOT EXISTS pedersen_commitments (
    commitment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL,
    commitment_hex VARCHAR(64) NOT NULL UNIQUE,
    -- Blinding factor salt (r in C = v*G + r*H)
    salt_hex VARCHAR(64) NOT NULL,
    -- Attribute type: credit_score, net_worth, account_age_days, etc.
    attribute_type VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT valid_commitment_hex CHECK (commitment_hex ~ '^[a-f0-9]{64}$'),
    CONSTRAINT valid_salt_hex CHECK (salt_hex ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_pedersen_commitments_user_id ON pedersen_commitments(user_id);
CREATE INDEX idx_pedersen_commitments_attribute ON pedersen_commitments(attribute_type);
CREATE INDEX idx_pedersen_commitments_commitment_hex ON pedersen_commitments(commitment_hex);

-- Range Proof Submissions: User generates in WASM, submits to backend for verification
CREATE TABLE IF NOT EXISTS zk_range_proofs (
    proof_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commitment_id UUID NOT NULL REFERENCES pedersen_commitments(commitment_id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL,
    -- Serialized Bulletproof range proof (hex-encoded)
    proof_hex TEXT NOT NULL,
    -- Lower bound of claimed range (e.g., 700 for credit_score >= 700)
    range_min BIGINT NOT NULL,
    -- Upper bound of claimed range (e.g., 850 for credit_score <= 850)
    range_max BIGINT NOT NULL,
    -- Verification result: pending, verified, rejected
    status VARCHAR(16) DEFAULT 'pending',
    -- Error details if verification failed
    error_message TEXT,
    verification_time TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_proof_hex CHECK (proof_hex ~ '^[a-f0-9]+$'),
    CONSTRAINT valid_range CHECK (range_min <= range_max),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'verified', 'rejected'))
);

CREATE INDEX idx_zk_range_proofs_user_id ON zk_range_proofs(user_id);
CREATE INDEX idx_zk_range_proofs_commitment_id ON zk_range_proofs(commitment_id);
CREATE INDEX idx_zk_range_proofs_status ON zk_range_proofs(status);
CREATE INDEX idx_zk_range_proofs_created_at ON zk_range_proofs(created_at);

-- Verified Attestations: Signed by issuer after range proof is verified
CREATE TABLE IF NOT EXISTS zk_attestations (
    attestation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proof_id UUID NOT NULL REFERENCES zk_range_proofs(proof_id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL,
    -- Issuer's Ed25519 public key that signed this attestation
    issuer_public_key VARCHAR(56) NOT NULL,
    -- Signed attestation blob (includes commitment, range bounds, issuer sig)
    attestation_hex TEXT NOT NULL,
    -- Hash of attestation for deduplication
    attestation_hash VARCHAR(64) NOT NULL UNIQUE,
    -- TTL for presentation use (attestation expires)
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_attestation_hex CHECK (attestation_hex ~ '^[a-f0-9]+$'),
    CONSTRAINT valid_hash CHECK (attestation_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_zk_attestations_user_id ON zk_attestations(user_id);
CREATE INDEX idx_zk_attestations_proof_id ON zk_attestations(proof_id);
CREATE INDEX idx_zk_attestations_issuer ON zk_attestations(issuer_public_key);
CREATE INDEX idx_zk_attestations_expires_at ON zk_attestations(expires_at);
