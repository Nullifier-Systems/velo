import type { Pool, QueryResult } from "pg";
import { createHash } from "node:crypto";
import type { EscrowDelta } from "./escrow-deltas.js";
import type { IndexedEscrowEvent } from "./escrow-events.js";

export interface IndexerCheckpoint {
  ledger: number;
  validationLedger?: number;
  validationHash?: string;
}

export interface EventStore {
  checkpoint(): Promise<IndexerCheckpoint | null>;
  process(events: IndexedEscrowEvent[], throughLedger: number, ledgerHash?: string): Promise<EscrowDelta[]>;
  fingerprints(): Promise<Array<{ ledger: number; hash: string }>>;
  rollbackAfter(ledger: number): Promise<void>;
  escrow(contractId: string, escrowId: string): Promise<EscrowDelta | null>;
}

export type EventStoreTraceStage =
  | "transaction_started"
  | "transaction_committed";

export interface EventStoreTracePoint {
  stage: EventStoreTraceStage;
  monotonicMs: number;
}

function delta(row: any): EscrowDelta {
  return {
    contractId: row.contract_id,
    escrowId: row.escrow_id,
    status: row.status,
    lockedAmount: row.locked_amount === null ? null : String(row.locked_amount),
    releasedAmount: row.released_amount === null ? null : String(row.released_amount),
    disputedBy: row.disputed_by,
    lastLedger: Number(row.last_ledger),
  };
}

function eventVersion(event: IndexedEscrowEvent): string {
  return createHash("sha256").update(JSON.stringify([
    event.eventId,
    event.ledger,
    event.transactionHash ?? null,
    event.type,
    event.escrowId,
    event.amount ?? null,
    event.actor ?? null,
  ])).digest("hex");
}

export class PostgresEventStore implements EventStore {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly indexerName = "velo-escrow",
    private readonly onTrace?: (point: EventStoreTracePoint) => void,
  ) {}

  async checkpoint(): Promise<IndexerCheckpoint | null> {
    const result = await this.pool.query(
      `SELECT ledger_sequence, validation_ledger, validation_hash
         FROM stellar_indexer_checkpoints WHERE indexer_name = $1`,
      [this.indexerName],
    );
    if (!result.rows[0]) return null;
    return {
      ledger: Number(result.rows[0].ledger_sequence),
      validationLedger: result.rows[0].validation_ledger === null
        ? undefined : Number(result.rows[0].validation_ledger),
      validationHash: result.rows[0].validation_hash ?? undefined,
    };
  }

  async process(
    events: IndexedEscrowEvent[],
    throughLedger: number,
    ledgerHash?: string,
  ): Promise<EscrowDelta[]> {
    const client = await this.pool.connect();
    const changed = new Map<string, EscrowDelta>();
    try {
      await client.query("BEGIN");
      this.trace("transaction_started");
      // One PostgreSQL session owns the indexer. The transaction-scoped lock
      // prevents concurrent workers from advancing the same checkpoint.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [
        this.indexerName,
      ]);
      if (!lock.rows[0]?.acquired) throw new Error("another indexer instance owns the checkpoint");

      const serialized = events.map((event) => ({
        event_id: event.eventId,
        event_version: eventVersion(event),
        contract_id: event.contractId,
        ledger_sequence: event.ledger,
        event_order: event.order,
        transaction_hash: event.transactionHash ?? null,
        event_type: event.type,
        escrow_id: event.escrowId,
        amount: event.amount ?? null,
        actor: event.actor ?? null,
        raw_event: event.raw,
      }));
      const canonicalized = events.length
        ? await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS batch(
               event_id text, event_version text, contract_id text,
               ledger_sequence bigint, event_order integer, transaction_hash text,
               event_type text, escrow_id text, amount numeric, actor text, raw_event jsonb
             )
           ),
           inserted AS (
             INSERT INTO stellar_contract_events
               (event_id, event_version, contract_id, ledger_sequence, event_order,
                transaction_hash, event_type, escrow_id, amount, actor, raw_event)
             SELECT event_id, event_version, contract_id, ledger_sequence, event_order,
                    transaction_hash, event_type, escrow_id, amount, actor, raw_event
             FROM input
             ON CONFLICT (event_version) DO NOTHING
             RETURNING id, event_id, event_version
           ),
           records AS (
             SELECT id, event_id, event_version FROM inserted
             UNION ALL
             SELECT stored.id, stored.event_id, stored.event_version
             FROM stellar_contract_events stored
             JOIN input USING (event_version)
             WHERE NOT EXISTS (
               SELECT 1 FROM inserted WHERE inserted.event_version=stored.event_version
             )
           )
           INSERT INTO stellar_canonical_events (event_id, event_record_id)
           SELECT event_id, id FROM records
           ON CONFLICT (event_id) DO UPDATE
             SET event_record_id=EXCLUDED.event_record_id, canonicalized_at=now()
           WHERE stellar_canonical_events.event_record_id <> EXCLUDED.event_record_id
           RETURNING event_id, event_record_id`,
          [JSON.stringify(serialized)],
        )
        : { rows: [] };
      const canonicalIds = new Set(canonicalized.rows.map((row: any) => row.event_id));
      const newEvents = serialized.filter((event) => canonicalIds.has(event.event_id));
      if (newEvents.length) {
        const projected = await client.query(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS batch(
               contract_id text, escrow_id text, event_type text, amount numeric,
               actor text, ledger_sequence bigint, event_order integer
             )
           ),
           latest AS (
             SELECT DISTINCT ON (contract_id, escrow_id)
               contract_id, escrow_id, event_type, actor, ledger_sequence, event_order
             FROM input
             ORDER BY contract_id, escrow_id, ledger_sequence DESC, event_order DESC
           ),
           amounts AS (
             SELECT contract_id, escrow_id,
               MAX(amount) FILTER (WHERE event_type='locked') AS locked_amount,
               MAX(amount) FILTER (WHERE event_type='released') AS released_amount
             FROM input GROUP BY contract_id, escrow_id
           )
           INSERT INTO indexed_escrows
             (contract_id, escrow_id, status, locked_amount, released_amount,
              disputed_by, last_ledger, last_event_order)
           SELECT l.contract_id, l.escrow_id, l.event_type, a.locked_amount,
                  a.released_amount, l.actor, l.ledger_sequence, l.event_order
           FROM latest l JOIN amounts a USING (contract_id, escrow_id)
           ON CONFLICT (contract_id, escrow_id) DO UPDATE SET
             status=EXCLUDED.status,
             locked_amount=COALESCE(EXCLUDED.locked_amount, indexed_escrows.locked_amount),
             released_amount=COALESCE(EXCLUDED.released_amount, indexed_escrows.released_amount),
             disputed_by=COALESCE(EXCLUDED.disputed_by, indexed_escrows.disputed_by),
             last_ledger=EXCLUDED.last_ledger,
             last_event_order=EXCLUDED.last_event_order,
             updated_at=now()
           WHERE (indexed_escrows.last_ledger, indexed_escrows.last_event_order)
                 <= (EXCLUDED.last_ledger, EXCLUDED.last_event_order)
           RETURNING *`,
          [JSON.stringify(newEvents)],
        );
        for (const row of projected.rows) {
          const item = delta(row);
          changed.set(`${item.contractId}:${item.escrowId}`, item);
        }
      }

      const validation = ledgerHash ? throughLedger : null;
      if (validation !== null && ledgerHash) {
        await client.query(
          `INSERT INTO stellar_ledger_fingerprints (ledger_sequence, ledger_hash, event_count)
           VALUES ($1,$2,$3)
           ON CONFLICT (ledger_sequence) DO UPDATE
             SET ledger_hash=EXCLUDED.ledger_hash, event_count=EXCLUDED.event_count,
                 canonical=TRUE, indexed_at=now()`,
          [validation, ledgerHash, events.filter((event) => event.ledger === validation).length],
        );
      }
      await client.query(
        `INSERT INTO stellar_indexer_checkpoints
           (indexer_name, ledger_sequence, validation_ledger, validation_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (indexer_name) DO UPDATE
           SET ledger_sequence=EXCLUDED.ledger_sequence,
               validation_ledger=COALESCE(EXCLUDED.validation_ledger, stellar_indexer_checkpoints.validation_ledger),
               validation_hash=COALESCE(EXCLUDED.validation_hash, stellar_indexer_checkpoints.validation_hash),
               updated_at=now()`,
        [this.indexerName, throughLedger, validation, ledgerHash ?? null],
      );
      await client.query("COMMIT");
      this.trace("transaction_committed");
      return [...changed.values()];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fingerprints(): Promise<Array<{ ledger: number; hash: string }>> {
    const result = await this.pool.query(
      `SELECT ledger_sequence, ledger_hash FROM stellar_ledger_fingerprints
       WHERE canonical ORDER BY ledger_sequence DESC`,
    );
    return result.rows.map((row: any) => ({
      ledger: Number(row.ledger_sequence),
      hash: row.ledger_hash,
    }));
  }

  async rollbackAfter(ledger: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM stellar_canonical_events canonical
         USING stellar_contract_events event
         WHERE canonical.event_record_id=event.id AND event.ledger_sequence > $1`,
        [ledger],
      );
      await client.query(
        "UPDATE stellar_ledger_fingerprints SET canonical=FALSE WHERE canonical AND ledger_sequence > $1",
        [ledger],
      );
      await client.query("TRUNCATE indexed_escrows");
      await client.query(
        `INSERT INTO indexed_escrows
           (contract_id, escrow_id, status, locked_amount, released_amount,
            disputed_by, last_ledger, last_event_order)
         SELECT DISTINCT ON (contract_id, escrow_id)
           contract_id, escrow_id, event_type,
           MAX(amount) FILTER (WHERE event_type='locked') OVER escrow,
           MAX(amount) FILTER (WHERE event_type='released') OVER escrow,
           MAX(actor) FILTER (WHERE event_type='disputed') OVER escrow,
           ledger_sequence, event_order
         FROM stellar_contract_events event
         JOIN stellar_canonical_events canonical ON canonical.event_record_id=event.id
         WINDOW escrow AS (PARTITION BY contract_id, escrow_id)
         ORDER BY contract_id, escrow_id, ledger_sequence DESC, event_order DESC`,
      );
      const fingerprint = await client.query(
        `SELECT ledger_sequence, ledger_hash FROM stellar_ledger_fingerprints
         WHERE canonical AND ledger_sequence <= $1 ORDER BY ledger_sequence DESC LIMIT 1`,
        [ledger],
      );
      await client.query(
        `UPDATE stellar_indexer_checkpoints SET
           ledger_sequence=$2, validation_ledger=$3, validation_hash=$4, updated_at=now()
         WHERE indexer_name=$1`,
        [
          this.indexerName, ledger,
          fingerprint.rows[0]?.ledger_sequence ?? null,
          fingerprint.rows[0]?.ledger_hash ?? null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async escrow(contractId: string, escrowId: string): Promise<EscrowDelta | null> {
    const result: QueryResult = await this.pool.query(
      "SELECT * FROM indexed_escrows WHERE contract_id=$1 AND escrow_id=$2",
      [contractId, escrowId],
    );
    return result.rows[0] ? delta(result.rows[0]) : null;
  }

  private trace(stage: EventStoreTraceStage): void {
    this.onTrace?.({ stage, monotonicMs: performance.now() });
  }
}
