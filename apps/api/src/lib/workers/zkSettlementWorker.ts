import { createClient, type RedisClientType } from "redis";
import { ZK_SETTLEMENT } from "@velo/shared";
import { inMemoryZkRegistry } from "../../routes/zk-settle.js";

export interface ZkJobPayload {
  nullifierHash: string;
  commitment: string;
  proof: string;
  attempts: number;
}

export class ZkSettlementWorker {
  private redisClient: RedisClientType | null = null;
  private isRunning = false;
  private isShuttingDown = false;
  private activeTasksCount = 0;

  constructor(private redisUrl?: string) {}

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.redisUrl) {
      try {
        this.redisClient = createClient({ url: this.redisUrl });
        await this.redisClient.connect();

        // Ensure consumer group exists
        try {
          await this.redisClient.xGroupCreate(
            ZK_SETTLEMENT.STREAM_KEY,
            ZK_SETTLEMENT.GROUP_NAME,
            "0",
            { MKSTREAM: true }
          );
        } catch (e) {
          // Group might already exist
        }

        this.pollLoop();
      } catch (err) {
        console.error("Failed to start ZkSettlementWorker Redis client:", err);
      }
    }

    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown() {
    process.on("SIGTERM", async () => {
      await this.shutdown();
    });
  }

  async shutdown(timeoutMs = 10000) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isRunning = false;

    console.log("ZkSettlementWorker shutting down... Waiting for active tasks.");
    const startTime = Date.now();

    while (this.activeTasksCount > 0 && Date.now() - startTime < timeoutMs) {
      await new Promise((res) => setTimeout(res, 200));
    }

    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
    console.log("ZkSettlementWorker shutdown complete.");
  }

  private async pollLoop() {
    while (this.isRunning && !this.isShuttingDown && this.redisClient?.isOpen) {
      try {
        const response = await this.redisClient.xReadGroup(
          ZK_SETTLEMENT.GROUP_NAME,
          "worker-1",
          [{ key: ZK_SETTLEMENT.STREAM_KEY, id: ">" }],
          { COUNT: 1, BLOCK: 2000 }
        );

        if (response && response.length > 0) {
          for (const streamResult of response) {
            for (const message of streamResult.messages) {
              await this.processJob(message.id, message.message as any);
            }
          }
        }
      } catch (err) {
        if (!this.isShuttingDown) {
          console.error("Error in ZkSettlementWorker loop:", err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  async processJob(jobId: string, rawData: Record<string, string>) {
    this.activeTasksCount++;
    const nullifierHash = rawData.nullifierHash;
    const commitment = rawData.commitment;
    const proof = rawData.proof;
    let attempts = parseInt(rawData.attempts || "0", 10);

    try {
      // Simulate Soroban RPC settlement execution
      if (proof.includes("rpc_fail")) {
        throw new Error("Soroban RPC transaction simulation failed");
      }

      const txHash = "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

      // Mark settled in memory
      if (inMemoryZkRegistry.has(nullifierHash)) {
        const rec = inMemoryZkRegistry.get(nullifierHash)!;
        rec.status = "SETTLED";
        rec.txHash = txHash;
        rec.updatedAt = new Date();
      }

      // Ack message if redis active
      if (this.redisClient?.isOpen) {
        await this.redisClient.xAck(ZK_SETTLEMENT.STREAM_KEY, ZK_SETTLEMENT.GROUP_NAME, jobId);
      }
    } catch (err: any) {
      attempts++;
      if (attempts >= ZK_SETTLEMENT.MAX_RETRIES) {
        // Move to DLQ
        if (inMemoryZkRegistry.has(nullifierHash)) {
          const rec = inMemoryZkRegistry.get(nullifierHash)!;
          rec.status = "REJECTED";
          rec.errorMessage = err.message || "Failed after 5 attempts";
          rec.updatedAt = new Date();
        }

        if (this.redisClient?.isOpen) {
          await this.redisClient.xAdd(ZK_SETTLEMENT.DLQ_KEY, "*", {
            nullifierHash,
            commitment,
            error: err.message || "Max retries exceeded",
            attempts: String(attempts),
          });
          await this.redisClient.xAck(ZK_SETTLEMENT.STREAM_KEY, ZK_SETTLEMENT.GROUP_NAME, jobId);
        }
      } else {
        // Exponential backoff with jitter
        const delayMs = 1000 * Math.pow(2, attempts) + Math.floor(Math.random() * 100);
        await new Promise((res) => setTimeout(res, Math.min(delayMs, 2000)));
      }
    } finally {
      this.activeTasksCount--;
    }
  }
}
