-- 1. Add 'disputed' to cash_request_status enum
ALTER TYPE cash_request_status ADD VALUE 'disputed';

-- 2. Extend cash_requests table with dispute info & audit trails
ALTER TABLE cash_requests 
ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS disputed_by VARCHAR(100),
ADD COLUMN IF NOT EXISTS dispute_reason TEXT,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(100),
ADD COLUMN IF NOT EXISTS resolution TEXT;

-- 3. Create index for disputed trades to optimize administrative views
CREATE INDEX IF NOT EXISTS idx_cash_requests_disputed ON cash_requests (status) WHERE status = 'disputed';
