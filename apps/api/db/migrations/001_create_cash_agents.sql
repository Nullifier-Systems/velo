CREATE TABLE IF NOT EXISTS cash_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL, -- active, inactive, suspended
    
    -- Geolocation Coordinates
    latitude NUMERIC(10, 8) NOT NULL,
    longitude NUMERIC(11, 8) NOT NULL,
    
    -- Metadata (Useful for UI display/filtering)
    address TEXT,
    phone_number VARCHAR(50),
    supported_services VARCHAR(50)[] DEFAULT '{}', -- e.g., ['deposit', 'withdrawal']
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Crucial indexes for bounding-box search performance
CREATE INDEX IF NOT EXISTS idx_cash_agents_location ON cash_agents (latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_cash_agents_status ON cash_agents (status) WHERE status = 'active';