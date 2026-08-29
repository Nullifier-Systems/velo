-- 030_add_distributed_webhook_pipeline.sql
-- Distributed Multi-Node Webhook Event Delivery Engine & Dead-Letter Queue (DLQ) Recovery System

CREATE TYPE webhook_delivery_status AS ENUM ('QUEUED', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

CREATE TABLE webhook_endpoints (
    endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL,
    target_url TEXT NOT NULL,
    secret_key VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE webhook_delivery_logs (
    delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(endpoint_id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    signature_header VARCHAR(64) NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    status webhook_delivery_status NOT NULL DEFAULT 'QUEUED',
    last_response_code INT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user_id ON webhook_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_endpoint_id ON webhook_delivery_logs(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_status ON webhook_delivery_logs(status);
