import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";
import { createClient, type RedisClientType } from "redis";
import { SESSION_ROTATION_QUEUE } from "@velo/shared";
import { ApiError, ErrorCode } from "../lib/errors.js";
import {
  REQUIRED_ROTATION_SIGNATURES,
  createSessionKeyRegistryStore,
  type SessionKeyRegistryStore,
} from "../lib/session-registry-store.js";
import { approveRotation, proposeRotation } from "../lib/stellar.js";

/**
 * Session-key multi-sig emergency rotation (#375).
 *
 * POST /session/rotate-key         — 1st admin signature; locks the registry
 *                                    row, flips it to ROTATING and opens a
 *                                    proposal (2-of-3 threshold).
 * POST /session/rotate-key/approve — 2nd (distinct) admin signature; drives
 *                                    propose_rotation + approve_rotation on
 *                                    contracts/session-account.
 *
 * Admins sign the utf8 payload `rotate:<oldPubkey>:<newPubkey>` with the
 * ed25519 key listed in SESSION_ROTATION_ADMIN_KEYS.
 */

const STELLAR_PUBLIC_KEY = /^G[1-9A-HJ-NP-Za-km-z]{55}$/;

const stellarPublicKey = z
  .string()
  .trim()
  .regex(STELLAR_PUBLIC_KEY, "Invalid Stellar public key address");

const signature = z
  .string()
  .trim()
  .min(64)
  .regex(/^[0-9a-fA-F]+$/, "Signature must be hex encoded");

export const RotateKeySchema = z.object({
  oldSessionPubkey: stellarPublicKey,
  newSessionPubkey: stellarPublicKey,
  signerPublicKey: stellarPublicKey,
  signature,
});

export const ApproveRotationSchema = z.object({
  proposalId: z.string().uuid("Invalid proposal id"),
  signerPublicKey: stellarPublicKey,
  signature,
});

export type RotateKeyBody = z.infer<typeof RotateKeySchema>;
export type ApproveRotationBody = z.infer<typeof ApproveRotationSchema>;

export interface SessionRotationQueueMessage {
  proposalId: string;
  oldSessionPubkey: string;
  newSessionPubkey: string;
}

export interface SessionRotationRoutesOptions {
  store?: SessionKeyRegistryStore;
  /** Overridable in tests — hands the proposal to the rotation worker. */
  enqueue?: (message: SessionRotationQueueMessage) => Promise<void>;
}

/** Comma-separated admin key set; read per request so ops can rotate it. */
function rotationAdminKeys(): string[] {
  return (process.env.SESSION_ROTATION_ADMIN_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function rotationPayload(oldPubkey: string, newPubkey: string): string {
  return `rotate:${oldPubkey}:${newPubkey}`;
}

function verifyAdminSignature(
  signerPublicKey: string,
  signatureHex: string,
  payload: string,
): boolean {
  if (!rotationAdminKeys().includes(signerPublicKey)) return false;
  try {
    return Keypair.fromPublicKey(signerPublicKey).verify(
      Buffer.from(payload, "utf8"),
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

function invalidSignature(): ApiError {
  return new ApiError(
    401,
    ErrorCode.INVALID_MULTISIG_SIGNATURE,
    "Signature verification failed against admin threshold key set.",
  );
}

function sessionAccountContractId(): string {
  const contractId = process.env.SESSION_ACCOUNT_CONTRACT_ID ?? "";
  if (!contractId) {
    throw new ApiError(
      503,
      ErrorCode.CONFIG_ERROR,
      "SESSION_ACCOUNT_CONTRACT_ID is not configured.",
    );
  }
  return contractId;
}

let queueClient: RedisClientType | undefined;

/** Publishes onto the rotation stream; a no-op when redis is not configured. */
async function enqueueToRedis(message: SessionRotationQueueMessage): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  if (!queueClient) {
    queueClient = createClient({ url }) as RedisClientType;
    queueClient.on("error", (error) => console.error("Redis rotation queue error", error));
    await queueClient.connect();
  }
  await queueClient.xAdd(SESSION_ROTATION_QUEUE, "*", {
    proposalId: message.proposalId,
    oldSessionPubkey: message.oldSessionPubkey,
    newSessionPubkey: message.newSessionPubkey,
  });
}

export async function sessionRotationRoutes(
  app: FastifyInstance,
  opts: SessionRotationRoutesOptions = {},
) {
  const store = opts.store ?? createSessionKeyRegistryStore((app as any).pg);
  const enqueue = opts.enqueue ?? enqueueToRedis;

  app.post<{ Body: RotateKeyBody }>("/session/rotate-key", async (req, reply) => {
    const parsed = RotateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, ErrorCode.VALIDATION_ERROR, "Request validation failed", {
        detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    const { oldSessionPubkey, newSessionPubkey, signerPublicKey } = parsed.data;

    if (
      !verifyAdminSignature(
        signerPublicKey,
        parsed.data.signature,
        rotationPayload(oldSessionPubkey, newSessionPubkey),
      )
    ) {
      throw invalidSignature();
    }

    // Row lock: verify ACTIVE, flip to ROTATING and open the proposal inside
    // the same critical section so no spend can slip past the rotation.
    const outcome = await store.beginRotation(oldSessionPubkey, (tx) =>
      tx.createProposal({
        oldPubkey: oldSessionPubkey,
        newPubkey: newSessionPubkey,
        signer1: signerPublicKey,
      }),
    );

    if (!outcome.ok) {
      if (outcome.reason === "NOT_FOUND") {
        throw new ApiError(404, ErrorCode.NOT_FOUND, "Session key is not registered.");
      }
      throw new ApiError(
        409,
        ErrorCode.KEY_ALREADY_INACTIVE,
        "Target session key is already revoked or undergoing rotation.",
      );
    }

    const proposal = outcome.value;
    try {
      await enqueue({
        proposalId: proposal.proposalId,
        oldSessionPubkey,
        newSessionPubkey,
      });
    } catch (error) {
      // The proposal is already durable; the worker also recovers from the
      // second signature, so a queue outage must not fail the rotation.
      req.log.error(error, "session rotation enqueue failed");
    }

    return reply.status(202).send({
      proposal_id: proposal.proposalId,
      status: "ROTATING",
      signatures_collected: proposal.signaturesCollected,
      required_signatures: proposal.requiredSignatures,
    });
  });

  app.post<{ Body: ApproveRotationBody }>(
    "/session/rotate-key/approve",
    async (req, reply) => {
      const parsed = ApproveRotationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, ErrorCode.VALIDATION_ERROR, "Request validation failed", {
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
      const { proposalId, signerPublicKey } = parsed.data;

      const proposal = await store.getProposal(proposalId);
      if (!proposal) {
        throw new ApiError(404, ErrorCode.NOT_FOUND, "Rotation proposal not found.");
      }
      if (proposal.executed || proposal.signaturesCollected >= REQUIRED_ROTATION_SIGNATURES) {
        throw new ApiError(
          409,
          ErrorCode.STATE_ALREADY_SET,
          "Rotation proposal already collected the required signatures.",
        );
      }

      // The threshold only counts DISTINCT admins.
      if (
        signerPublicKey === proposal.signer1 ||
        !verifyAdminSignature(
          signerPublicKey,
          parsed.data.signature,
          rotationPayload(proposal.oldPubkey, proposal.newPubkey),
        )
      ) {
        throw invalidSignature();
      }

      const contractId = sessionAccountContractId();
      const signed = await store.addSecondSignature(proposalId, signerPublicKey);
      if (!signed) {
        throw new ApiError(
          409,
          ErrorCode.STATE_ALREADY_SET,
          "Rotation proposal already collected the required signatures.",
        );
      }

      // Custodial testnet path, same as the other /session routes.
      let onchainProposalId: bigint;
      try {
        onchainProposalId = await proposeRotation({
          contractId,
          proposer: proposal.signer1,
          oldKey: proposal.oldPubkey,
          newKey: proposal.newPubkey,
        });
        await approveRotation({
          contractId,
          approver: signerPublicKey,
          proposalId: onchainProposalId,
        });
      } catch (error) {
        req.log.error(error, "session key rotation approval failed");
        throw new ApiError(502, ErrorCode.TX_SUBMIT_FAILED, "Session key rotation failed on-chain", {
          detail: String(error),
        });
      }

      return reply.status(202).send({
        proposal_id: signed.proposalId,
        status: "ROTATING",
        signatures_collected: signed.signaturesCollected,
        required_signatures: signed.requiredSignatures,
        onchain_proposal_id: onchainProposalId.toString(),
      });
    },
  );
}
