import { randomUUID } from "node:crypto";

export type RateLimitViolationSeverity = "low" | "medium" | "high";
export type RateLimitViolationStatus = "open" | "resolved";

export interface RateLimitViolationRecord {
  id: string;
  identifier: string;
  route: string;
  method: string;
  occurredAt: string;
  offenseCount: number;
  severity: RateLimitViolationSeverity;
  status: RateLimitViolationStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface RateLimitViolationDatabase {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}

const violations = new Map<string, RateLimitViolationRecord>();

function offenseKey(identifier: string, route: string, method: string): string {
  return `${identifier}\u0000${route}\u0000${method}`;
}

export function severityForOffenseCount(count: number): RateLimitViolationSeverity {
  if (count >= 10) return "high";
  if (count >= 3) return "medium";
  return "low";
}

/**
 * Records a blocked request without participating in the limiter decision.
 * The in-memory write is synchronous; the optional database write is
 * best-effort because @fastify/rate-limit's onExceeded callback is synchronous.
 */
export function recordRateLimitViolation(
  input: { identifier: string; route: string; method: string; occurredAt?: Date },
  database?: RateLimitViolationDatabase,
): RateLimitViolationRecord {
  const key = offenseKey(input.identifier, input.route, input.method);
  const existing = violations.get(key);
  const offenseCount = (existing?.offenseCount ?? 0) + 1;
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  const record: RateLimitViolationRecord = {
    id: existing?.id ?? randomUUID(),
    identifier: input.identifier,
    route: input.route,
    method: input.method,
    occurredAt,
    offenseCount,
    severity: severityForOffenseCount(offenseCount),
    status: "open",
    resolvedAt: null,
    resolvedBy: null,
  };
  violations.set(key, record);

  if (database) {
    void database.query(
      `
        INSERT INTO rate_limit_violations
          (identifier, route, method, occurred_at, offense_count, severity)
        VALUES ($1, $2, $3, $4, 1, 'low')
        ON CONFLICT (identifier, route, method) WHERE status = 'open'
        DO UPDATE SET
          occurred_at = EXCLUDED.occurred_at,
          offense_count = rate_limit_violations.offense_count + 1,
          severity = CASE
            WHEN rate_limit_violations.offense_count + 1 >= 10 THEN 'high'::rate_limit_violation_severity
            WHEN rate_limit_violations.offense_count + 1 >= 3 THEN 'medium'::rate_limit_violation_severity
            ELSE 'low'::rate_limit_violation_severity
          END
      `,
      [input.identifier, input.route, input.method, occurredAt],
    ).catch(() => {
      // Rate-limit enforcement and its 429 response must never depend on
      // abuse-event logging availability.
    });
  }

  return record;
}

export function getRateLimitViolations(): RateLimitViolationRecord[] {
  return Array.from(violations.values());
}

export function resolveRateLimitViolation(
  id: string,
  resolvedBy: string,
  resolvedAt = new Date(),
): RateLimitViolationRecord | undefined {
  for (const [key, record] of violations) {
    if (record.id !== id) continue;

    const resolved: RateLimitViolationRecord = {
      ...record,
      status: "resolved",
      resolvedAt: record.resolvedAt ?? resolvedAt.toISOString(),
      resolvedBy: record.resolvedBy ?? resolvedBy,
    };
    violations.set(key, resolved);
    return resolved;
  }
  return undefined;
}

export function clearRateLimitViolations(): void {
  violations.clear();
}
