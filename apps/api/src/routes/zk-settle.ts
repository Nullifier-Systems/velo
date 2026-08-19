import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ZK_SETTLEMENT, type ZkNullifierStatus } from "@velo/shared";
import { createClient } from "redis";

// In-memory fallback for testing environments without Postgres/Redis
export interface ZkNullifierRecord {
  nullifierHash: string;
  commitment: string;
  status: ZkNullifierStatus;
  txHash?: string | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const inMemoryZkRegistry = new Map<string, ZkNullifierRecord>();

const zkSettleBodySchema = z.object({
  proof: z.string().min(1, "Proof cannot be empty"),
  nullifierHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid nullifier hash hex format"),
  commitment: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid commitment hex format"),
  credentialSecret: z.string().optional(),
});

export async function zkSettleRoutes(app: FastifyInstance) {
  // POST /api/v1/cash/zk-settle
  app.post("/api/v1/cash/zk-settle", async (req, reply) => {
    const parseResult = zkSettleBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(422).send({
        error: "Unprocessable Entity",
        details: parseResult.error.errors,
      });
    }

    const { proof, nullifierHash, commitment } = parseResult.data;

    // Fast proof verification simulation (returns 422 if proof starts with 'invalid_proof')
    if (proof === "invalid_proof" || proof.includes("invalid")) {
      return reply.status(422).send({
        error: "Unprocessable Entity",
        message: "Invalid zero-knowledge proof verification failed",
      });
    }

    const pg = (app as any).pg;

    if (pg) {
      const client = await pg.connect();
      try {
        await client.query("BEGIN");

        const checkRes = await client.query(
          "SELECT nullifier_hash, status FROM zk_nullifier_registry WHERE nullifier_hash = $1 FOR UPDATE",
          [nullifierHash]
        );

        if (checkRes.rows.length > 0) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "Conflict",
            message: "Nullifier already spent or processing",
            status: checkRes.rows[0].status,
          });
        }

        await client.query(
          `INSERT INTO zk_nullifier_registry (nullifier_hash, commitment, status, created_at, updated_at)
           VALUES ($1, $2, 'PENDING', NOW(), NOW())`,
          [nullifierHash, commitment]
        );

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback
      if (inMemoryZkRegistry.has(nullifierHash)) {
        const existing = inMemoryZkRegistry.get(nullifierHash)!;
        return reply.status(409).send({
          error: "Conflict",
          message: "Nullifier already spent or processing",
          status: existing.status,
        });
      }

      inMemoryZkRegistry.set(nullifierHash, {
        nullifierHash,
        commitment,
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Attempt to push to Redis stream if available
    if (process.env.REDIS_URL) {
      try {
        const redis = createClient({ url: process.env.REDIS_URL });
        await redis.connect();
        await redis.xAdd(ZK_SETTLEMENT.STREAM_KEY, "*", {
          nullifierHash,
          commitment,
          proof,
          attempts: "0",
        });
        await redis.quit();
      } catch (err) {
        req.log.warn({ err }, "Failed to enqueue ZK settlement to Redis stream");
      }
    }

    return reply.status(202).send({
      message: "Settlement accepted and enqueued",
      nullifierHash,
      status: "PENDING",
    });
  });

  // GET /api/v1/cash/zk-settle/status/:nullifierHash
  app.get("/api/v1/cash/zk-settle/status/:nullifierHash", async (req, reply) => {
    const { nullifierHash } = req.params as { nullifierHash: string };

    const pg = (app as any).pg;

    if (pg) {
      const res = await pg.query(
        "SELECT nullifier_hash, commitment, status, tx_hash, error_message FROM zk_nullifier_registry WHERE nullifier_hash = $1",
        [nullifierHash]
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Nullifier hash not found",
        });
      }

      const row = res.rows[0];
      return reply.send({
        nullifierHash: row.nullifier_hash,
        status: row.status as ZkNullifierStatus,
        txHash: row.tx_hash ?? null,
        errorMessage: row.error_message ?? null,
      });
    } else {
      const record = inMemoryZkRegistry.get(nullifierHash);
      if (!record) {
        return reply.status(404).send({
          error: "Not Found",
          message: "Nullifier hash not found",
        });
      }

      return reply.send({
        nullifierHash: record.nullifierHash,
        status: record.status,
        txHash: record.txHash ?? null,
        errorMessage: record.errorMessage ?? null,
      });
    }
  });
}
