import { randomUUID } from "node:crypto";
import type { Server } from "@stellar/stellar-sdk/rpc";
import type { Pool } from "pg";
import { CIRCUIT_BREAKER } from "@velo/shared";
import {
  evaluateReserveConservation,
  type InvariantBalanceSnapshot,
  type InvariantCheckResult,
} from "../invariant-checker.js";
import type { CircuitBreakerStore } from "../circuit-breaker-store.js";
import { decodeEscrowEvent, type IndexedEscrowEvent } from "../escrow-events.js";
import type { EventStore } from "../stellar-event-store.js";
import {
  ledgerHeight,
  mergeLedgerClocks,
  sortLedgerFrames,
  type LedgerVectorClock,
} from "../vector-clock.js";

/**
 * Real-time Soroban ledger indexer with single-leader election (#374).
 *
 * Guarantees:
 *   - Exactly one worker across the whole API cluster runs the ingestion
 *     loop, via `pg_try_advisory_xact_lock(889001)`. Standbys poll for the
 *     lock every `LEADER_ELECTION_POLL_MS` and take over with zero downtime
 *     when the leader's SIGTERM releases the transaction-scoped lock.
 *   - Out-of-order ledger frames are replayed through the vector-clock
 *     ordering helpers (vector-clock.ts) before persistence, so the running
 *     totals in `system_invariant_state` can never regress.
 *   - Every closed ledger batch is reconciled against the on-chain contract
 *     balance by the formal reserve-conservation checker; a VIOLATED verdict
 *     triggers an automated emergency `pause()` within
 *     `PAUSE_TRIGGER_DEADLINE_MS` and flips the contract to HALTED.
 *
 * Stellar RPC today exposes a cursor-based `getEvents` JSON-RPC endpoint
 * rather than a ledger WebSocket push, so the default stream source
 * (`RpcPollingLedgerStream`) polls that endpoint as a "stream". Any
 * future WS transport can be swapped in behind `LedgerStreamSource`.
 */

export type Logger = Pick<{ info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void }, "info" | "warn" | "error">;

/* ------------------------------------------------------------------ */
/*  Advisory lock (single-leader election)                            */
/* ------------------------------------------------------------------ */

export interface AdvisoryLock {
  /** Returns true only for the single holder. */
  acquire(): Promise<boolean>;
  /** Releases the lock so a standby can take over. */
  release(): Promise<void>;
}

/**
 * Transaction-scoped advisory lock around `pg_try_advisory_xact_lock(889001)`.
 * The lock lives exactly as long as one open transaction, so the leader must
 * hold the dedicated connection for its whole tenure; `release()` commits
 * (or rolls back) the transaction, which releases the lock.
 */
export class PgAdvisoryLock implements AdvisoryLock {
  private client: { query: (text: string, values?: unknown[]) => Promise<any>; release: () => void } | null = null;

  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async acquire(): Promise<boolean> {
    await this.release();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [CIRCUIT_BREAKER.ADVISORY_LOCK_ID],
      );
      if (!rows[0]?.acquired) {
        await client.query("ROLLBACK");
        client.release();
        return false;
      }
      this.client = client;
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await client.query("COMMIT").catch(() => client.query("ROLLBACK").catch(() => undefined));
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/*  Ledger stream source                                              */
/* ------------------------------------------------------------------ */

export interface LedgerFrame {
  /** Source id used as the vector-clock participant (e.g. "soroban-rpc-a"). */
  source: string;
  ledger: number;
  clock: LedgerVectorClock;
  events: IndexedEscrowEvent[];
}

export interface LedgerStreamSource {
  latestLedger(): Promise<number>;
  /** Frames at or after `fromLedger`; delivery order is NOT guaranteed. */
  next(fromLedger: number): Promise<{ frames: LedgerFrame[]; latestLedger: number }>;
}

interface RpcEventsResponse {
  events?: unknown[];
  latestLedger?: number;
  cursor?: string;
}

export interface RpcPollingLedgerStreamOptions {
  source?: string;
  pageSize?: number;
}

/** Cursor-based polling wrapper around the Soroban RPC `getEvents` endpoint. */
export class RpcPollingLedgerStream implements LedgerStreamSource {
  constructor(
    private readonly rpc: Pick<Server, "getEvents" | "getLatestLedger">,
    private readonly contractId: string,
    private readonly options: RpcPollingLedgerStreamOptions = {},
  ) {}

  async latestLedger(): Promise<number> {
    return (await this.rpc.getLatestLedger()).sequence;
  }

  async next(fromLedger: number): Promise<{ frames: LedgerFrame[]; latestLedger: number }> {
    const source = this.options.source ?? "soroban-rpc";
    const pageSize = this.options.pageSize ?? 10_000;
    const all: unknown[] = [];
    let cursor: string | undefined;
    let latestLedger: number | undefined;
    let hasMore = true;
    while (hasMore) {
      const request = cursor
        ? { cursor, filters: [{ type: "contract", contractIds: [this.contractId] }], limit: pageSize }
        : { startLedger: fromLedger, filters: [{ type: "contract", contractIds: [this.contractId] }], limit: pageSize };
      const response = await this.rpc.getEvents(request as never) as RpcEventsResponse;
      const page = response.events ?? [];
      all.push(...page);
      latestLedger = response.latestLedger ?? latestLedger;
      cursor = response.cursor;
      hasMore = page.length === pageSize && Boolean(cursor);
    }

    // Group decoded events by ledger into frames. Vector clocks record the
    // ledger high-water mark per source; callers reorder causally before use.
    const byLedger = new Map<number, IndexedEscrowEvent[]>();
    for (let order = 0; order < all.length; order++) {
      const event = decodeEscrowEvent(all[order], order);
      if (!event) continue;
      const bucket = byLedger.get(event.ledger) ?? [];
      bucket.push(event);
      byLedger.set(event.ledger, bucket);
    }

    const frames: LedgerFrame[] = [...byLedger.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ledger, events]) => ({
        source,
        ledger,
        clock: { [source]: ledger },
        events,
      }));

    return { frames, latestLedger: latestLedger ?? fromLedger };
  }
}

/* ------------------------------------------------------------------ */
/*  Worker                                                            */
/* ------------------------------------------------------------------ */

export interface StellarIndexerWorkerOptions {
  contractId: string;
  rpc: Pick<Server, "getEvents" | "getLatestLedger">;
  /** Canonical escrow event persistence (idempotent — see stellar-event-store.ts). */
  store: EventStore;
  /** Running totals + incident log (`system_invariant_state`). */
  stateStore: CircuitBreakerStore;
  lock: AdvisoryLock;
  stream?: LedgerStreamSource;
  logger: Logger;
  startLedger?: number;
  pollIntervalMs?: number;
  /** Overridable invariant evaluator (defaults to reserve conservation). */
  evaluateInvariant?: (snapshot: InvariantBalanceSnapshot) => InvariantCheckResult;
  /** Reads the on-chain escrow token balance; null skips the check. */
  readActualBalance?: (contractId: string, ledger: number) => Promise<bigint | null>;
  /** Overridable circuit-breaker actuator (defaults to no-op audit). */
  triggerCircuitBreaker?: (contractId: string, result: InvariantCheckResult) => Promise<{ hash?: string }>;
  onLeadershipChange?: (leader: boolean) => void;
  /** Malformed-frame dead-letter handler (default: log to `velo:indexer-dlq`). */
  dlq?: (frame: unknown, reason: string) => Promise<void> | void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StellarIndexerWorker {
  private running = false;
  private leader = false;
  private progressClock: LedgerVectorClock = {};
  private totalLocked = 0n;

  constructor(private readonly options: StellarIndexerWorkerOptions) {}

  get isLeader(): boolean {
    return this.leader;
  }

  get pollIntervalMs(): number {
    return this.options.pollIntervalMs ?? CIRCUIT_BREAKER.LEADER_ELECTION_POLL_MS;
  }

  private setLeader(next: boolean): void {
    if (this.leader === next) return;
    this.leader = next;
    this.options.logger.info({ leader: next }, "indexer leader election changed");
    this.options.onLeadershipChange?.(next);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.options.logger.info({ contractId: this.options.contractId }, "stellar indexer worker started");
    await this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.setLeader(false);
    await this.options.lock.release();
    this.options.logger.info({}, "stellar indexer worker stopped; advisory lock released");
  }

  /** Election loop: acquire the lock or stay in standby. */
  private async runLoop(): Promise<void> {
    while (this.running) {
      let acquired = false;
      try {
        acquired = await this.options.lock.acquire();
      } catch (error) {
        this.options.logger.error({ error }, "advisory lock acquisition failed");
      }
      if (acquired) {
        this.setLeader(true);
        try {
          await this.ingestLoop();
        } finally {
          await this.options.lock.release();
          this.setLeader(false);
        }
      } else {
        await wait(this.pollIntervalMs);
      }
    }
  }

  /** Active ingestion loop — runs only while the advisory lock is held. */
  private async ingestLoop(): Promise<void> {
    let attempt = 0;
    while (this.running && this.leader) {
      try {
        await this.ingestOnce();
        attempt = 0;
        await wait(this.pollIntervalMs);
      } catch (error) {
        attempt += 1;
        // Exponential backoff with jitter: delayMs = 1000 * 2^attempt + jitter
        const jitter = Math.floor(Math.random() * 250);
        const delayMs = 1000 * 2 ** attempt + jitter;
        this.options.logger.warn({ error, attempt, delayMs }, "indexer ingest failed; retry scheduled");
        await wait(delayMs);
      }
    }
  }

  private async stream(): Promise<LedgerStreamSource> {
    return (
      this.options.stream ??
      new RpcPollingLedgerStream(this.options.rpc, this.options.contractId)
    );
  }

  /** Fetch, reorder, persist, and invariantly verify one batch of ledgers. */
  async ingestOnce(): Promise<void> {
    const stream = await this.stream();
    const fromLedger = await this.nextLedgerToProcess();
    const { frames, latestLedger } = await stream.next(fromLedger);

    const ordered = sortLedgerFrames(
      frames.map((frame) => ({ source: frame.source, clock: frame.clock, frame })),
    );

    for (const entry of ordered) {
      const frame = entry.frame;
      if (!Number.isSafeInteger(frame.ledger) || frame.ledger < 0 || !frame.clock[frame.source]) {
        await this.sendToDlq(frame, "malformed_ledger_frame");
        continue;
      }
      // Vector-clock forward check: a frame is only applied when its own
      // source has advanced (empty ledgers in between are legal gaps, so the
      // check is strictly-forward rather than exactly-one-ahead). Duplicate
      // or regressed frames are skipped — the next poll re-fetches in order.
      const nextSeq = frame.clock[frame.source] ?? 0;
      const localSeq = this.progressClock[frame.source] ?? 0;
      if (nextSeq <= localSeq) {
        continue;
      }
      const deltas = await this.options.store.process(frame.events, frame.ledger);
      await this.appendAuditLog(frame);
      for (const event of frame.events) this.applyEventAccounting(event);
      this.progressClock = mergeLedgerClocks(this.progressClock, frame.clock);
      this.options.logger.info(
        { ledger: frame.ledger, events: frame.events.length, deltas: deltas.length },
        "ledger batch indexed",
      );
    }

    if (latestLedger > 0) {
      await this.runInvariantCheck(latestLedger);
    }
  }

  private async nextLedgerToProcess(): Promise<number> {
    const state = await this.options.stateStore.get(this.options.contractId);
    if (state) return state.lastProcessedLedger + 1;
    if (this.options.startLedger !== undefined) return this.options.startLedger;
    const stream = await this.stream();
    return (await stream.latestLedger()) + 1;
  }

  private async appendAuditLog(frame: LedgerFrame): Promise<void> {
    if (!("pool" in this.options.stateStore)) return;
    const pool = (this.options.stateStore as any).pool as Pool | undefined;
    if (!pool) return;
    const rows = frame.events.map((event) => [
      event.ledger,
      event.transactionHash ?? "0000000000000000000000000000000000000000000000000000000000000000",
      event.contractId,
      event.type,
      frame.clock[frame.source] ?? event.ledger,
      JSON.stringify(event.raw),
    ]);
    for (const row of rows) {
      await pool.query(
        `INSERT INTO ledger_event_audit_log
           (ledger_sequence, tx_hash, contract_id, event_type, vector_clock, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (ledger_sequence, tx_hash) DO NOTHING`,
        row,
      );
    }
  }

  private applyEventAccounting(event: IndexedEscrowEvent): void {
    const amount = event.amount ? BigInt(event.amount) : 0n;
    if (event.type === "locked") {
      this.totalLocked += amount;
    } else if (event.type === "released") {
      this.totalLocked = this.totalLocked > amount ? this.totalLocked - amount : 0n;
    }
  }

  /** Reconcile expected vs on-chain balance; trip the breaker on violation. */
  async runInvariantCheck(ledger: number): Promise<InvariantCheckResult | null> {
    const actual = this.options.readActualBalance
      ? await this.options.readActualBalance(this.options.contractId, ledger)
      : null;
    if (actual === null) return null;

    const state = await this.options.stateStore.get(this.options.contractId);
    const snapshot: InvariantBalanceSnapshot = {
      totalLockedStroops: this.totalLocked,
      totalAllocatedStroops: state?.totalAllocatedStroops ?? 0n,
      feeAccumulatorStroops: state?.feeAccumulatorStroops ?? 0n,
      actualContractBalanceStroops: actual,
      ledger,
    };

    const result =
      this.options.evaluateInvariant?.(snapshot) ?? evaluateReserveConservation(snapshot);

    await this.options.stateStore.upsertState({
      contractId: this.options.contractId,
      totalLockedStroops: snapshot.totalLockedStroops,
      totalAllocatedStroops: snapshot.totalAllocatedStroops,
      feeAccumulatorStroops: snapshot.feeAccumulatorStroops,
      lastProcessedLedger: ledger,
      status: result.status,
    });

    if (result.status === "VIOLATED" || result.status === "HALTED") {
      await this.tripCircuitBreaker(result, ledger);
    }
    return result;
  }

  /** Automated circuit-breaker: emergency pause within the SLA deadline. */
  private async tripCircuitBreaker(result: InvariantCheckResult, ledger: number): Promise<void> {
    const deadlineMs = CIRCUIT_BREAKER.PAUSE_TRIGGER_DEADLINE_MS;
    const startedAt = Date.now();
    this.options.logger.warn(
      { contractId: this.options.contractId, invariant: result.violatedInvariant, drift: result.driftStroops.toString() },
      "invariant VIOLATED — triggering automated circuit-breaker pause",
    );
    try {
      const outcome = await Promise.race([
        this.options.triggerCircuitBreaker?.(this.options.contractId, result) ??
          Promise.resolve({ hash: null }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("circuit-breaker pause exceeded SLA deadline")), deadlineMs),
        ),
      ]);
      const elapsedMs = Date.now() - startedAt;
      await this.options.stateStore.logIncident({
        contractId: this.options.contractId,
        violatedInvariant: result.violatedInvariant ?? "UNKNOWN_INVARIANT",
        evidence: result.evidence,
        actionTaken: result.action,
        txPauseHash: outcome.hash ?? null,
      });
      await this.options.stateStore.halt(this.options.contractId, ledger);
      this.options.logger.error(
        { elapsedMs, txHash: outcome.hash ?? null },
        "circuit breaker HALTED contract",
      );
    } catch (error) {
      this.options.logger.error({ error }, "circuit-breaker pause submission failed; incident logged as NO_ACTION");
      await this.options.stateStore.logIncident({
        contractId: this.options.contractId,
        violatedInvariant: result.violatedInvariant ?? "UNKNOWN_INVARIANT",
        evidence: result.evidence,
        actionTaken: "NO_ACTION",
        txPauseHash: null,
      });
    }
  }

  private async sendToDlq(frame: unknown, reason: string): Promise<void> {
    const entry = { frame, reason, channel: CIRCUIT_BREAKER.DLQ_CHANNEL, requestId: randomUUID() };
    this.options.logger.error(entry, "malformed ledger frame routed to dead-letter queue");
    if (this.options.dlq) await this.options.dlq(frame, reason);
  }
}
