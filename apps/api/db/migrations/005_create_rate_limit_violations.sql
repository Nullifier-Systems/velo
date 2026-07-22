BEGIN;

CREATE TYPE rate_limit_violation_severity AS ENUM ('low', 'medium', 'high');
CREATE TYPE rate_limit_violation_status AS ENUM ('open', 'resolved');

CREATE TABLE rate_limit_violations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier    TEXT NOT NULL,
  route         TEXT NOT NULL,
  method        TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  offense_count INTEGER NOT NULL DEFAULT 1 CHECK (offense_count > 0),
  severity      rate_limit_violation_severity NOT NULL DEFAULT 'low',
  status        rate_limit_violation_status NOT NULL DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

-- One actionable record per identifier/route/method. Further blocked
-- requests increment its count until an operator resolves it.
CREATE UNIQUE INDEX rate_limit_violations_open_offense_idx
  ON rate_limit_violations (identifier, route, method)
  WHERE status = 'open';
CREATE INDEX rate_limit_violations_occurred_at_idx
  ON rate_limit_violations (occurred_at DESC);
CREATE INDEX rate_limit_violations_severity_idx
  ON rate_limit_violations (severity, occurred_at DESC);

COMMIT;
