BEGIN;

-- Distributed Multi-Node Webhook Event Delivery Engine & DLQ Recovery (#445).
--
-- Velo's ops-alert webhook (lib/webhook.ts's sendWebhookAlert) posts to a
-- single Slack/Discord URL and is fine to fire-and-forget. This is a
-- different surface: developers register their own target URL to receive
-- signed trade-status events (COMPLETED / REFUNDED). Sending those inline in
-- the request thread means one slow or dead client endpoint blocks a real API
-- response and, with no signature, lets a malicious third party spoof status
-- callbacks against anyone who trusts them unsigned.
--
-- webhook_endpoints is one row per developer-registered destination, holding
-- the HMAC secret used to sign every delivery to it. webhook_delivery_logs is
-- one row per attempted delivery, carrying its own attempt count and status
-- so a stuck delivery can be inspected and, once dead-lettered, replayed
-- without re-deriving anything from the original trigger.

CREATE TYPE webhook_delivery_status AS ENUM ('QUEUED', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

CREATE TABLE webhook_endpoints (
    endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL,
    target_url TEXT NOT NULL,
    secret_key VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Lookup for "which active endpoints does this developer have" — the query
-- the enqueue path runs on every trade-status event.
CREATE INDEX idx_webhook_endpoints_user ON webhook_endpoints(user_id) WHERE is_active;

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

-- The DLQ replay endpoint's hot query is "find this dead-lettered delivery to
-- claim it"; the operator dashboard's is "list an endpoint's recent
-- deliveries" — both covered by leading with endpoint_id.
CREATE INDEX idx_webhook_delivery_endpoint ON webhook_delivery_logs(endpoint_id, created_at DESC);
CREATE INDEX idx_webhook_delivery_status ON webhook_delivery_logs(status) WHERE status = 'DEAD_LETTER';

COMMIT;
