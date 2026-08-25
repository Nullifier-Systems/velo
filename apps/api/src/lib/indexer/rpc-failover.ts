import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Server } from "@stellar/stellar-sdk/rpc";
import type { IndexerRpcNodeHealth } from "@velo/shared";
import { REORG_RESILIENT_INDEXER } from "@velo/shared";

/**
 * RPC Failover manages multiple RPC node endpoints with automatic failover.
 * 
 * This component:
 * 1. Tracks health status of multiple RPC nodes
 * 2. Automatically switches to healthy nodes on failure
 * 3. Implements circuit breaker pattern for unhealthy nodes
 * 4. Provides <500ms failover as specified in requirements
 */
export class RpcFailover {
  private rpcServers: Map<string, Server>;
  private currentRpcUrl: string;
  private healthChecks: Map<string, NodeHealthStatus>;

  constructor(
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    rpcUrls: string[],
    private readonly ServerClass: new (url: string, options?: any) => Server,
  ) {
    this.rpcServers = new Map();
    this.healthChecks = new Map();
    
    // Initialize RPC servers
    for (const url of rpcUrls) {
      try {
        const server = new this.ServerClass(url, { allowHttp: url.startsWith("http://") });
        this.rpcServers.set(url, server);
        this.healthChecks.set(url, {
          isHealthy: true,
          consecutiveFailures: 0,
          lastCheck: new Date(),
          lastSuccessAt: new Date(),
        });
        this.logger.info({ rpcUrl: url }, "RPC node initialized");
      } catch (error) {
        this.logger.error({ err: error, rpcUrl: url }, "Failed to initialize RPC node");
        this.healthChecks.set(url, {
          isHealthy: false,
          consecutiveFailures: REORG_RESILIENT_INDEXER.MAX_CONSECUTIVE_RPC_FAILURES,
          lastCheck: new Date(),
          lastFailureReason: "Initialization failed",
        });
      }
    }

    // Set initial current RPC to first healthy node
    const healthyNode = this.findHealthyNode();
    this.currentRpcUrl = healthyNode || rpcUrls[0];
    
    this.logger.info(
      { currentRpcUrl: this.currentRpcUrl, totalNodes: rpcUrls.length },
      "RPC failover initialized",
    );
  }

  /**
   * Get the current active RPC server.
   * 
   * @returns The current Server instance
   */
  getCurrentRpc(): Server {
    const server = this.rpcServers.get(this.currentRpcUrl);
    if (!server) {
      throw new Error(`Current RPC URL ${this.currentRpcUrl} not found in servers map`);
    }
    return server;
  }

  /**
   * Get the current RPC URL.
   * 
   * @returns The current RPC URL string
   */
  getCurrentRpcUrl(): string {
    return this.currentRpcUrl;
  }

  /**
   * Execute an RPC call with automatic failover.
   * 
   * @param rpcCall - The RPC call function to execute
   * @param operationName - Name of the operation for logging
   * @returns The result of the RPC call
   */
  async executeWithFailover<T>(
    rpcCall: (server: Server) => Promise<T>,
    operationName: string,
  ): Promise<T> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    // Try current node first
    try {
      const result = await this.executeWithTimeout(
        () => rpcCall(this.getCurrentRpc()),
        REORG_RESILIENT_INDEXER.RPC_FAILOVER_TIMEOUT_MS,
      );
      this.recordSuccess(this.currentRpcUrl);
      return result;
    } catch (error) {
      lastError = error as Error;
      this.recordFailure(this.currentRpcUrl, error as Error);
    }

    // If current node failed, try other healthy nodes
    const healthyNodes = this.getHealthyNodes();
    for (const rpcUrl of healthyNodes) {
      if (rpcUrl === this.currentRpcUrl) continue; // Already tried this one

      try {
        this.logger.info(
          { previousRpcUrl: this.currentRpcUrl, newRpcUrl: rpcUrl, operationName },
          "Failing over to alternative RPC node",
        );

        const server = this.rpcServers.get(rpcUrl);
        if (!server) continue;

        const result = await this.executeWithTimeout(
          () => rpcCall(server),
          REORG_RESILIENT_INDEXER.RPC_FAILOVER_TIMEOUT_MS,
        );

        // Switch to this node
        this.currentRpcUrl = rpcUrl;
        this.recordSuccess(rpcUrl);

        const failoverTime = Date.now() - startTime;
        this.logger.info(
          { newRpcUrl: rpcUrl, operationName, failoverTimeMs: failoverTime },
          "RPC failover successful",
        );

        return result;
      } catch (error) {
        this.recordFailure(rpcUrl, error as Error);
        lastError = error as Error;
      }
    }

    // All nodes failed
    const totalTime = Date.now() - startTime;
    this.logger.error(
      { operationName, totalTimeMs: totalTime, lastError },
      "All RPC nodes failed",
    );
    throw new Error(
      `All RPC nodes failed for operation ${operationName}. Last error: ${lastError?.message}`,
    );
  }

  /**
   * Execute a function with a timeout.
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Record a successful RPC call for a node.
   */
  private recordSuccess(rpcUrl: string): void {
    const health = this.healthChecks.get(rpcUrl);
    if (health) {
      health.isHealthy = true;
      health.consecutiveFailures = 0;
      health.lastCheck = new Date();
      health.lastSuccessAt = new Date();
      health.lastFailureReason = undefined;
      this.healthChecks.set(rpcUrl, health);
    }
  }

  /**
   * Record a failed RPC call for a node.
   */
  private recordFailure(rpcUrl: string, error: Error): void {
    const health = this.healthChecks.get(rpcUrl);
    if (health) {
      health.consecutiveFailures++;
      health.lastCheck = new Date();
      health.lastFailureReason = error.message;

      // Mark as unhealthy if threshold exceeded
      if (health.consecutiveFailures >= REORG_RESILIENT_INDEXER.MAX_CONSECUTIVE_RPC_FAILURES) {
        health.isHealthy = false;
        this.logger.warn(
          { rpcUrl, consecutiveFailures: health.consecutiveFailures },
          "RPC node marked as unhealthy",
        );
      }

      this.healthChecks.set(rpcUrl, health);
    }
  }

  /**
   * Find a healthy RPC node.
   */
  private findHealthyNode(): string | undefined {
    for (const [url, health] of this.healthChecks.entries()) {
      if (health.isHealthy) {
        return url;
      }
    }
    return undefined;
  }

  /**
   * Get all healthy RPC node URLs.
   */
  private getHealthyNodes(): string[] {
    const healthy: string[] = [];
    for (const [url, health] of this.healthChecks.entries()) {
      if (health.isHealthy) {
        healthy.push(url);
      }
    }
    return healthy;
  }

  /**
   * Get health status for all RPC nodes.
   */
  getAllNodeHealth(): IndexerRpcNodeHealth[] {
    const healthStatus: IndexerRpcNodeHealth[] = [];
    for (const [url, health] of this.healthChecks.entries()) {
      healthStatus.push({
        id: randomUUID(),
        rpc_url: url,
        is_healthy: health.isHealthy,
        last_check: health.lastCheck.toISOString(),
        consecutive_failures: health.consecutiveFailures,
        last_failure_reason: health.lastFailureReason,
        last_success_at: health.lastSuccessAt?.toISOString(),
      });
    }
    return healthStatus;
  }

  /**
   * Manually switch to a specific RPC node.
   * 
   * @param rpcUrl - The RPC URL to switch to
   */
  switchToNode(rpcUrl: string): void {
    if (!this.rpcServers.has(rpcUrl)) {
      throw new Error(`RPC URL ${rpcUrl} not found`);
    }
    this.logger.info(
      { previousRpcUrl: this.currentRpcUrl, newRpcUrl: rpcUrl },
      "Manually switching RPC node",
    );
    this.currentRpcUrl = rpcUrl;
  }

  /**
   * Reset health status for a specific node (useful for manual recovery).
   * 
   * @param rpcUrl - The RPC URL to reset
   */
  resetNodeHealth(rpcUrl: string): void {
    const health = this.healthChecks.get(rpcUrl);
    if (health) {
      health.isHealthy = true;
      health.consecutiveFailures = 0;
      health.lastCheck = new Date();
      health.lastFailureReason = undefined;
      this.healthChecks.set(rpcUrl, health);
      this.logger.info({ rpcUrl }, "RPC node health reset");
    }
  }

  /**
   * Periodic health check for all nodes.
   * 
   * This should be called on a timer to proactively check node health.
   */
  async performHealthChecks(): Promise<void> {
    for (const [rpcUrl, server] of this.rpcServers.entries()) {
      try {
        // Simple health check - get latest ledger
        await server.getLatestLedger();
        this.recordSuccess(rpcUrl);
      } catch (error) {
        this.recordFailure(rpcUrl, error as Error);
      }
    }
  }
}

interface NodeHealthStatus {
  isHealthy: boolean;
  consecutiveFailures: number;
  lastCheck: Date;
  lastSuccessAt?: Date;
  lastFailureReason?: string;
}
