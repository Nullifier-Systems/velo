import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type {
  IndexerUndoLog,
  IndexerReorgEvent,
  ReorgDetectionResult,
} from "@velo/shared";
import { REORG_RESILIENT_INDEXER } from "@velo/shared";

/**
 * Reorg Handler manages database rollback during blockchain reorganizations.
 * 
 * This component is responsible for:
 * 1. Recording undo logs before any database changes
 * 2. Executing atomic rollbacks when reorgs are detected
 * 3. Tracking reorg events for monitoring and debugging
 * 4. Coordinating with the Block DAG to determine rollback depth
 */
export class ReorgHandler {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
  ) {}

  /**
   * Record an undo log entry before making database changes.
   * 
   * @param ledgerSequence - The ledger sequence being processed
   * @param tableName - The table being modified
   * @param previousRowData - The previous state of the row (before modification)
   */
  async recordUndoLog(
    ledgerSequence: number,
    tableName: string,
    previousRowData: Record<string, unknown>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO indexer_undo_logs (ledger_sequence, table_name, previous_row_data)
         VALUES ($1, $2, $3)`,
        [ledgerSequence, tableName, JSON.stringify(previousRowData)],
      );
      
      this.logger.info(
        { ledgerSequence, tableName },
        "Undo log recorded",
      );
    } catch (error) {
      this.logger.error(
        { err: error, ledgerSequence, tableName },
        "Failed to record undo log",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all undo logs for a specific ledger sequence.
   * 
   * @param ledgerSequence - The ledger sequence
   * @returns Array of undo log entries
   */
  async getUndoLogs(ledgerSequence: number): Promise<IndexerUndoLog[]> {
    const result = await this.pool.query(
      `SELECT id, ledger_sequence, table_name, previous_row_data, created_at
       FROM indexer_undo_logs
       WHERE ledger_sequence = $1
       ORDER BY created_at ASC`,
      [ledgerSequence],
    );

    return result.rows.map((row) => ({
      id: row.id,
      ledger_sequence: Number(row.ledger_sequence),
      table_name: row.table_name,
      previous_row_data: row.previous_row_data as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  /**
   * Get undo logs for a range of ledger sequences.
   * 
   * @param fromLedger - Starting ledger sequence (inclusive)
   * @param toLedger - Ending ledger sequence (inclusive)
   * @returns Array of undo log entries
   */
  async getUndoLogsInRange(
    fromLedger: number,
    toLedger: number,
  ): Promise<IndexerUndoLog[]> {
    const result = await this.pool.query(
      `SELECT id, ledger_sequence, table_name, previous_row_data, created_at
       FROM indexer_undo_logs
       WHERE ledger_sequence >= $1 AND ledger_sequence <= $2
       ORDER BY ledger_sequence DESC, created_at DESC`,
      [fromLedger, toLedger],
    );

    return result.rows.map((row) => ({
      id: row.id,
      ledger_sequence: Number(row.ledger_sequence),
      table_name: row.table_name,
      previous_row_data: row.previous_row_data as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  /**
   * Execute a rollback to a specific ledger using undo logs.
   * 
   * @param targetLedger - Roll back to this ledger (exclusive)
   * @param reorgDetection - The reorg detection result
   * @returns The reorg event record
   */
  async executeRollback(
    targetLedger: number,
    reorgDetection: ReorgDetectionResult,
  ): Promise<IndexerReorgEvent> {
    const client = await this.pool.connect();
    let reorgEventId: string | undefined;

    try {
      await client.query("BEGIN");

      // Get the latest ledger before rollback
      const latestResult = await client.query(
        `SELECT MAX(ledger_sequence) as max_ledger FROM indexer_undo_logs`,
      );
      const latestLedger = latestResult.rows[0]?.max_ledger 
        ? Number(latestResult.rows[0].max_ledger) 
        : targetLedger;

      // Calculate rollback depth
      const rollbackDepth = latestLedger - targetLedger;

      // Check if rollback depth exceeds maximum
      if (rollbackDepth > REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH) {
        throw new Error(
          `Rollback depth ${rollbackDepth} exceeds maximum ${REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH}`,
        );
      }

      // Get undo logs for ledgers to roll back
      const undoLogs = await this.getUndoLogsWithClient(client, targetLedger + 1, latestLedger);

      this.logger.info(
        { targetLedger, latestLedger, rollbackDepth, undoLogCount: undoLogs.length },
        "Starting database rollback",
      );

      // Execute undo operations in reverse order (latest first)
      for (const undoLog of undoLogs.reverse()) {
        await this.applyUndoLog(client, undoLog);
      }

      // Delete undo logs for rolled-back ledgers
      await client.query(
        `DELETE FROM indexer_undo_logs
         WHERE ledger_sequence > $1`,
        [targetLedger],
      );

      // Record the reorg event
      const forkLedger = reorgDetection.fork_ledger ?? targetLedger;
      const reorgEventResult = await client.query(
        `INSERT INTO indexer_reorg_events 
           (detected_at, fork_ledger, rollback_depth, reason)
         VALUES (NOW(), $1, $2, $3)
         RETURNING id`,
        [forkLedger, rollbackDepth, "Parent hash mismatch detected"],
      );
      reorgEventId = reorgEventResult.rows[0]?.id || `reorg-${Date.now()}`;

      await client.query("COMMIT");

      this.logger.info(
        { reorgEventId, targetLedger, rollbackDepth },
        "Database rollback completed successfully",
      );

      return {
        id: reorgEventId,
        detected_at: new Date().toISOString(),
        fork_ledger: forkLedger,
        rollback_depth: rollbackDepth,
        reason: "Parent hash mismatch detected",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(
        { err: error, targetLedger },
        "Database rollback failed",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Apply a single undo log entry to restore previous state.
   * 
   * @param client - Database client (must be in a transaction)
   * @param undoLog - The undo log entry to apply
   */
  private async applyUndoLog(
    client: Pick<Pool, "query">,
    undoLog: IndexerUndoLog,
  ): Promise<void> {
    const { table_name, previous_row_data } = undoLog;

    // Map table names to their primary key columns
    const primaryKeyColumns: Record<string, string[]> = {
      stellar_contract_events: ["id"],
      stellar_canonical_events: ["event_id"],
      stellar_ledger_fingerprints: ["ledger_sequence"],
      indexed_escrows: ["contract_id", "escrow_id"],
      stellar_indexer_checkpoints: ["indexer_name"],
    };

    const pkColumns = primaryKeyColumns[table_name];
    if (!pkColumns) {
      this.logger.warn(
        { tableName: table_name },
        "No primary key mapping for table, skipping undo",
      );
      return;
    }

    // Extract primary key values from previous row data
    const pkValues = pkColumns.map(col => previous_row_data[col]);
    if (pkValues.some(v => v === undefined)) {
      this.logger.warn(
        { tableName: table_name, previousRowData: previous_row_data },
        "Missing primary key in undo log, skipping",
      );
      return;
    }

    // Build WHERE clause for primary key
    const whereClause = pkColumns.map((col, i) => `${col} = $${i + 1}`).join(" AND ");
    
    // Restore the previous row data
    const columns = Object.keys(previous_row_data);
    const values = Object.values(previous_row_data);
    const setClause = columns.map((col, i) => `${col} = $${i + pkColumns.length + 1}`).join(", ");

    await client.query(
      `UPDATE ${table_name}
       SET ${setClause}
       WHERE ${whereClause}`,
      [...values, ...pkValues],
    );

    this.logger.info(
      { tableName: table_name, ledgerSequence: undoLog.ledger_sequence },
      "Applied undo log",
    );
  }

  /**
   * Get undo logs using a specific client (for transaction consistency).
   */
  private async getUndoLogsWithClient(
    client: Pick<Pool, "query">,
    fromLedger: number,
    toLedger: number,
  ): Promise<IndexerUndoLog[]> {
    const result = await client.query(
      `SELECT id, ledger_sequence, table_name, previous_row_data, created_at
       FROM indexer_undo_logs
       WHERE ledger_sequence >= $1 AND ledger_sequence <= $2
       ORDER BY ledger_sequence DESC, created_at DESC`,
      [fromLedger, toLedger],
    );

    return result.rows.map((row) => ({
      id: row.id,
      ledger_sequence: Number(row.ledger_sequence),
      table_name: row.table_name,
      previous_row_data: row.previous_row_data as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  /**
   * Get recent reorg events for monitoring.
   * 
   * @param limit - Maximum number of events to return
   * @returns Array of reorg events
   */
  async getRecentReorgEvents(limit: number = 10): Promise<IndexerReorgEvent[]> {
    const result = await this.pool.query(
      `SELECT id, detected_at, fork_ledger, rollback_depth, reason, 
              resolved_at, resolution_details
       FROM indexer_reorg_events
       ORDER BY detected_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      detected_at: row.detected_at,
      fork_ledger: Number(row.fork_ledger),
      rollback_depth: Number(row.rollback_depth),
      reason: row.reason,
      resolved_at: row.resolved_at,
      resolution_details: row.resolution_details as Record<string, unknown> | undefined,
    }));
  }

  /**
   * Mark a reorg event as resolved.
   * 
   * @param reorgEventId - The reorg event ID
   * @param resolutionDetails - Details about how the reorg was resolved
   */
  async markReorgResolved(
    reorgEventId: string,
    resolutionDetails: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE indexer_reorg_events
       SET resolved_at = NOW(),
           resolution_details = $1
       WHERE id = $2`,
      [JSON.stringify(resolutionDetails), reorgEventId],
    );

    this.logger.info(
      { reorgEventId },
      "Reorg event marked as resolved",
    );
  }

  /**
   * Clean up old undo logs to prevent table bloat.
   * 
   * @param olderThanLedger - Delete undo logs for ledgers older than this
   */
  async cleanupOldUndoLogs(olderThanLedger: number): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM indexer_undo_logs
       WHERE ledger_sequence < $1`,
      [olderThanLedger],
    );

    this.logger.info(
      { olderThanLedger, deletedCount: result.rowCount },
      "Old undo logs cleaned up",
    );
  }
}
