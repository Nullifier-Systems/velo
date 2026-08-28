CREATE TABLE dispute_evidence_sanitization_logs (
    evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id VARCHAR(64) NOT NULL,
    exif_removed BOOLEAN NOT NULL DEFAULT TRUE,
    pii_redactions_count INT NOT NULL DEFAULT 0,
    sanitized_file_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
