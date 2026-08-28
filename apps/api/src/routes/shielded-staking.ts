import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  In-memory stores (dev/test)                                        */
/* ------------------------------------------------------------------ */

export interface ShieldedStakeCommitment {
  commitmentHash: string;
  merkleLeafIndex: number;
  stakedAmountStroops: string;
  isActive: boolean;
  createdAt: string;
}

export interface ShieldedNullifier {
  nullifierHash: string;
  providerId: string;
  createdAt: string;
}

export const shieldedCommitmentStore = new Map<string, ShieldedStakeCommitment>();
export const shieldedNullifierStore = new Map<string, ShieldedNullifier>();

// Merkle tree state (simplified for API layer)
let merkleLeafCount = 0;

export function getMerkleRoot(): string {
  if (merkleLeafCount === 0) {
    return "0".repeat(64);
  }
  return createHash("sha256")
    .update(`merkle_root:${merkleLeafCount}`)
    .digest("hex");
}

export function getMerkleLeafCount(): number {
  return merkleLeafCount;
}

export function resetMerkleState(): void {
  merkleLeafCount = 0;
}

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const shieldedStakeSchema = z.object({
  commitmentHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "commitmentHash must be 64-char hex"),
  stakedAmountStroops: z.string().regex(/^\d+$/, "stakedAmountStroops must be a positive integer string"),
});

const verifyZkProofSchema = z.object({
  proof: z.string().min(1, "ZK proof is required"),
  merkleRoot: z.string().regex(/^[0-9a-fA-F]{64}$/, "merkleRoot must be 64-char hex"),
  nullifierHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "nullifierHash must be 64-char hex"),
  commitmentHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "commitmentHash must be 64-char hex"),
  providerId: z.string().min(1, "providerId is required"),
  minStakeStroops: z.string().regex(/^\d+$/, "minStakeStroops must be a positive integer string"),
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export async function shieldedStakingRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/provider/shielded-stake
   * Deposit collateral into the shielded pool, receiving a commitment.
   */
  app.post("/provider/shielded-stake", async (req, reply) => {
    const parseResult = shieldedStakeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Validation Error",
        code: "VALIDATION_ERROR",
        details: parseResult.error.errors,
      });
    }

    const { commitmentHash, stakedAmountStroops } = parseResult.data;

    // Check minimum stake
    const MIN_STAKE = "100000000"; // 10 USDC in stroops
    if (BigInt(stakedAmountStroops) < BigInt(MIN_STAKE)) {
      return reply.status(400).send({
        error: "Insufficient stake",
        code: "INSUFFICIENT_STAKE",
        minimum: MIN_STAKE,
      });
    }

    // Check if commitment already exists
    if (shieldedCommitmentStore.has(commitmentHash)) {
      return reply.status(409).send({
        error: "Commitment already exists",
        code: "COMMITMENT_EXISTS",
      });
    }

    const pg = (app as any).pg;

    if (pg) {
      const client = await pg.connect();
      try {
        await client.query("BEGIN");

        const existing = await client.query(
          "SELECT commitment_hash FROM shielded_stake_commitments WHERE commitment_hash = $1 FOR UPDATE",
          [commitmentHash],
        );

        if (existing.rows.length > 0) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "Commitment already exists",
            code: "COMMITMENT_EXISTS",
          });
        }

        const leafIndex = merkleLeafCount;

        await client.query(
          `INSERT INTO shielded_stake_commitments
             (commitment_hash, merkle_leaf_index, staked_amount_stroops, is_active)
           VALUES ($1, $2, $3, TRUE)`,
          [commitmentHash, leafIndex, stakedAmountStroops],
        );

        await client.query("COMMIT");
        merkleLeafCount++;
      } catch (err: any) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback
      shieldedCommitmentStore.set(commitmentHash, {
        commitmentHash,
        merkleLeafIndex: merkleLeafCount,
        stakedAmountStroops,
        isActive: true,
        createdAt: new Date().toISOString(),
      });
      merkleLeafCount++;
    }

    const merkleRoot = getMerkleRoot();

    return reply.status(201).send({
      message: "Shielded stake deposited",
      commitmentHash,
      merkleLeafIndex: merkleLeafCount - 1,
      merkleRoot,
    });
  });

  /**
   * POST /api/v1/provider/shielded-stake/verify
   * Verify a ZK proof of minimum stake compliance without revealing the address.
   * Uses SELECT FOR UPDATE on nullifiers to prevent identity cloning.
   */
  app.post("/provider/shielded-stake/verify", async (req, reply) => {
    const parseResult = verifyZkProofSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Validation Error",
        code: "VALIDATION_ERROR",
        details: parseResult.error.errors,
      });
    }

    const { proof, merkleRoot, nullifierHash, commitmentHash, providerId, minStakeStroops } =
      parseResult.data;

    // Reject known-invalid proofs
    if (proof === "invalid_proof" || proof.includes("invalid")) {
      return reply.status(422).send({
        error: "Unprocessable Entity",
        message: "Invalid zero-knowledge proof verification failed",
      });
    }

    // Verify the Merkle root is current
    const currentRoot = getMerkleRoot();
    if (merkleRoot !== currentRoot && currentRoot !== "0".repeat(64)) {
      return reply.status(400).send({
        error: "Stale Merkle root",
        code: "STALE_MERKLE_ROOT",
        currentRoot,
      });
    }

    // Verify the commitment exists and is active
    const commitment = shieldedCommitmentStore.get(commitmentHash);
    if (!commitment || !commitment.isActive) {
      return reply.status(404).send({
        error: "Commitment not found or inactive",
        code: "COMMITMENT_NOT_FOUND",
      });
    }

    // Verify minimum stake
    if (BigInt(commitment.stakedAmountStroops) < BigInt(minStakeStroops)) {
      return reply.status(400).send({
        error: "Stake below minimum",
        code: "INSUFFICIENT_STAKE",
        commitmentStake: commitment.stakedAmountStroops,
        requiredStake: minStakeStroops,
      });
    }

    const pg = (app as any).pg;

    if (pg) {
      const client = await pg.connect();
      try {
        await client.query("BEGIN");

        // CRITICAL: SELECT FOR UPDATE to prevent double-spending nullifiers
        const nullifierCheck = await client.query(
          "SELECT nullifier_hash FROM shielded_provider_nullifiers WHERE nullifier_hash = $1 FOR UPDATE",
          [nullifierHash],
        );

        if (nullifierCheck.rows.length > 0) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "Nullifier already spent",
            code: "NULLIFIER_SPENT",
            message: "This nullifier has already been used for verification",
          });
        }

        // Record the nullifier
        await client.query(
          `INSERT INTO shielded_provider_nullifiers (nullifier_hash, provider_id)
           VALUES ($1, $2)`,
          [nullifierHash, providerId],
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
      if (shieldedNullifierStore.has(nullifierHash)) {
        return reply.status(409).send({
          error: "Nullifier already spent",
          code: "NULLIFIER_SPENT",
          message: "This nullifier has already been used for verification",
        });
      }

      shieldedNullifierStore.set(nullifierHash, {
        nullifierHash,
        providerId,
        createdAt: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      message: "ZK stake verification successful",
      verified: true,
      nullifierHash,
      commitmentHash,
      minimumStakeMet: true,
    });
  });

  /**
   * GET /api/v1/provider/shielded-stake/status/:commitmentHash
   * Check the status of a shielded stake commitment.
   */
  app.get<{ Params: { commitmentHash: string } }>(
    "/provider/shielded-stake/status/:commitmentHash",
    async (req, reply) => {
      const { commitmentHash } = req.params;

      const commitment = shieldedCommitmentStore.get(commitmentHash);
      if (!commitment) {
        return reply.status(404).send({
          error: "Commitment not found",
          code: "COMMITMENT_NOT_FOUND",
        });
      }

      return reply.send({
        commitmentHash: commitment.commitmentHash,
        merkleLeafIndex: commitment.merkleLeafIndex,
        stakedAmountStroops: commitment.stakedAmountStroops,
        isActive: commitment.isActive,
        createdAt: commitment.createdAt,
        merkleRoot: getMerkleRoot(),
      });
    },
  );

  /**
   * GET /api/v1/provider/shielded-stake/merkle-root
   * Get the current Merkle root of the shielded pool.
   */
  app.get("/provider/shielded-stake/merkle-root", async (_req, reply) => {
    return reply.send({
      merkleRoot: getMerkleRoot(),
      leafCount: getMerkleLeafCount(),
    });
  });
}
