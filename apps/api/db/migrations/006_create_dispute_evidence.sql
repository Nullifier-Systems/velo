-- Private image evidence uploaded by participants for operator dispute review.
CREATE TABLE dispute_evidence (
  id           UUID PRIMARY KEY,
  trade_id     TEXT NOT NULL REFERENCES cash_requests(id) ON DELETE CASCADE,
  uploaded_by  TEXT NOT NULL REFERENCES accounts(address),
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size_bytes)
);

CREATE INDEX dispute_evidence_trade_created_idx
  ON dispute_evidence (trade_id, created_at);
