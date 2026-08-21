-- Fee Precision Audit Log (Issue #381)
--
-- Records every tranche settlement the API pre-checks with safe fee
-- arithmetic before submitting on-chain, so PR validation and the
-- fee invariant auditor worker can verify that for 100% of trades:
--   gross_amount_stroops == net_payout_stroops + calculated_fee_stroops
CREATE TABLE IF NOT EXISTS fee_precision_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id VARCHAR(64) NOT NULL,
  tranche_index INT NOT NULL,
  gross_amount_stroops BIGINT NOT NULL,
  calculated_fee_stroops BIGINT NOT NULL,
  net_payout_stroops BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fee_audit_trade ON fee_precision_audit_log (trade_id);
