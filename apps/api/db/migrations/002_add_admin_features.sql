
-- 1. Extend cash requests to support fraud flagging & operational auditing
ALTER TABLE cash_requests 
ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN DEFAULT FALSE NOT NULL,
ADD COLUMN IF NOT EXISTS suspicion_notes TEXT,
ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS admin_override_by VARCHAR(100),
ADD COLUMN IF NOT EXISTS admin_override_at TIMESTAMP WITH TIME ZONE;

-- 2. Indexes to ensure admin queries perform at sub-millisecond speeds
CREATE INDEX IF NOT EXISTS idx_cash_requests_suspicious ON cash_requests (is_suspicious) WHERE is_suspicious = TRUE;
CREATE INDEX IF NOT EXISTS idx_cash_requests_status_created ON cash_requests (status, created_at DESC);