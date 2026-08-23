import { Server } from "@stellar/stellar-sdk/rpc";
import { xdr } from "@stellar/stellar-sdk";
import type { FastifyBaseLogger } from "fastify";
import { decodeEscrowEvent, type IndexedEscrowEvent } from "./escrow-events.js";
import { escrowDeltaFeed } from "./escrow-deltas.js";
import type { EventStore } from "./stellar-event-store.js";
import { BlockDAG } from "./indexer/block-dag.js";
import { ReorgHandler } from "./indexer/reorg-handler.js";
import { SnapshotEngine } from "./indexer/snapshot-engine.js";
import { RpcFailover } from "./indexer/rpc-failover.js";
import { REORG_RESILIENT_INDEXER } from "@velo/shared";

interface RpcEventsResponse {
  events?: any[];
  latestLedger?: number;
  cursor?: string;
}

export interface StellarIndexerOptions {
  contractId: string;
  startLedger?: number;
  pollIntervalMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  onTrace?: (point: StellarIndexerTracePoint) => void;
  /**
   * (#374) Formal invariant verification hook. Invoked after each committed
   * batch, once EventStore.process has durably indexed `throughLedger`. The
   * default wiring in index.ts reconciles the reconstructed contract totals
   * against the on-chain balance and trips the automated circuit breaker on a
   * VIOLATED verdict.
   */
  verify?: (throughLedger: number, events: IndexedEscrowEvent[]) => Promise<void>;
  /**
   * Enable reorg-resilient indexing with DAG tracking and automatic rollback.
   * Requires PostgreSQL pool and RPC URLs for failover.
   */
  enableReorgResilience?: boolean;
  /**
   * PostgreSQL pool for reorg resilience features (required if enableReorgResilience is true).
   */
  pgPool?: any;
  /**
   * Multiple RPC URLs for failover (required if enableReorgResilience is true).
   */
  rpcUrls?: string[];
}

export type StellarIndexerTraceStage =
  | "get_events_request_started"
  | "get_events_response_received"
  | "event_decoding_completed"
  | "persistence_started"
  | "persistence_completed";

export interface StellarIndexerTracePoint {
  stage: StellarIndexerTraceStage;
  monotonicMs: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StellarEscrowIndexer {
  private stopped = false;
  private retryMs: number;
  
  // Reorg resilience components
  private readonly blockDAG?: BlockDAG;
  private readonly reorgHandler?: ReorgHandler;
  private readonly snapshotEngine?: SnapshotEngine;
  private readonly rpcFailover?: RpcFailover;
  private processingReorg = false;

  constructor(
    private readonly rpc: Pick<Server, "getEvents" | "getLatestLedger" | "getLedgers">,
    private readonly store: EventStore,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    private readonly options: StellarIndexerOptions,
  ) {
    this.retryMs = options.retryMinMs ?? 250;

    // Initialize reorg resilience components if enabled
    if (options.enableReorgResilience && options.pgPool && options.rpcUrls) {
      this.blockDAG = new BlockDAG(options.pgPool, this.logger);
      this.reorgHandler = new ReorgHandler(options.pgPool, this.logger);
      this.snapshotEngine = new SnapshotEngine(options.pgPool, this.logger);
      this.rpcFailover = new RpcFailover(this.logger, options.rpcUrls, Server);
      this.logger.info({}, "Reorg-resilient indexing enabled");
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    this.stopped = false;
    this.logger.info({ contractId: this.options.contractId }, "stellar escrow indexer started");
    while (!this.stopped) {
      try {
        await this.pollOnce();
        this.retryMs = this.options.retryMinMs ?? 250;
        await wait(this.options.pollIntervalMs ?? 1000);
      } catch (error) {
        this.logger.warn({ err: error, retryMs: this.retryMs }, "stellar RPC/database unavailable; retry scheduled");
        await wait(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? 30_000);
      }
    }
  }

  async pollOnce(): Promise<number> {
    // Skip polling if processing a reorg
    if (this.processingReorg) {
      this.logger.info("Reorg processing in progress, skipping polling cycle");
      return 0;
    }

    const checkpoint = await this.store.checkpoint();
    let startLedger: number;
    let knownStartHash: string | undefined;
    if (checkpoint) {
      startLedger = checkpoint.ledger + 1;
    } else if (this.options.startLedger !== undefined) {
      startLedger = this.options.startLedger;
    } else {
      const initial = this.rpcFailover 
        ? await this.rpcFailover.executeWithFailover(
            (server) => server.getLatestLedger(),
            "getLatestLedger",
          )
        : await this.rpc.getLatestLedger();
      startLedger = initial.sequence;
      knownStartHash = initial.id;
    }

    if (checkpoint?.validationLedger !== undefined && checkpoint.validationHash) {
      const currentHash = await this.ledgerHash(checkpoint.validationLedger);
      if (currentHash !== checkpoint.validationHash) {
        this.logger.warn(
          { ledger: checkpoint.validationLedger },
          "stored ledger event history differs from RPC; recovery started",
        );
        await this.recover();
        return 0;
      }
    }

    // Get expected parent hash if reorg resilience is enabled
    let expectedParentHash: string | undefined;
    if (this.blockDAG) {
      expectedParentHash = await this.blockDAG.getExpectedParentHash(startLedger) ?? undefined;
    }

    this.trace("get_events_request_started");
    const response = this.rpcFailover
      ? await this.rpcFailover.executeWithFailover(
          (server) => this.fetchResponseWithServer(server, startLedger),
          "getEvents",
        )
      : await this.fetchResponse(startLedger);
    this.trace("get_events_response_received");
    const events = this.decode(response.events ?? []);
    this.trace("event_decoding_completed");
    const throughLedger = response.latestLedger ?? startLedger;
    const ledgerHash = knownStartHash && throughLedger === startLedger
      ? knownStartHash
      : await this.ledgerHash(throughLedger);

    // Check for reorg if enabled
    if (this.blockDAG && expectedParentHash) {
      const ledgerHeaderResponse = this.rpcFailover
        ? await this.rpcFailover.executeWithFailover(
            (server) => server.getLedgers({
              startLedger: throughLedger,
              pagination: { limit: 1 },
            }),
            "getLedgers",
          )
        : await this.rpc.getLedgers({
            startLedger: throughLedger,
            pagination: { limit: 1 },
          });

      const ledger = ledgerHeaderResponse.ledgers[0];
      // Extract previous hash from ledger header XDR (LedgerHeaderHistoryEntry -> header -> previousLedgerHash)
      const previousHash = ledger.headerXdr.header().previousLedgerHash().toString("hex");
      
      if (ledger && previousHash !== expectedParentHash) {
        this.logger.warn(
          {
            ledger: throughLedger,
            expectedParentHash,
            actualParentHash: previousHash,
          },
          "Parent hash mismatch detected - triggering reorg handling",
        );
        await this.handleReorg(throughLedger, expectedParentHash, previousHash);
        return 0;
      }

      // Add block header to DAG
      if (ledger) {
        await this.blockDAG.addBlockHeader(throughLedger, ledgerHash, previousHash);
      }
    }

    // Record undo logs before processing if reorg resilience is enabled
    if (this.reorgHandler && events.length > 0) {
      await this.recordUndoLogsForEvents(events, throughLedger);
    }

    this.trace("persistence_started");
    const deltas = await this.store.process(events, throughLedger, ledgerHash);
    this.trace("persistence_completed");
    // Publishing happens only after EventStore.process has committed.
    for (const item of deltas) escrowDeltaFeed.publish(item);
    if (events.length) {
      this.logger.info({ throughLedger, eventCount: events.length }, "stellar ledger batch indexed");
    }
    // (#374) Invariant verification runs after the batch is durably indexed —
    // a VIOLATED verdict flips the contract to HALTED via the circuit breaker.
    if (this.options.verify) {
      await this.options.verify(throughLedger, events);
    }

    // Create snapshot if needed
    if (this.snapshotEngine && this.snapshotEngine.shouldCreateSnapshot(throughLedger)) {
      await this.snapshotEngine.createSnapshot(throughLedger, ledgerHash);
    }

    return events.length;
  }

  private decode(rawEvents: any[]): IndexedEscrowEvent[] {
    return rawEvents
      .map((event, order) => decodeEscrowEvent(event, order))
      .filter((event): event is IndexedEscrowEvent => event !== null)
      .sort((a, b) => a.ledger - b.ledger || a.order - b.order);
  }

  private async fetchResponse(startLedger: number): Promise<RpcEventsResponse> {
    return this.fetchResponseWithServer(this.rpc, startLedger);
  }

  private async recover(): Promise<void> {
    const fingerprints = await this.store.fingerprints();
    let validLedger = Math.max(0, (this.options.startLedger ?? 1) - 1);
    for (const fingerprint of fingerprints) {
      const current = await this.ledgerHash(fingerprint.ledger);
      if (current === fingerprint.hash) {
        validLedger = fingerprint.ledger;
        break;
      }
    }
    this.logger.warn({ validLedger }, "rolling back invalid indexed history");
    await this.store.rollbackAfter(validLedger);
    this.logger.info({ validLedger }, "index rollback completed; indexing will resume");
  }

  private async ledgerHash(sequence: number): Promise<string> {
    const response = this.rpcFailover
      ? await this.rpcFailover.executeWithFailover(
          (server) => server.getLedgers({
            startLedger: sequence,
            pagination: { limit: 1 },
          }),
          "getLedgers",
        )
      : await this.rpc.getLedgers({
          startLedger: sequence,
          pagination: { limit: 1 },
        });
    const ledger = response.ledgers.find((item) => item.sequence === sequence);
    if (!ledger) throw new Error(`RPC did not return ledger ${sequence}`);
    return ledger.hash;
  }

  /**
   * Handle a detected reorg by executing rollback.
   */
  private async handleReorg(
    ledgerSequence: number,
    expectedParentHash: string,
    actualParentHash: string,
  ): Promise<void> {
    if (!this.blockDAG || !this.reorgHandler) {
      this.logger.error("Reorg detected but reorg resilience components not available");
      return;
    }

    this.processingReorg = true;

    try {
      this.logger.warn(
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
        this.logger.error("Reorg detection failed");
        return;
      }

      // Check if rollback depth is acceptable
      if (reorgDetection.rollback_depth && reorgDetection.rollback_depth > REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH) {
        this.logger.error(
          { rollbackDepth: reorgDetection.rollback_depth, maxDepth: REORG_RESILIENT_INDEXER.MAX_ROLLBACK_DEPTH },
          "Rollback depth exceeds maximum, manual intervention required",
        );
        return;
      }

      // Execute rollback
      const targetLedger = reorgDetection.fork_ledger;
      const reorgEvent = await this.reorgHandler.executeRollback(targetLedger, reorgDetection);

      // Delete block headers after the fork point
      await this.blockDAG.deleteBlockHeadersAfter(targetLedger);

      // Try to restore from snapshot if available
      if (this.snapshotEngine) {
        const snapshot = await this.snapshotEngine.getLatestSnapshot(targetLedger);
        if (snapshot) {
          this.logger.info(
            { snapshotLedger: snapshot.ledger_sequence },
            "Restoring from snapshot",
          );
          await this.snapshotEngine.restoreFromSnapshot(snapshot);
        }
      }

      // Mark reorg as resolved
      await this.reorgHandler.markReorgResolved(reorgEvent.id, {
        restored_from_snapshot: !!this.snapshotEngine,
        new_current_ledger: targetLedger,
      });

      this.logger.info(
        { reorgEventId: reorgEvent.id, targetLedger },
        "Reorg handling completed successfully",
      );
    } catch (error) {
      this.logger.error({ err: error }, "Reorg handling failed");
    } finally {
      this.processingReorg = false;
    }
  }

  /**
   * Record undo logs for events before processing.
   */
  private async recordUndoLogsForEvents(events: IndexedEscrowEvent[], ledgerSequence: number): Promise<void> {
    if (!this.reorgHandler) return;

    for (const event of events) {
      if (event.type === "locked" || event.type === "released" || event.type === "disputed") {
        const escrowId = event.escrowId;
        const contractId = event.contractId;
        
        if (escrowId) {
          const currentDelta = await this.store.escrow(contractId, escrowId);
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
   * Fetch response using a specific server (for RPC failover).
   */
  private async fetchResponseWithServer(
    server: Pick<Server, "getEvents" | "getLatestLedger">,
    startLedger: number,
  ): Promise<RpcEventsResponse> {
    const all: any[] = [];
    let cursor: string | undefined;
    let latestLedger: number | undefined;
    let hasMore = true;
    while (hasMore) {
      const request = cursor
        ? {
            cursor,
            filters: [{ type: "contract", contractIds: [this.options.contractId] }],
            limit: 10_000,
          }
        : {
            startLedger,
            filters: [{ type: "contract", contractIds: [this.options.contractId] }],
            limit: 10_000,
          };
      const response = await server.getEvents(request as never) as RpcEventsResponse;
      const page = response.events ?? [];
      all.push(...page);
      latestLedger = response.latestLedger ?? latestLedger;
      cursor = response.cursor;
      hasMore = page.length === 10_000 && Boolean(cursor);
    }
    return { events: all, latestLedger };
  }

  private trace(stage: StellarIndexerTraceStage): void {
    this.options.onTrace?.({ stage, monotonicMs: performance.now() });
  }
}
