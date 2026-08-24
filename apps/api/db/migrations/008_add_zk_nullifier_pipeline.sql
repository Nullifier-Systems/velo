-- Zero-Knowledge Nullifier Escrow Settlement & Dispute Resolution Pipeline (Issue #371)
CREATE TABLE IF NOT EXISTS zk_nullifier_registry (
  nullifier_hash VARCHAR(64) PRIMARY KEY,
  commitment VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SETTLED', 'REJECTED')),
  tx_hash VARCHAR(64),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zk_nullifier_registry_status ON zk_nullifier_registry (status);
