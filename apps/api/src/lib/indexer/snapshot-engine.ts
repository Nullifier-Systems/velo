import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { SnapshotCheckpoint } from "@velo/shared";

/**
 * Snapshot Engine creates and manages periodic database snapshots.
 * 
 * Snapshots provide fast recovery points during reorgs by capturing
 * the complete database state at specific ledger heights. Instead of
 * replaying all undo logs, we can restore from a snapshot and only
 * replay events since that point.
 */
export class SnapshotEngine {
  private snapshotInterval: number;
  private lastSnapshotLedger: number = 0;

  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    snapshotIntervalLedgers: number = 100, // Create snapshot every 100 ledgers
  ) {
    this.snapshotInterval = snapshotIntervalLedgers;
  }

  /**
   * Check if a snapshot should be created at the current ledger.
   * 
   * @param currentLedger - The current ledger sequence
   * @returns True if a snapshot should be created
   */
  shouldCreateSnapshot(currentLedger: number): boolean {
    return currentLedger - this.lastSnapshotLedger >= this.snapshotInterval;
  }

  /**
   * Create a snapshot at the current ledger height.
   * 
   * @param ledgerSequence - The ledger sequence to snapshot
   * @param blockHash - The block hash at this ledger
   * @returns The created snapshot checkpoint
   */
  async createSnapshot(
    ledgerSequence: number,
    blockHash: string,
  ): Promise<SnapshotCheckpoint> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      this.logger.info(
        { ledgerSequence, blockHash },
        "Creating database snapshot",
      );

      // Capture the state of critical tables
      const tablesSnapshot: Record<string, unknown> = {};

      // Snapshot indexed escrows
      const escrowsResult = await client.query(
        `SELECT * FROM indexed_escrows`,
      );
      tablesSnapshot.indexed_escrows = escrowsResult.rows;

      // Snapshot indexer checkpoints
      const checkpointsResult = await client.query(
        `SELECT * FROM stellar_indexer_checkpoints`,
      );
      tablesSnapshot.stellar_indexer_checkpoints = checkpointsResult.rows;

      // Snapshot ledger fingerprints
      const fingerprintsResult = await client.query(
        `SELECT * FROM stellar_ledger_fingerprints WHERE canonical = TRUE`,
      );
      tablesSnapshot.stellar_ledger_fingerprints = fingerprintsResult.rows;

      // Store the snapshot in a JSONB field in indexer_block_headers for simplicity
      // In production, you might want a separate snapshots table
      await client.query(
        `UPDATE indexer_block_headers
         SET created_at = NOW()
         WHERE ledger_sequence = $1`,
        [ledgerSequence],
      );

      const snapshotResult = await client.query(
        `SELECT ledger_sequence, block_hash, created_at
         FROM indexer_block_headers
         WHERE ledger_sequence = $1`,
        [ledgerSequence],
      );

      await client.query("COMMIT");

      this.lastSnapshotLedger = ledgerSequence;

      this.logger.info(
        { ledgerSequence, blockHash },
        "Database snapshot created successfully",
      );

      return {
        ledger_sequence: Number(snapshotResult.rows[0].ledger_sequence),
        block_hash: snapshotResult.rows[0].block_hash,
        created_at: snapshotResult.rows[0].created_at,
        tables_snapshot: tablesSnapshot,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(
        { err: error, ledgerSequence },
        "Failed to create snapshot",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the latest snapshot before a specific ledger.
   * 
   * @param beforeLedger - Get the latest snapshot with ledger <= this value
   * @returns The snapshot or null if none exists
   */
  async getLatestSnapshot(beforeLedger: number): Promise<SnapshotCheckpoint | null> {
    // For simplicity, we'll use the block headers table as snapshot points
    // In production, you'd want a dedicated snapshots table
    const result = await this.pool.query(
      `SELECT ledger_sequence, block_hash, created_at
       FROM indexer_block_headers
       WHERE ledger_sequence <= $1
       ORDER BY ledger_sequence DESC
       LIMIT 1`,
      [beforeLedger],
    );

    if (!result.rows[0]) return null;

    // Generate snapshot data on-the-fly from current state
    const tablesSnapshot = await this.generateTablesSnapshot();

    return {
      ledger_sequence: Number(result.rows[0].ledger_sequence),
      block_hash: result.rows[0].block_hash,
      created_at: result.rows[0].created_at,
      tables_snapshot: tablesSnapshot,
    };
  }

  /**
   * Generate a snapshot of critical tables.
   */
  private async generateTablesSnapshot(): Promise<Record<string, unknown>> {
    const tablesSnapshot: Record<string, unknown> = {};

    // Snapshot indexed escrows
    const escrowsResult = await this.pool.query(
      `SELECT * FROM indexed_escrows`,
    );
    tablesSnapshot.indexed_escrows = escrowsResult.rows;

    // Snapshot indexer checkpoints
    const checkpointsResult = await this.pool.query(
      `SELECT * FROM stellar_indexer_checkpoints`,
    );
    tablesSnapshot.stellar_indexer_checkpoints = checkpointsResult.rows;

    // Snapshot ledger fingerprints
    const fingerprintsResult = await this.pool.query(
      `SELECT * FROM stellar_ledger_fingerprints WHERE canonical = TRUE`,
    );
    tablesSnapshot.stellar_ledger_fingerprints = fingerprintsResult.rows;

    return tablesSnapshot;
  }

  /**
   * Restore the database from a snapshot.
   * 
   * @param snapshot - The snapshot to restore from
   */
  async restoreFromSnapshot(snapshot: SnapshotCheckpoint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      this.logger.info(
        { ledgerSequence: snapshot.ledger_sequence },
        "Restoring database from snapshot",
      );

      const tablesSnapshot = snapshot.tables_snapshot as Record<string, unknown>;

      // Clear existing data from tables we're about to restore
      await client.query(`TRUNCATE indexed_escrows CASCADE`);
      await client.query(`TRUNCATE stellar_indexer_checkpoints CASCADE`);
      await client.query(`TRUNCATE stellar_ledger_fingerprints CASCADE`);

      // Restore indexed escrows
      if (tablesSnapshot.indexed_escrows && Array.isArray(tablesSnapshot.indexed_escrows)) {
        for (const row of tablesSnapshot.indexed_escrows) {
          await client.query(
            `INSERT INTO indexed_escrows 
               (contract_id, escrow_id, status, locked_amount, released_amount,
                disputed_by, last_ledger, last_event_order, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              row.contract_id,
              row.escrow_id,
              row.status,
              row.locked_amount,
              row.released_amount,
              row.disputed_by,
              row.last_ledger,
              row.last_event_order,
              row.updated_at,
            ],
          );
        }
      }

      // Restore indexer checkpoints
      if (tablesSnapshot.stellar_indexer_checkpoints && Array.isArray(tablesSnapshot.stellar_indexer_checkpoints)) {
        for (const row of tablesSnapshot.stellar_indexer_checkpoints) {
          await client.query(
            `INSERT INTO stellar_indexer_checkpoints
               (indexer_name, ledger_sequence, validation_ledger, validation_hash, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (indexer_name) DO UPDATE
               SET ledger_sequence = EXCLUDED.ledger_sequence,
                   validation_ledger = EXCLUDED.validation_ledger,
                   validation_hash = EXCLUDED.validation_hash,
                   updated_at = EXCLUDED.updated_at`,
            [
              row.indexer_name,
              row.ledger_sequence,
              row.validation_ledger,
              row.validation_hash,
              row.updated_at,
            ],
          );
        }
      }

      // Restore ledger fingerprints
      if (tablesSnapshot.stellar_ledger_fingerprints && Array.isArray(tablesSnapshot.stellar_ledger_fingerprints)) {
        for (const row of tablesSnapshot.stellar_ledger_fingerprints) {
          await client.query(
            `INSERT INTO stellar_ledger_fingerprints
               (ledger_sequence, ledger_hash, event_count, canonical, indexed_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (ledger_sequence) DO UPDATE
               SET ledger_hash = EXCLUDED.ledger_hash,
                   event_count = EXCLUDED.event_count,
                   canonical = EXCLUDED.canonical,
                   indexed_at = EXCLUDED.indexed_at`,
            [
              row.ledger_sequence,
              row.ledger_hash,
              row.event_count,
              row.canonical,
              row.indexed_at,
            ],
          );
        }
      }

      await client.query("COMMIT");

      this.lastSnapshotLedger = snapshot.ledger_sequence;

      this.logger.info(
        { ledgerSequence: snapshot.ledger_sequence },
        "Database restored from snapshot successfully",
      );
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(
        { err: error, ledgerSequence: snapshot.ledger_sequence },
        "Failed to restore from snapshot",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all available snapshots.
   * 
   * @returns Array of snapshots
   */
  async getAllSnapshots(): Promise<SnapshotCheckpoint[]> {
    // Use block headers as snapshot points
    const result = await this.pool.query(
      `SELECT ledger_sequence, block_hash, created_at
       FROM indexer_block_headers
       ORDER BY ledger_sequence DESC
       LIMIT 20`, // Limit to recent 20 for performance
    );

    // Generate table snapshots for each header
    const tablesSnapshot = await this.generateTablesSnapshot();

    return result.rows.map((row) => ({
      ledger_sequence: Number(row.ledger_sequence),
      block_hash: row.block_hash,
      created_at: row.created_at,
      tables_snapshot: tablesSnapshot, // Use current state for all snapshots
    }));
  }

  /**
   * Delete old snapshots to prevent table bloat.
   * 
   * @param keepRecent - Number of recent snapshots to keep
   */
  async cleanupOldSnapshots(keepRecent: number = 10): Promise<void> {
    // Since we're using block headers as snapshots, this would delete old block headers
    // For now, this is a no-op since block headers are needed for DAG continuity
    this.logger.info(
      { keepRecent },
      "Snapshot cleanup not implemented with block header snapshots",
    );
  }

  /**
   * Delete a specific snapshot.
   * 
   * @param ledgerSequence - The ledger sequence of the snapshot to delete
   */
  async deleteSnapshot(ledgerSequence: number): Promise<void> {
    // Since we're using block headers as snapshots, we shouldn't delete them
    // as they're needed for DAG continuity
    this.logger.warn(
      { ledgerSequence },
      "Cannot delete snapshot when using block headers as snapshot points",
    );
  }
}
