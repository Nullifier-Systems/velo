import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type {
  IndexerBlockHeader,
  ReorgDetectionResult,
} from "@velo/shared";

/**
 * Block DAG module for tracking ledger headers and detecting reorgs.
 * 
 * This module maintains a directed acyclic graph (DAG) of ledger headers
 * by tracking the parent-child relationships between blocks. When a new
 * ledger arrives, we verify that its parent hash matches the expected hash
 * from our database. A mismatch indicates a blockchain reorganization.
 */
export class BlockDAG {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
  ) {}

  /**
   * Add a new block header to the DAG.
   * 
   * @param ledgerSequence - The ledger sequence number
   * @param blockHash - The hash of the current block
   * @param parentHash - The hash of the parent block
   */
  async addBlockHeader(
    ledgerSequence: number,
    blockHash: string,
    parentHash: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      
      await client.query(
        `INSERT INTO indexer_block_headers (ledger_sequence, block_hash, parent_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (ledger_sequence) DO UPDATE
           SET block_hash = EXCLUDED.block_hash,
               parent_hash = EXCLUDED.parent_hash,
               created_at = NOW()`,
        [ledgerSequence, blockHash, parentHash],
      );
      
      await client.query("COMMIT");
      this.logger.info(
        { ledgerSequence, blockHash, parentHash },
        "Block header added to DAG",
      );
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(
        { err: error, ledgerSequence },
        "Failed to add block header to DAG",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a block header by ledger sequence.
   * 
   * @param ledgerSequence - The ledger sequence number
   * @returns The block header or null if not found
   */
  async getBlockHeader(
    ledgerSequence: number,
  ): Promise<IndexerBlockHeader | null> {
    const result = await this.pool.query(
      `SELECT ledger_sequence, block_hash, parent_hash, created_at
       FROM indexer_block_headers
       WHERE ledger_sequence = $1`,
      [ledgerSequence],
    );

    if (!result.rows[0]) return null;

    return {
      ledger_sequence: Number(result.rows[0].ledger_sequence),
      block_hash: result.rows[0].block_hash,
      parent_hash: result.rows[0].parent_hash,
      created_at: result.rows[0].created_at,
    };
  }

  /**
   * Get the latest block header in the DAG.
   * 
   * @returns The latest block header or null if DAG is empty
   */
  async getLatestBlockHeader(): Promise<IndexerBlockHeader | null> {
    const result = await this.pool.query(
      `SELECT ledger_sequence, block_hash, parent_hash, created_at
       FROM indexer_block_headers
       ORDER BY ledger_sequence DESC
       LIMIT 1`,
    );

    if (!result.rows[0]) return null;

    return {
      ledger_sequence: Number(result.rows[0].ledger_sequence),
      block_hash: result.rows[0].block_hash,
      parent_hash: result.rows[0].parent_hash,
      created_at: result.rows[0].created_at,
    };
  }

  /**
   * Detect if a reorg has occurred by checking parent hash continuity.
   * 
   * @param ledgerSequence - The new ledger sequence number
   * @param expectedParentHash - The expected parent hash based on our DAG
   * @param actualParentHash - The actual parent hash from the new block
   * @returns Reorg detection result
   */
  async detectReorg(
    ledgerSequence: number,
    expectedParentHash: string,
    actualParentHash: string,
  ): Promise<ReorgDetectionResult> {
    if (expectedParentHash === actualParentHash) {
      return { detected: false };
    }

    this.logger.warn(
      {
        ledgerSequence,
        expectedParentHash,
        actualParentHash,
      },
      "Parent hash mismatch detected - potential reorg",
    );

    // Find the fork point by walking back the chain
    const forkLedger = await this.findForkPoint(ledgerSequence, actualParentHash);
    
    // Calculate rollback depth
    const latestHeader = await this.getLatestBlockHeader();
    const rollbackDepth = latestHeader 
      ? latestHeader.ledger_sequence - forkLedger 
      : 0;

    return {
      detected: true,
      fork_ledger: forkLedger,
      expected_parent_hash: expectedParentHash,
      actual_parent_hash: actualParentHash,
      rollback_depth: rollbackDepth,
    };
  }

  /**
   * Find the fork point by walking back the chain until we find a common ancestor.
   * 
   * @param ledgerSequence - The ledger sequence where the fork was detected
   * @param actualParentHash - The actual parent hash from the new block
   * @returns The ledger sequence of the fork point
   */
  private async findForkPoint(
    ledgerSequence: number,
    actualParentHash: string,
  ): Promise<number> {
    let currentSequence = ledgerSequence - 1;
    let currentHash = actualParentHash;
    const maxIterations = 1000; // Increased to handle deeper reorgs (approx 1.5 hours of ledgers)
    let iterations = 0;

    while (iterations < maxIterations) {
      const header = await this.getBlockHeader(currentSequence);
      
      if (!header) {
        // If we don't have this block in our DAG, this is the fork point
        return currentSequence;
      }

      if (header.block_hash === currentHash) {
        // Found the common ancestor
        return currentSequence;
      }

      // Move to the previous block
      currentHash = header.parent_hash;
      currentSequence--;
      iterations++;
    }

    // If we exhaust the search, return the earliest point we found
    this.logger.warn(
      { ledgerSequence, iterations },
      "Could not find fork point within max iterations, returning fallback point",
    );
    return Math.max(0, ledgerSequence - maxIterations);
  }

  /**
   * Get block headers for a range of ledger sequences.
   * 
   * @param fromLedger - Starting ledger sequence (inclusive)
   * @param toLedger - Ending ledger sequence (inclusive)
   * @returns Array of block headers
   */
  async getBlockHeadersInRange(
    fromLedger: number,
    toLedger: number,
  ): Promise<IndexerBlockHeader[]> {
    const result = await this.pool.query(
      `SELECT ledger_sequence, block_hash, parent_hash, created_at
       FROM indexer_block_headers
       WHERE ledger_sequence >= $1 AND ledger_sequence <= $2
       ORDER BY ledger_sequence ASC`,
      [fromLedger, toLedger],
    );

    return result.rows.map((row) => ({
      ledger_sequence: Number(row.ledger_sequence),
      block_hash: row.block_hash,
      parent_hash: row.parent_hash,
      created_at: row.created_at,
    }));
  }

  /**
   * Delete block headers after a specific ledger sequence (used during rollback).
   * 
   * @param afterLedger - Delete all headers with sequence > this value
   */
  async deleteBlockHeadersAfter(afterLedger: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      
      const result = await client.query(
        `DELETE FROM indexer_block_headers
         WHERE ledger_sequence > $1`,
        [afterLedger],
      );

      await client.query("COMMIT");
      this.logger.info(
        { afterLedger, deletedCount: result.rowCount },
        "Block headers deleted after ledger",
      );
    } catch (error) {
      await client.query("ROLLBACK");
      this.logger.error(
        { err: error, afterLedger },
        "Failed to delete block headers",
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the expected parent hash for a new ledger based on our DAG.
   * 
   * @param ledgerSequence - The new ledger sequence number
   * @returns The expected parent hash or null if DAG is empty
   */
  async getExpectedParentHash(ledgerSequence: number): Promise<string | null> {
    const previousHeader = await this.getBlockHeader(ledgerSequence - 1);
    return previousHeader?.block_hash ?? null;
  }

  /**
   * Clean up old block headers to prevent unbounded table growth.
   * 
   * @param keepRecentLedgers - Number of recent ledgers to keep (default: 1000)
   * @param currentLedger - Current ledger sequence for calculating retention
   */
  async cleanupOldHeaders(keepRecentLedgers: number = 1000, currentLedger?: number): Promise<void> {
    const cutoffLedger = currentLedger 
      ? currentLedger - keepRecentLedgers 
      : await this.getLatestBlockHeader().then(h => h ? h.ledger_sequence - keepRecentLedgers : 0);
    
    if (cutoffLedger <= 0) {
      return; // Nothing to clean up
    }

    const result = await this.pool.query(
      `DELETE FROM indexer_block_headers
       WHERE ledger_sequence < $1`,
      [cutoffLedger],
    );

    this.logger.info(
      { cutoffLedger, deletedCount: result.rowCount },
      "Old block headers cleaned up",
    );
  }
}
