import type { Pool } from "pg";
import type { CircuitBreakerAction, InvariantCheckStatus } from "@velo/shared";
import type { InvariantCheckResult } from "./invariant-checker.js";

/** Row shape of `system_invariant_state`. */
export interface SystemInvariantState {
  contractId: string;
  totalLockedStroops: bigint;
  totalAllocatedStroops: bigint;
  feeAccumulatorStroops: bigint;
  lastProcessedLedger: number;
  status: InvariantCheckStatus;
  updatedAt?: string;
}

export interface CircuitBreakerIncident {
  incidentId?: string;
  contractId: string;
  violatedInvariant: string;
  evidence: InvariantCheckResult["evidence"];
  actionTaken: CircuitBreakerAction;
  txPauseHash?: string | null;
  resolvedAt?: string | null;
}

function rowToState(row: any): SystemInvariantState {
  return {
    contractId: row.contract_id,
    totalLockedStroops: BigInt(row.total_locked_stroops),
    totalAllocatedStroops: BigInt(row.total_allocated_stroops),
    feeAccumulatorStroops: BigInt(row.fee_accumulator_stroops),
    lastProcessedLedger: Number(row.last_processed_ledger),
    status: row.status,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository over `system_invariant_state` + `circuit_breaker_incidents`.
 * Backed by Postgres when a `pg` pool is available and by an in-memory map
 * otherwise (local dev / tests), mirroring the existing store.ts pattern.
 */
export class CircuitBreakerStore {
  private memory = new Map<string, SystemInvariantState>();
  private memoryIncidents: CircuitBreakerIncident[] = [];

  constructor(private readonly pool?: Pick<Pool, "connect" | "query">) {}

  async get(contractId: string): Promise<SystemInvariantState | null> {
    if (!this.pool) return this.memory.get(contractId) ?? null;
    const { rows } = await this.pool.query(
      `SELECT contract_id, total_locked_stroops, total_allocated_stroops,
              fee_accumulator_stroops, last_processed_ledger, status, updated_at
         FROM system_invariant_state WHERE contract_id = $1`,
      [contractId],
    );
    return rows[0] ? rowToState(rows[0]) : null;
  }

  /** Upsert running totals after a processed ledger batch. */
  async upsertState(state: SystemInvariantState): Promise<void> {
    if (!this.pool) {
      this.memory.set(state.contractId, state);
      return;
    }
    await this.pool.query(
      `INSERT INTO system_invariant_state
         (contract_id, total_locked_stroops, total_allocated_stroops,
          fee_accumulator_stroops, last_processed_ledger, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (contract_id) DO UPDATE SET
         total_locked_stroops=EXCLUDED.total_locked_stroops,
         total_allocated_stroops=EXCLUDED.total_allocated_stroops,
         fee_accumulator_stroops=EXCLUDED.fee_accumulator_stroops,
         last_processed_ledger=EXCLUDED.last_processed_ledger,
         status=EXCLUDED.status,
         updated_at=now()`,
      [
        state.contractId,
        state.totalLockedStroops.toString(),
        state.totalAllocatedStroops.toString(),
        state.feeAccumulatorStroops.toString(),
        state.lastProcessedLedger,
        state.status,
      ],
    );
  }

  /** Mark a contract HALTED after an automated pause was submitted on-chain. */
  async halt(contractId: string, ledger: number): Promise<void> {
    const current = await this.get(contractId);
    await this.upsertState({
      contractId,
      totalLockedStroops: current?.totalLockedStroops ?? 0n,
      totalAllocatedStroops: current?.totalAllocatedStroops ?? 0n,
      feeAccumulatorStroops: current?.feeAccumulatorStroops ?? 0n,
      lastProcessedLedger: ledger,
      status: "HALTED",
    });
  }

  /** Log a violation or an admin override incident. */
  async logIncident(incident: CircuitBreakerIncident): Promise<string> {
    if (!this.pool) {
      const id = `inc-${this.memoryIncidents.length + 1}`;
      this.memoryIncidents.push({ ...incident, incidentId: id });
      return id;
    }
    const { rows } = await this.pool.query(
      `INSERT INTO circuit_breaker_incidents
         (contract_id, violated_invariant, evidence_payload, action_taken, tx_pause_hash, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING incident_id`,
      [
        incident.contractId,
        incident.violatedInvariant,
        JSON.stringify(incident.evidence),
        incident.actionTaken,
        incident.txPauseHash ?? null,
        incident.resolvedAt ?? null,
      ],
    );
    return String(rows[0].incident_id);
  }

  async incidents(contractId?: string): Promise<CircuitBreakerIncident[]> {
    if (!this.pool) {
      const all = [...this.memoryIncidents].reverse();
      return contractId ? all.filter((item) => item.contractId === contractId) : all;
    }
    const { rows } = await this.pool.query(
      `SELECT incident_id, contract_id, violated_invariant, evidence_payload,
              action_taken, tx_pause_hash, resolved_at
         FROM circuit_breaker_incidents
        WHERE $1::text IS NULL OR contract_id = $1
        ORDER BY incident_id DESC`,
      [contractId ?? null],
    );
    return rows.map((row: any) => ({
      incidentId: String(row.incident_id),
      contractId: row.contract_id,
      violatedInvariant: row.violated_invariant,
      evidence: row.evidence_payload,
      actionTaken: row.action_taken,
      txPauseHash: row.tx_pause_hash,
      resolvedAt: row.resolved_at,
    }));
  }
}

export interface CircuitBreakerOverrideRequest {
  contractId: string;
  action: "FORCE_PAUSE" | "UNPAUSE";
  reason: string;
  txPauseHash?: string | null;
}

export interface CircuitBreakerOverrideOutcome {
  applied: boolean;
  conflictStatus?: InvariantCheckStatus;
  state: SystemInvariantState | null;
  incidentId?: string;
}

export class CircuitBreakerOverrideService {
  constructor(private readonly store: CircuitBreakerStore) {}

  /**
   * Apply a manual admin override under a pessimistic lock (#374).
   *
   * Postgres path: `SELECT ... FOR UPDATE` on `system_invariant_state`, then
   * the status transition + incident audit entry commit in the SAME
   * transaction, so two concurrent admins can never double-transition.
   * In-memory path: equivalent guard against the already-requested state.
   */
  async apply(request: CircuitBreakerOverrideRequest): Promise<CircuitBreakerOverrideOutcome> {
    const nextStatus: InvariantCheckStatus = request.action === "FORCE_PAUSE" ? "HALTED" : "HEALTHY";
    const store = this.store as any;

    if (!store.pool) {
      const state = await this.store.get(request.contractId);
      if (!state) return { applied: false, state: null };
      if (request.action === "FORCE_PAUSE" && state.status === "HALTED") {
        return { applied: false, conflictStatus: state.status, state };
      }
      if (request.action === "UNPAUSE" && state.status !== "HALTED") {
        return { applied: false, conflictStatus: state.status, state };
      }
      const updated: SystemInvariantState = { ...state, status: nextStatus, updatedAt: new Date().toISOString() };
      await store.upsertState(updated);
      const incidentId = await this.store.logIncident({
        contractId: request.contractId,
        violatedInvariant: `ADMIN_OVERRIDE:${request.action}`,
        evidence: { reason: request.reason, action: request.action },
        actionTaken: request.action === "FORCE_PAUSE" ? "PAUSE_SINGLE_ESCROW" : "NO_ACTION",
        txPauseHash: request.txPauseHash ?? null,
      });
      return { applied: true, state: updated, incidentId };
    }

    const client = await store.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT contract_id, total_locked_stroops, total_allocated_stroops,
                fee_accumulator_stroops, last_processed_ledger, status
           FROM system_invariant_state WHERE contract_id = $1 FOR UPDATE`,
        [request.contractId],
      );
      const state = rows[0] ? rowToState(rows[0]) : null;
      if (!state) {
        await client.query("COMMIT");
        return { applied: false, state: null };
      }
      if (request.action === "FORCE_PAUSE" && state.status === "HALTED") {
        await client.query("COMMIT");
        return { applied: false, conflictStatus: state.status, state };
      }
      if (request.action === "UNPAUSE" && state.status !== "HALTED") {
        await client.query("COMMIT");
        return { applied: false, conflictStatus: state.status, state };
      }
      await client.query(
        `UPDATE system_invariant_state SET status = $1, updated_at = now() WHERE contract_id = $2`,
        [nextStatus, request.contractId],
      );
      const { rows: incidentRows } = await client.query(
        `INSERT INTO circuit_breaker_incidents
           (contract_id, violated_invariant, evidence_payload, action_taken, tx_pause_hash)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING incident_id`,
        [
          request.contractId,
          `ADMIN_OVERRIDE:${request.action}`,
          JSON.stringify({ reason: request.reason, action: request.action }),
          request.action === "FORCE_PAUSE" ? "PAUSE_SINGLE_ESCROW" : "NO_ACTION",
          request.txPauseHash ?? null,
        ],
      );
      await client.query("COMMIT");
      return {
        applied: true,
        state: { ...state, status: nextStatus },
        incidentId: String(incidentRows[0].incident_id),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
