-- 025_add_double_ratchet_e2ee.sql
-- Double-Ratchet End-to-End Encrypted P2P Media & Chat Storage Engine (Issue #407)

CREATE TABLE IF NOT EXISTS e2ee_identity_keys (
  address VARCHAR(56) PRIMARY KEY,
  identity_public_key TEXT NOT NULL,
  signed_prekey_id INT NOT NULL DEFAULT 1,
  signed_prekey_public_key TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS e2ee_one_time_prekeys (
  address VARCHAR(56) NOT NULL,
  key_id INT NOT NULL,
  one_time_public_key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (address, key_id)
);

CREATE TABLE IF NOT EXISTS e2ee_ciphertext_messages (
  id VARCHAR(64) PRIMARY KEY,
  trade_id VARCHAR(64) NOT NULL,
  sender VARCHAR(56) NOT NULL,
  header JSONB NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  x3dh_init JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_e2ee_messages_trade ON e2ee_ciphertext_messages(trade_id, created_at);
