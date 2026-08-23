-- Track API timeout incidents for monitoring and debugging
CREATE TABLE IF NOT EXISTS api_timeout_incident_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint VARCHAR(255) NOT NULL,
    client_user_agent TEXT NULL,
    response_time_ms INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add index for querying recent timeouts
CREATE INDEX IF NOT EXISTS idx_api_timeout_logs_created_at ON api_timeout_incident_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_timeout_logs_endpoint ON api_timeout_incident_logs(endpoint);
