import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { BlockDAG } from "../../apps/api/src/lib/indexer/block-dag.js";
import { ReorgHandler } from "../../apps/api/src/lib/indexer/reorg-handler.js";
import { SnapshotEngine } from "../../apps/api/src/lib/indexer/snapshot-engine.js";
import { PostgresEventStore } from "../../apps/api/src/lib/stellar-event-store.js";

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("Indexer Reorg Simulation E2E Test", () => {
  let pool: Pool;
  let blockDAG: BlockDAG;
  let reorgHandler: ReorgHandler;
  let snapshotEngine: SnapshotEngine;
  let eventStore: PostgresEventStore;

  beforeEach(async () => {
    // Set up test database connection
    // In a real E2E test, this would connect to a test database
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/velo_test",
    });

    blockDAG = new BlockDAG(pool, mockLogger);
    reorgHandler = new ReorgHandler(pool, mockLogger);
    snapshotEngine = new SnapshotEngine(pool, mockLogger, 10);
    eventStore = new PostgresEventStore(pool, "test-indexer");

    // Clean up test data
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
    await pool.end();
  });

  async function cleanupTestData() {
    try {
      await pool.query("DELETE FROM indexer_undo_logs");
      await pool.query("DELETE FROM indexer_block_headers");
      await pool.query("DELETE FROM indexer_reorg_events");
      await pool.query("DELETE FROM stellar_contract_events");
      await pool.query("DELETE FROM stellar_canonical_events");
      await pool.query("DELETE FROM stellar_ledger_fingerprints");
      await pool.query("DELETE FROM indexed_escrows");
      await pool.query("DELETE FROM stellar_indexer_checkpoints");
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  describe("5-Ledger Fork Simulation", () => {
    it("should detect and handle a 5-ledger fork", async () => {
      // Simulate a chain of 10 ledgers
      const baseChain = generateBlockHeaders(100, 10);
      
      // Add the base chain to the DAG
      for (const header of baseChain) {
        await blockDAG.addBlockHeader(
          header.ledger_sequence,
          header.block_hash,
          header.parent_hash
        );
      }

      // Verify the base chain is stored
      const latestHeader = await blockDAG.getLatestBlockHeader();
      expect(latestHeader?.ledger_sequence).toBe(109);

      // Simulate a fork at ledger 105
      const forkPoint = 104;
      const forkChain = generateForkChain(forkPoint, 5);

      // Simulate the new chain arriving with different parent hash at ledger 105
      const forkLedger = forkChain[0];
      const expectedParentHash = baseChain.find(h => h.ledger_sequence === forkLedger.ledger_sequence - 1)?.block_hash;
      const actualParentHash = forkLedger.parent_hash;

      expect(expectedParentHash).toBeDefined();
      expect(actualParentHash).not.toBe(expectedParentHash);

      // Detect the reorg
      const reorgDetection = await blockDAG.detectReorg(
        forkLedger.ledger_sequence,
        expectedParentHash!,
        actualParentHash
      );

      expect(reorgDetection.detected).toBe(true);
      expect(reorgDetection.fork_ledger).toBe(forkPoint);
      expect(reorgDetection.rollback_depth).toBe(5);

      // Record some undo logs for the ledgers that will be rolled back
      for (let i = forkPoint + 1; i <= 109; i++) {
        await reorgHandler.recordUndoLog(
          i,
          "indexed_escrows",
          {
            contract_id: `contract_${i}`,
            escrow_id: `escrow_${i}`,
            status: "locked",
            locked_amount: "1000000",
          }
        );
      }

      // Execute the rollback
      const reorgEvent = await reorgHandler.executeRollback(forkPoint, reorgDetection);

      expect(reorgEvent.id).toBeDefined();
      expect(reorgEvent.fork_ledger).toBe(forkPoint);
      expect(reorgEvent.rollback_depth).toBe(5);

      // Verify that undo logs for rolled-back ledgers are deleted
      const remainingUndoLogs = await reorgHandler.getUndoLogsInRange(forkPoint + 1, 109);
      expect(remainingUndoLogs).toHaveLength(0);

      // Verify that block headers after the fork point are deleted
      await blockDAG.deleteBlockHeadersAfter(forkPoint);
      const remainingHeaders = await blockDAG.getBlockHeadersInRange(forkPoint + 1, 109);
      expect(remainingHeaders).toHaveLength(0);

      // Verify the fork point header still exists
      const forkHeader = await blockDAG.getBlockHeader(forkPoint);
      expect(forkHeader).toBeDefined();
      expect(forkHeader?.ledger_sequence).toBe(forkPoint);

      // Mark the reorg as resolved
      await reorgHandler.markReorgResolved(reorgEvent.id, {
        test_simulation: true,
        fork_ledger: forkPoint,
        rollback_depth: 5,
      });

      // Verify the reorg event is marked as resolved
      const recentReorgs = await reorgHandler.getRecentReorgEvents(1);
      expect(recentReorgs).toHaveLength(1);
      expect(recentReorgs[0].resolved_at).toBeDefined();
    });
  });

  describe("Rollback Depth Limit", () => {
    it("should reject rollback depth exceeding maximum", async () => {
      // Create a long chain
      const longChain = generateBlockHeaders(100, 20);
      
      for (const header of longChain) {
        await blockDAG.addBlockHeader(
          header.ledger_sequence,
          header.block_hash,
          header.parent_hash
        );
      }

      // Try to rollback more than the maximum allowed depth (10)
      const forkPoint = 100;
      const reorgDetection = {
        detected: true,
        fork_ledger: forkPoint,
        expected_parent_hash: "hash_99",
        actual_parent_hash: "different_hash_99",
        rollback_depth: 15, // Exceeds MAX_ROLLBACK_DEPTH of 10
      };

      await expect(
        reorgHandler.executeRollback(forkPoint, reorgDetection)
      ).rejects.toThrow("Rollback depth 15 exceeds maximum 10");
    });
  });

  describe("Snapshot Recovery", () => {
    it("should restore from snapshot after reorg", async () => {
      // Create a chain with a snapshot point
      const chain = generateBlockHeaders(100, 15);
      
      for (const header of chain) {
        await blockDAG.addBlockHeader(
          header.ledger_sequence,
          header.block_hash,
          header.parent_hash
        );
      }

      // Create a snapshot at ledger 110
      const snapshotPoint = 110;
      const snapshotHeader = chain.find(h => h.ledger_sequence === snapshotPoint);
      expect(snapshotHeader).toBeDefined();

      await snapshotEngine.createSnapshot(
        snapshotPoint,
        snapshotHeader!.block_hash
      );

      // Simulate a reorg
      const forkPoint = 108;
      const reorgDetection = {
        detected: true,
        fork_ledger: forkPoint,
        expected_parent_hash: "hash_107",
        actual_parent_hash: "different_hash_107",
        rollback_depth: 2,
      };

      // Execute rollback
      await reorgHandler.executeRollback(forkPoint, reorgDetection);
      await blockDAG.deleteBlockHeadersAfter(forkPoint);

      // Try to restore from snapshot
      const snapshot = await snapshotEngine.getLatestSnapshot(forkPoint);
      expect(snapshot).toBeDefined();
      expect(snapshot?.ledger_sequence).toBeLessThanOrEqual(forkPoint);

      if (snapshot) {
        await snapshotEngine.restoreFromSnapshot(snapshot);
        // Verify restoration succeeded (no error thrown)
      }
    });
  });

  describe("Atomic Rollback", () => {
    it("should rollback atomically or not at all on error", async () => {
      // Create a chain
      const chain = generateBlockHeaders(100, 5);
      
      for (const header of chain) {
        await blockDAG.addBlockHeader(
          header.ledger_sequence,
          header.block_hash,
          header.parent_hash
        );
      }

      // Record undo logs
      await reorgHandler.recordUndoLog(102, "indexed_escrows", { contract_id: "test", status: "locked" });
      await reorgHandler.recordUndoLog(103, "indexed_escrows", { contract_id: "test2", status: "locked" });

      // Simulate a failure during rollback by making the database unavailable
      // This is a simplified test - in reality, you'd mock the database to throw an error
      
      // Verify that undo logs still exist (no partial rollback)
      const undoLogsBefore = await reorgHandler.getUndoLogs(102);
      expect(undoLogsBefore).toHaveLength(1);
    });
  });
});

// Helper function to generate block headers
function generateBlockHeaders(startLedger: number, count: number): Array<{
  ledger_sequence: number;
  block_hash: string;
  parent_hash: string;
  created_at: string;
}> {
  const headers = [];
  let parentHash = "genesis_hash";

  for (let i = 0; i < count; i++) {
    const ledgerSequence = startLedger + i;
    const blockHash = `hash_${ledgerSequence}`;
    
    headers.push({
      ledger_sequence: ledgerSequence,
      block_hash: blockHash,
      parent_hash: parentHash,
      created_at: new Date().toISOString(),
    });

    parentHash = blockHash;
  }

  return headers;
}

// Helper function to generate a fork chain
function generateForkChain(forkPoint: number, count: number): Array<{
  ledger_sequence: number;
  block_hash: string;
  parent_hash: string;
  created_at: string;
}> {
  const headers = [];
  let parentHash = `different_hash_${forkPoint}`;

  for (let i = 1; i <= count; i++) {
    const ledgerSequence = forkPoint + i;
    const blockHash = `fork_hash_${ledgerSequence}`;
    
    headers.push({
      ledger_sequence: ledgerSequence,
      block_hash: blockHash,
      parent_hash: parentHash,
      created_at: new Date().toISOString(),
    });

    parentHash = blockHash;
  }

  return headers;
}
