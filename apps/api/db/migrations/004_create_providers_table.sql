-- Migration 004: Create providers table for provider onboarding (Issue #44)

CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stellar_address VARCHAR(56) NOT NULL,
    name VARCHAR(255) NOT NULL,
    latitude NUMERIC(10, 8) NOT NULL,
    longitude NUMERIC(11, 8) NOT NULL,
    rate NUMERIC(10, 4) NOT NULL DEFAULT 1.0,
    availability VARCHAR(50) NOT NULL DEFAULT 'available',
    tier VARCHAR(50) NOT NULL DEFAULT 'Probationary',
    kyc_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lookup, location filtering, and availability filtering
CREATE INDEX IF NOT EXISTS idx_providers_stellar_address ON providers (stellar_address);
CREATE INDEX IF NOT EXISTS idx_providers_location ON providers (latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_providers_availability ON providers (availability);
