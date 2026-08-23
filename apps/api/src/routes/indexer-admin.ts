import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { BlockDAG } from "../lib/indexer/block-dag.js";
import { ReorgHandler } from "../lib/indexer/reorg-handler.js";
import { SnapshotEngine } from "../lib/indexer/snapshot-engine.js";
import { RpcFailover } from "../lib/indexer/rpc-failover.js";
import { Server } from "@stellar/stellar-sdk/rpc";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Admin API routes for reorg-resilient indexer management.
 * 
 * These routes provide:
 * - Manual rollback triggers
 * - Snapshot management
 * - RPC node health monitoring
 * - Reorg event history
 * - DAG inspection
 */

export async function indexerAdminRoutes(fastify: FastifyInstance) {
  // Add auth middleware
  fastify.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const adminKey = req.headers["x-admin-api-key"];
    const expectedKey = process.env.ADMIN_API_KEY;

    if (!expectedKey) {
      req.log.error("ADMIN_API_KEY env variable is not set!");
      return reply.status(500).send({ error: "Admin environment configuration error." });
    }

    if (!adminKey || typeof adminKey !== "string" || !safeCompare(adminKey, expectedKey)) {
      return reply.status(401).send({ error: "Unauthorized access to internal ops endpoints." });
    }
  });

  // Initialize components (these would typically be injected via DI)
  const blockDAG = new BlockDAG(fastify.pg, fastify.log);
  const reorgHandler = new ReorgHandler(fastify.pg, fastify.log);
  const snapshotEngine = new SnapshotEngine(fastify.pg, fastify.log);
  
  // Get RPC URLs from environment or use default
  const rpcUrls = process.env.SOROBAN_RPC_URLS 
    ? process.env.SOROBAN_RPC_URLS.split(",")
    : [process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"];
  
  const rpcFailover = new RpcFailover(fastify.log, rpcUrls, Server);

  /**
   * POST /api/v1/indexer/rollback
   * Manually trigger a database rollback to a specific ledger.
   */
  fastify.post(
    "/api/v1/indexer/rollback",
    async (
      req: FastifyRequest<{
        Body: { targetLedger: number; reason?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { targetLedger, reason = "Manual rollback triggered by admin" } = req.body;

      if (!Number.isInteger(targetLedger) || targetLedger < 0) {
        return reply.status(400).send({
          error: "Invalid target ledger",
          code: "INVALID_TARGET_LEDGER",
        });
      }

      try {
        fastify.log.info({ targetLedger, reason }, "Manual rollback triggered");

        // Get current state to determine rollback depth
        const latestHeader = await blockDAG.getLatestBlockHeader();
        const rollbackDepth = latestHeader 
          ? latestHeader.ledger_sequence - targetLedger 
          : 0;

        // Execute rollback
        const reorgEvent = await reorgHandler.executeRollback(targetLedger, {
          detected: true,
          fork_ledger: targetLedger,
          rollback_depth: rollbackDepth,
          reason,
        });

        // Delete block headers after target
        await blockDAG.deleteBlockHeadersAfter(targetLedger);

        // Try to restore from snapshot
        const snapshot = await snapshotEngine.getLatestSnapshot(targetLedger);
        if (snapshot) {
          await snapshotEngine.restoreFromSnapshot(snapshot);
        }

        // Mark reorg as resolved
        await reorgHandler.markReorgResolved(reorgEvent.id, {
          manual_trigger: true,
          reason,
          restored_from_snapshot: !!snapshot,
        });

        return reply.send({
          success: true,
          reorgEventId: reorgEvent.id,
          targetLedger,
          rollbackDepth,
          restoredFromSnapshot: !!snapshot,
        });
      } catch (error) {
        fastify.log.error({ err: error, targetLedger }, "Manual rollback failed");
        return reply.status(500).send({
          error: "Rollback failed",
          code: "ROLLBACK_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * GET /api/v1/indexer/status
   * Get current indexer status including health metrics.
   */
  fastify.get(
    "/api/v1/indexer/status",
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const latestHeader = await blockDAG.getLatestBlockHeader();
        const recentReorgs = await reorgHandler.getRecentReorgEvents(10);
        const rpcHealth = rpcFailover.getAllNodeHealth();
        const snapshots = await snapshotEngine.getAllSnapshots();

        return reply.send({
          latestBlockHeader: latestHeader,
          recentReorgs,
          rpcHealth,
          snapshots: {
            count: snapshots.length,
            latest: snapshots[0] ?? null,
            all: snapshots,
          },
          currentRpcUrl: rpcFailover.getCurrentRpcUrl(),
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to get indexer status");
        return reply.status(500).send({
          error: "Failed to get status",
          code: "STATUS_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * GET /api/v1/indexer/dag
   * Get the block DAG for inspection.
   */
  fastify.get(
    "/api/v1/indexer/dag",
    async (
      req: FastifyRequest<{
        Querystring: { fromLedger?: string; toLedger?: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const fromLedger = req.query.fromLedger ? parseInt(req.query.fromLedger) : 0;
        const toLedger = req.query.toLedger ? parseInt(req.query.toLedger) : Number.MAX_SAFE_INTEGER;

        const headers = await blockDAG.getBlockHeadersInRange(fromLedger, toLedger);

        return reply.send({
          headers,
          count: headers.length,
          range: { from: fromLedger, to: toLedger },
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to get block DAG");
        return reply.status(500).send({
          error: "Failed to get DAG",
          code: "DAG_FETCH_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * POST /api/v1/indexer/snapshots
   * Create a manual snapshot at the current ledger.
   * Note: With block header snapshots, this is essentially a no-op as every block header serves as a snapshot point.
   */
  fastify.post(
    "/api/v1/indexer/snapshots",
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const latestHeader = await blockDAG.getLatestBlockHeader();
        if (!latestHeader) {
          return reply.status(400).send({
            error: "No blocks indexed yet",
            code: "NO_BLOCKS_INDEXED",
          });
        }

        // With block header snapshots, every header is effectively a snapshot point
        // We return the current state as the "snapshot"
        const tablesSnapshot = await (snapshotEngine as any).generateTablesSnapshot();

        return reply.send({
          success: true,
          snapshot: {
            ledger_sequence: latestHeader.ledger_sequence,
            block_hash: latestHeader.block_hash,
            created_at: latestHeader.created_at,
            tables_snapshot: tablesSnapshot,
          },
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to create snapshot");
        return reply.status(500).send({
          error: "Failed to create snapshot",
          code: "SNAPSHOT_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * DELETE /api/v1/indexer/snapshots/:ledgerSequence
   * Delete a specific snapshot.
   * Note: With block header snapshots, deletion is not supported as headers are needed for DAG continuity.
   */
  fastify.delete(
    "/api/v1/indexer/snapshots/:ledgerSequence",
    async (
      req: FastifyRequest<{
        Params: { ledgerSequence: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const ledgerSequence = parseInt(req.params.ledgerSequence);
        if (!Number.isInteger(ledgerSequence) || ledgerSequence < 0) {
          return reply.status(400).send({
            error: "Invalid ledger sequence",
            code: "INVALID_LEDGER_SEQUENCE",
          });
        }

        // With block header snapshots, we don't support deletion
        return reply.status(400).send({
          error: "Cannot delete snapshots when using block headers as snapshot points",
          code: "SNAPSHOT_DELETE_NOT_SUPPORTED",
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to delete snapshot");
        return reply.status(500).send({
          error: "Failed to delete snapshot",
          code: "SNAPSHOT_DELETE_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * POST /api/v1/indexer/rpc/switch
   * Manually switch to a specific RPC node.
   */
  fastify.post(
    "/api/v1/indexer/rpc/switch",
    async (
      req: FastifyRequest<{
        Body: { rpcUrl: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { rpcUrl } = req.body;

        if (!rpcUrl) {
          return reply.status(400).send({
            error: "RPC URL is required",
            code: "MISSING_RPC_URL",
          });
        }

        rpcFailover.switchToNode(rpcUrl);

        return reply.send({
          success: true,
          currentRpcUrl: rpcFailover.getCurrentRpcUrl(),
        });
      } catch (error) {
        fastify.log.error({ err: error, rpcUrl }, "Failed to switch RPC node");
        return reply.status(500).send({
          error: "Failed to switch RPC node",
          code: "RPC_SWITCH_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * POST /api/v1/indexer/rpc/reset/:rpcUrl
   * Reset health status for a specific RPC node.
   */
  fastify.post(
    "/api/v1/indexer/rpc/reset/:rpcUrl",
    async (
      req: FastifyRequest<{
        Params: { rpcUrl: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const rpcUrl = decodeURIComponent(req.params.rpcUrl);
        rpcFailover.resetNodeHealth(rpcUrl);

        return reply.send({
          success: true,
          resetRpcUrl: rpcUrl,
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to reset RPC node health");
        return reply.status(500).send({
          error: "Failed to reset RPC node health",
          code: "RPC_RESET_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * GET /api/v1/indexer/reorgs
   * Get reorg event history.
   */
  fastify.get(
    "/api/v1/indexer/reorgs",
    async (
      req: FastifyRequest<{
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const limit = req.query.limit ? parseInt(req.query.limit) : 20;
        const reorgs = await reorgHandler.getRecentReorgEvents(limit);

        return reply.send({
          reorgs,
          count: reorgs.length,
        });
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to get reorg history");
        return reply.status(500).send({
          error: "Failed to get reorg history",
          code: "REORG_HISTORY_FAILED",
          message: (error as Error).message,
        });
      }
    },
  );
}
