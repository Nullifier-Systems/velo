import type { Server } from "@stellar/stellar-sdk/rpc";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import { REORG_RESILIENT_INDEXER } from "@velo/shared";
import { BlockDAG } from "../indexer/block-dag.js";
import { ReorgHandler } from "../indexer/reorg-handler.js";
import { SnapshotEngine } from "../indexer/snapshot-engine.js";
import { RpcFailover } from "../indexer/rpc-failover.js";
import type { EventStore } from "../stellar-event-store.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reorg Indexer Worker extends the standard Stellar indexer with reorg resilience.
 * 
 * This worker:
 * 1. Maintains a ledger header DAG to detect parent hash mismatches
 * 2. Records undo logs before database changes for atomic rollback
 * 3. Creates periodic snapshots for fast recovery
 * 4. Manages RPC node failover for high availability
 * 5. Automatically executes rollbacks when reorgs are detected
 */
export interface ReorgIndexerWorkerOptions {
  contractId: string;
  rpcUrls: string[];
  pool: Pool;
  eventStore: EventStore;
  logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  startLedger?: number;
  pollIntervalMs?: number;
  snapshotIntervalLedgers?: number;
  ServerClass?: new (url: string, options?: any) => Server;
}

export class ReorgIndexerWorker {
  private running = false;
  private currentLedger: number = 0;
  private processingReorg = false;

  private readonly blockDAG: BlockDAG;
  private readonly reorgHandler: ReorgHandler;
  private readonly snapshotEngine: SnapshotEngine;
  private readonly rpcFailover: RpcFailover;

  constructor(private readonly options: ReorgIndexerWorkerOptions) {
    this.blockDAG = new BlockDAG(options.pool, options.logger);
    this.reorgHandler = new ReorgHandler(options.pool, options.logger);
    this.snapshotEngine = new SnapshotEngine(
      options.pool,
      options.logger,
      options.snapshotIntervalLedgers ?? 100,
    );
    this.rpcFailover = new RpcFailover(
      options.logger,
      options.rpcUrls,
      options.ServerClass ?? Server,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    
    // Initialize current ledger from checkpoint or start ledger
    const checkpoint = await this.options.eventStore.checkpoint();
    this.currentLedger = checkpoint?.ledger ?? this.options.startLedger ?? 0;
    
    this.options.logger.info(
      { contractId: this.options.contractId, startLedger: this.currentLedger },
      "Reorg-resilient indexer worker started",
    );

    // Start background tasks
    this.runDAGContinuityCheck();
    this.runRpcHealthCheck();

    await this.runIndexingLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.options.logger.info({}, "Reorg-resilient indexer worker stopped");
  }

  /**
   * Main indexing loop with reorg detection and handling.
   */
  private async runIndexingLoop(): Promise<void> {
    while (this.running) {
      try {
        if (this.processingReorg) {
          this.options.logger.info("Reorg processing in progress, skipping indexing cycle");
          await wait(this.options.pollIntervalMs ?? 1000);
          continue;
        }

        await this.indexOnce();
        await wait(this.options.pollIntervalMs ?? 1000);
      } catch (error) {
        this.options.logger.error({ err: error }, "Indexing loop error");
        await wait(5000); // Backoff on error
      }
    }
  }

  /**
   * Index a single batch of events with reorg protection.
   */
  private async indexOnce(): Promise<void> {
    const rpc = this.rpcFailover.getCurrentRpc();
    const latestLedgerResult = await this.rpcFailover.executeWithFailover(
      (server) => server.getLatestLedger(),
      "getLatestLedger",
    );
    const latestLedger = latestLedgerResult.sequence;

    if (latestLedger <= this.currentLedger) {
      // No new ledgers to process
      return;
    }

    // Get the expected parent hash from our DAG
    const expectedParentHash = await this.blockDAG.getExpectedParentHash(this.currentLedger + 1);

    // Fetch the new ledger header
    const ledgerHeader = await this.rpcFailover.executeWithFailover(
      (server) => server.getLedgers({
        startLedger: this.currentLedger + 1,
        pagination: { limit: 1 },
      }),
      "getLedgers",
    );

    const ledger = ledgerHeader.ledgers[0];
    if (!ledger) {
      this.options.logger.warn(
        { currentLedger: this.currentLedger + 1 },
        "No ledger returned from RPC",
      );
      return;
    }

    const actualParentHash = ledger.prevHash;
    const blockHash = ledger.hash;
    const ledgerSequence = ledger.sequence;

    // Check for reorg
    if (expectedParentHash && expectedParentHash !== actualParentHash) {
      this.options.logger.warn(
        {
          ledgerSequence,
          expectedParentHash,
          actualParentHash,
        },
        "Parent hash mismatch detected - reorg detected",
      );

      await this.handleReorg(ledgerSequence, expectedParentHash, actualParentHash);
      return;
    }

    // Add block header to DAG
    await this.blockDAG.addBlockHeader(ledgerSequence, blockHash, actualParentHash);

    // Fetch and process events
    const eventsResponse = await this.rpcFailover.executeWithFailover(
      (server) => server.getEvents({
        startLedger: this.currentLedger + 1,
        filters: [{ type: "contract", contractIds: [this.options.contractId] }],
        limit: 10_000,
      }),
      "getEvents",
    );

    // Record undo logs before processing events
    if (eventsResponse.events && eventsResponse.events.length > 0) {
      await this.recordUndoLogsForEvents(eventsResponse.events, ledgerSequence);
    }

    // Process events through the event store
    if (eventsResponse.events) {
      await this.options.eventStore.process(
        eventsResponse.events as any[],
        ledgerSequence,
        blockHash,
      );
    }

    // Create snapshot if needed
    if (this.snapshotEngine.shouldCreateSnapshot(ledgerSequence)) {
      await this.snapshotEngine.createSnapshot(ledgerSequence, blockHash);
    }

    // Update current ledger
    this.currentLedger = ledgerSequence;

    this.options.logger.info(
      {
        ledgerSequence,
        eventCount: eventsResponse.events?.length ?? 0,
      },
      "Ledger indexed successfully",
    );
  }

  /**
   * Handle a detected reorg by executing rollback.
   */
  private async handleReorg(
    ledgerSequence: number,
    expectedParentHash: string,
    actualParentHash: string,
  ): Promise<void> {
    this.processingReorg = true;

    try {
      this.options.logger.warn(
        { ledgerSequence, expectedParentHash, actualParentHash },
        "Starting reorg handling",
      );

      // Detect the reorg details
      const reorgDetection = await this.blockDAG.detectReorg(
        ledgerSequence,
        expectedParentHash,
        actualParentHash,
      );

      if (!reorgDetection.detected || !reorgDetection.fork_ledger) {
        this.options.logger.error("Reorg detection failed");
        return;
      }

      // Check if rollback depth is acceptable
      if (reorgDetection.rollback_depth && reorgDetection.rollback_depth > REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH) {
        this.options.logger.error(
          { rollbackDepth: reorgDetection.rollback_depth, maxDepth: REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH },
          "Rollback depth exceeds maximum, manual intervention required",
        );
        // In production, this would trigger an alert
        return;
      }

      // Execute rollback
      const targetLedger = reorgDetection.fork_ledger;
      const reorgEvent = await this.reorgHandler.executeRollback(targetLedger, reorgDetection);

      // Delete block headers after the fork point
      await this.blockDAG.deleteBlockHeadersAfter(targetLedger);

      // Try to restore from snapshot if available
      const snapshot = await this.snapshotEngine.getLatestSnapshot(targetLedger);
      if (snapshot) {
        this.options.logger.info(
          { snapshotLedger: snapshot.ledger_sequence },
          "Restoring from snapshot",
        );
        await this.snapshotEngine.restoreFromSnapshot(snapshot);
      }

      // Update current ledger
      this.currentLedger = targetLedger;

      // Mark reorg as resolved
      await this.reorgHandler.markReorgResolved(reorgEvent.id, {
        restored_from_snapshot: !!snapshot,
        new_current_ledger: targetLedger,
      });

      this.options.logger.info(
        { reorgEventId: reorgEvent.id, targetLedger },
        "Reorg handling completed successfully",
      );
    } catch (error) {
      this.options.logger.error({ err: error }, "Reorg handling failed");
    } finally {
      this.processingReorg = false;
    }
  }

  /**
   * Record undo logs for events before processing.
   */
  private async recordUndoLogsForEvents(events: any[], ledgerSequence: number): Promise<void> {
    // This is a simplified implementation - in production, you'd want to
    // capture the actual previous state of affected rows
    for (const event of events) {
      // For escrow events, record the previous state if it exists
      if (event.type === "locked" || event.type === "released" || event.type === "disputed") {
        const escrowId = event.topic?.[1]; // Assuming escrow_id is in topic[1]
        const contractId = this.options.contractId;
        
        if (escrowId) {
          const currentDelta = await this.options.eventStore.escrow(contractId, escrowId);
          if (currentDelta) {
            await this.reorgHandler.recordUndoLog(
              ledgerSequence,
              "indexed_escrows",
              {
                contract_id: contractId,
                escrow_id: escrowId,
                ...currentDelta,
              },
            );
          }
        }
      }
    }
  }

  /**
   * Background task to check DAG continuity periodically.
   */
  private async runDAGContinuityCheck(): Promise<void> {
    while (this.running) {
      try {
        await wait(REORG_RESILIENT_INDEXER.DAG_CONTINUITY_CHECK_MS);

        const latestHeader = await this.blockDAG.getLatestBlockHeader();
        if (!latestHeader) continue;

        const rpc = this.rpcFailover.getCurrentRpc();
        const latestLedger = await this.rpcFailover.executeWithFailover(
          (server) => server.getLatestLedger(),
          "getLatestLedger",
        );

        // If we're behind, fetch missing ledgers
        if (latestLedger.sequence > latestHeader.ledger_sequence) {
          this.options.logger.info(
            { ourLedger: latestHeader.ledger_sequence, chainLedger: latestLedger.sequence },
            "Behind chain, fetching missing ledgers",
          );
          // The main indexing loop will catch up
        }
      } catch (error) {
        this.options.logger.error({ err: error }, "DAG continuity check failed");
      }
    }
  }

  /**
   * Background task to check RPC node health.
   */
  private async runRpcHealthCheck(): Promise<void> {
    while (this.running) {
      try {
        await wait(30000); // Check every 30 seconds
        await this.rpcFailover.performHealthChecks();
      } catch (error) {
        this.options.logger.error({ err: error }, "RPC health check failed");
      }
    }
  }

  /**
   * Get current worker status for monitoring.
   */
  async getStatus() {
    const latestHeader = await this.blockDAG.getLatestBlockHeader();
    const recentReorgs = await this.reorgHandler.getRecentReorgEvents(5);
    const rpcHealth = this.rpcFailover.getAllNodeHealth();
    const snapshots = await this.snapshotEngine.getAllSnapshots();

    return {
      running: this.running,
      currentLedger: this.currentLedger,
      latestBlockHeader: latestHeader,
      processingReorg: this.processingReorg,
      recentReorgs,
      rpcHealth,
      snapshotCount: snapshots.length,
      latestSnapshot: snapshots[0] ?? null,
    };
  }
}
