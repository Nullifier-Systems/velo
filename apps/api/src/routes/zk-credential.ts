/**
 * ZK Credential Routes
 * POST /api/v1/zk/verify-range-proof - Verify range proof and issue attestation
 * GET /api/v1/zk/commitments/:userId - Retrieve user's commitments
 * POST /api/v1/zk/commitments - Issue new commitment
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { validateRangeProof } from "../lib/zk/range-proof.js";
import {
  CommitmentIssuer,
  createCommitmentIssuer,
} from "../lib/zk/commitment-issuer.js";
import {
  globalPedersenVault,
  generateBlindingSalt,
} from "../lib/zk/pedersen-vault.js";
import type {
  ZkRangeProofRequest,
  ZkVerificationResponse,
  PedersenCommitment,
  ZkAttestation,
} from "@velo/shared";

const verifyRangeProofSchema = z.object({
  commitmentId: z.string().uuid(),
  proofHex: z.string().regex(/^[a-f0-9]+$/i),
  rangeMin: z.string().transform((v) => BigInt(v)),
  rangeMax: z.string().transform((v) => BigInt(v)),
});

const issueCommitmentSchema = z.object({
  userId: z.string().regex(/^[A-Z0-9]{56}$/),
  value: z.string().transform((v) => BigInt(v)),
  attributeType: z.enum([
    "credit_score",
    "net_worth",
    "account_age_days",
    "transaction_volume",
  ]),
  expiresInDays: z.number().int().positive().default(30),
});

interface ZkCredentialRouteOptions {
  db: any; // postgres client
  redis?: any;
  issuerKeypair?: any; // Stellar Keypair for signing
}

// Global issuer (initialized on first request)
let globalIssuer: CommitmentIssuer | null = null;

function getIssuer(options: ZkCredentialRouteOptions): CommitmentIssuer {
  if (!globalIssuer) {
    if (!options.issuerKeypair) {
      throw new Error("Issuer keypair not configured");
    }
    globalIssuer = new CommitmentIssuer(
      options.issuerKeypair,
      globalPedersenVault,
    );
  }
  return globalIssuer;
}

export async function zkCredentialRoutes(
  app: FastifyInstance,
  options: ZkCredentialRouteOptions,
) {
  /**
   * POST /api/v1/zk/verify-range-proof
   * Verify a ZK range proof and issue attestation if valid
   */
  app.post<{ Body: z.infer<typeof verifyRangeProofSchema> }>(
    "/zk/verify-range-proof",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = verifyRangeProofSchema.parse(req.body);

        // Fetch commitment from database
        const commitmentResult = await options.db`
          SELECT commitment_hex, user_id, attribute_type, salt_hex 
          FROM pedersen_commitments 
          WHERE commitment_id = ${body.commitmentId}
        `;

        if (commitmentResult.length === 0) {
          throw new ApiError(
            404,
            "COMMITMENT_NOT_FOUND",
            "Commitment does not exist",
          );
        }

        const commitment = commitmentResult[0];

        // Validate range proof
        const proofValidation = validateRangeProof({
          commitmentHex: commitment.commitment_hex,
          proofHex: body.proofHex,
          rangeMin: body.rangeMin,
          rangeMax: body.rangeMax,
        });

        if (!proofValidation.isValid) {
          // Record failed proof attempt
          await options.db`
            INSERT INTO zk_range_proofs 
            (commitment_id, user_id, proof_hex, range_min, range_max, status, error_message)
            VALUES (${body.commitmentId}, ${commitment.user_id}, ${body.proofHex}, 
                    ${body.rangeMin}, ${body.rangeMax}, 'rejected', ${proofValidation.error})
          `;

          return reply.status(400).send({
            status: "rejected",
            error: proofValidation.error || "Proof validation failed",
          } as ZkVerificationResponse);
        }

        // Proof is valid - record it
        const proofResult = await options.db`
          INSERT INTO zk_range_proofs 
          (commitment_id, user_id, proof_hex, range_min, range_max, status, verification_time)
          VALUES (${body.commitmentId}, ${commitment.user_id}, ${body.proofHex}, 
                  ${body.rangeMin}, ${body.rangeMax}, 'verified', NOW())
          RETURNING proof_id
        `;

        const proofId = proofResult[0].proof_id;

        // Issue attestation
        const issuer = getIssuer(options);
        const attestationHash = Buffer.from(
          `${body.commitmentId}:${body.rangeMin}:${body.rangeMax}:${Date.now()}`,
        ).toString("hex");

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // Attestation valid for 7 days

        const attestationResult = await options.db`
          INSERT INTO zk_attestations 
          (proof_id, user_id, issuer_public_key, attestation_hex, attestation_hash, expires_at)
          VALUES (${proofId}, ${commitment.user_id}, ${issuer.getIssuerPublicKey()}, 
                  ${attestationHash}, ${attestationHash}, ${expiresAt})
          RETURNING attestation_id, proof_id, user_id, issuer_public_key, 
                    attestation_hex, attestation_hash, expires_at, created_at
        `;

        const attestation = attestationResult[0];

        return reply.status(200).send({
          proofId,
          status: "verified",
          attestation: {
            attestationId: attestation.attestation_id,
            proofId: attestation.proof_id,
            userId: (attestation as any).user_id,
            issuerPublicKey: attestation.issuer_public_key,
            attestationHex: attestation.attestation_hex,
            attestationHash: attestation.attestation_hash,
            expiresAt: attestation.expires_at.toISOString(),
            createdAt: attestation.created_at.toISOString(),
          } as ZkAttestation,
        } as ZkVerificationResponse);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Verification failed";
        throw new ApiError(500, "VERIFICATION_ERROR", message);
      }
    },
  );

  /**
   * POST /api/v1/zk/commitments
   * Issue a new Pedersen commitment for a user value
   */
  app.post<{ Body: z.infer<typeof issueCommitmentSchema> }>(
    "/zk/commitments",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = issueCommitmentSchema.parse(req.body);

        const issuer = getIssuer(options);
        const { commitment, signedAttestation } = await issuer.issueCommitment({
          userId: body.userId,
          value: body.value,
          attributeType: body.attributeType,
          expiresInDays: body.expiresInDays,
        });

        // Store commitment in database
        await options.db`
          INSERT INTO pedersen_commitments 
          (commitment_id, user_id, commitment_hex, salt_hex, attribute_type, expires_at)
          VALUES (${commitment.commitmentId}, ${commitment.userId}, 
                  ${commitment.commitmentHex}, ${commitment.saltHex}, 
                  ${commitment.attributeType}, ${commitment.expiresAt})
        `;

        return reply.status(201).send({
          commitmentId: commitment.commitmentId,
          commitmentHex: commitment.commitmentHex,
          attributeType: commitment.attributeType,
          expiresAt: commitment.expiresAt,
          signedAttestation,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to issue commitment";
        throw new ApiError(500, "ISSUANCE_ERROR", message);
      }
    },
  );

  /**
   * GET /api/v1/zk/commitments/:userId
   * Retrieve user's Pedersen commitments
   */
  app.get<{ Params: { userId: string } }>(
    "/zk/commitments/:userId",
    async (
      req: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { userId } = req.params;

        if (!userId.match(/^[A-Z0-9]{56}$/)) {
          throw new ApiError(400, "INVALID_ADDRESS", "Invalid Stellar address");
        }

        const commitments = await options.db`
          SELECT commitment_id, user_id, commitment_hex, attribute_type, created_at, expires_at
          FROM pedersen_commitments 
          WHERE user_id = ${userId} AND expires_at > NOW()
          ORDER BY created_at DESC
        `;

        return reply.status(200).send({
          userId,
          commitments: commitments.map((c: any) => ({
            commitmentId: c.commitment_id,
            userId: (c as any).user_id,
            commitmentHex: c.commitment_hex,
            attributeType: c.attribute_type,
            createdAt: c.created_at.toISOString(),
            expiresAt: c.expires_at.toISOString(),
          })),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to retrieve commitments";
        throw new ApiError(500, "RETRIEVAL_ERROR", message);
      }
    },
  );

  /**
   * GET /api/v1/zk/attestations/:userId
   * Retrieve user's verified attestations
   */
  app.get<{ Params: { userId: string } }>(
    "/zk/attestations/:userId",
    async (
      req: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { userId } = req.params;

        if (!userId.match(/^[A-Z0-9]{56}$/)) {
          throw new ApiError(400, "INVALID_ADDRESS", "Invalid Stellar address");
        }

        const attestations = await options.db`
          SELECT attestation_id, proof_id, user_id, issuer_public_key, 
                 attestation_hex, attestation_hash, expires_at, created_at
          FROM zk_attestations 
          WHERE user_id = ${userId} AND expires_at > NOW()
          ORDER BY created_at DESC
        `;

        return reply.status(200).send({
          userId,
          attestations: attestations.map((a: any) => ({
            attestationId: a.attestation_id,
            proofId: a.proof_id,
            userId: (a as any).user_id,
            issuerPublicKey: a.issuer_public_key,
            attestationHex: a.attestation_hex,
            attestationHash: a.attestation_hash,
            expiresAt: a.expires_at.toISOString(),
            createdAt: a.created_at.toISOString(),
          })),
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to retrieve attestations";
        throw new ApiError(500, "RETRIEVAL_ERROR", message);
      }
    },
  );
}
