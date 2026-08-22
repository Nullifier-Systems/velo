BEGIN;

-- Audit log for WebSocket chat sessions. Every client connection that binds
-- to a trade chat stream records one row; `disconnected_at` and
-- `disconnect_reason` are back-filled when the socket is torn down (clean
-- close, heartbeat timeout, or abrupt network drop). This lets operators
-- measure session churn and confirm the 15s heartbeat garbage collector is
-- releasing dead connections.

CREATE TABLE chat_session_connection_logs (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id VARCHAR(64) NOT NULL,
    client_ip VARCHAR(45) NOT NULL,
    connected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    disconnected_at TIMESTAMP WITH TIME ZONE NULL,
    disconnect_reason VARCHAR(64) NULL
);

CREATE INDEX idx_chat_logs_trade ON chat_session_connection_logs(trade_id);

COMMIT;