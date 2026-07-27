-- Keep an elapsed lock distinct from an on-chain refund.
ALTER TYPE cash_request_status ADD VALUE IF NOT EXISTS 'expired' AFTER 'locked';
