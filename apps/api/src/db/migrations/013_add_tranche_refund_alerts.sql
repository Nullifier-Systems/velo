CREATE TYPE alert_notification_status AS ENUM ('PENDING', 'WARNING_SENT', 'REFUND_EXECUTED', 'CANCELLED');

CREATE TABLE tranche_refund_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id VARCHAR(64) NOT NULL UNIQUE REFERENCES cash_requests(id) ON DELETE CASCADE,
    total_tranches INT NOT NULL,
    unreleased_tranches INT NOT NULL,
    unreleased_amount BIGINT NOT NULL,
    timeout_ledger_sequence INT NOT NULL,
    status alert_notification_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tranche_timeout ON tranche_refund_schedules(timeout_ledger_sequence, status);
