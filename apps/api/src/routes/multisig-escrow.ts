/**
 * Multi-Sig Escrow Threshold Release & Key Recovery Protocol (issue #433).
 *
 * A trade's buyer and seller can jointly register a 2-of-N recovery
 * signer set on-chain (`register_trade_signers`, see
 * lib/stellar.ts#buildRegisterTradeSignersTransaction) — typically
 * `[buyer_key, seller_key, backup_key]` with `threshold = 2`. Once that
 * exists, this route lets those signers approve a release asynchronously
 * (each signs the same off-chain payload independently, on their own
 * schedule) instead of requiring the buyer's HTLC secret. This is the
 * institutional-cash / lost-secret recovery path: no single key can move
 * funds, and a buyer who lost their secret is not permanently stuck.
 *
 * GET  /cash/multisig-release/:tradeId          — pinned payload + progress
 * POST /cash/multisig-release/approve           — submit one signer's approval
 *
 * Concurrency: two signers approving at nearly the same time must trigger
 * `release_escrow` exactly once — enforced by `MultisigEscrowStore`'s
 * `SELECT ... FOR UPDATE` claim (tests/concurrency/multisig_release_stress.test.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTRACTS } from "@velo/shared";
import { parseBody } from "../lib/validation.js";
import { ApiError, ErrorCode } from "../lib/errors.js";
import { getCashRequest, updateStatus } from "../lib/store.js";
import {
  MultisigEscrowStore,
  MultisigReleaseNotFoundError,
} from "../lib/multisigEscrowStore.js";
import {
  ed25519PublicKeyHexFromAddress,
  getTradeSignersOnChain,
  submitThresholdRelease,
  verifyTradeSignerSignature,
} from "../lib/stellar.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;

const approveSchema = z.object({
  trade_id: z.string().min(1).max(64),
  signer_address: z.string().length(56).startsWith("G"),
  signature: z
    .string()
    .length(128)
    .regex(/^[0-9a-fA-F]+$/, "signature must be hex-encoded"),
});

export interface MultisigEscrowRouteOptions {
  store?: MultisigEscrowStore;
}

export async function multisigEscrowRoutes(
  app: FastifyInstance,
  opts: MultisigEscrowRouteOptions = {},
) {
  const store = opts.store ?? new MultisigEscrowStore();

  /**
   * Fetches (creating if needed) the trade's pinned release payload, and
   * reports how many of the registered signers have approved so far —
   * backs the "1 of 2 Signatures Collected" progress UI.
   */
  app.get<{ Params: { tradeId: string } }>(
    "/cash/multisig-release/:tradeId",
    async (req, reply) => {
      const { tradeId } = req.params;
      const cashRequest = getCashRequest(tradeId);
      if (!cashRequest) {
        throw new ApiError(404, ErrorCode.TRADE_NOT_FOUND, "Trade request not found");
      }
      if (cashRequest.status !== "locked") {
        throw new ApiError(
          409,
          ErrorCode.WRONG_STATUS,
          `Trade is not releasable (current status: ${cashRequest.status})`,
        );
      }

      const contractId = cashRequest.contractId || ESCROW_CONTRACT_ID;
      const signerSet = await getTradeSignersOnChain(contractId, tradeId);
      if (!signerSet) {
        throw new ApiError(
          409,
          ErrorCode.TRADE_SIGNERS_NOT_CONFIGURED,
          "This trade has no registered recovery/threshold signer set. Call register_trade_signers first.",
        );
      }

      const release = await store.getOrCreateRelease({
        tradeId,
        recipientAddress: cashRequest.seller,
        releaseAmountStroops: cashRequest.amountStroops,
        threshold: signerSet.threshold,
      });
      const approvals = await store.listApprovals(tradeId);

      return reply.code(200).send({
        trade_id: tradeId,
        recipient_address: release.recipientAddress,
        release_amount_stroops: release.releaseAmountStroops,
        nonce: release.nonce,
        threshold: release.threshold,
        registered_signers: signerSet.keys.length,
        status: release.status,
        release_tx_hash: release.releaseTxHash,
        approvals_collected: approvals.length,
        approved_by: approvals.map((a) => a.signerAddress),
      });
    },
  );

  app.post<{ Body: z.infer<typeof approveSchema> }>(
    "/cash/multisig-release/approve",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parseBody(approveSchema, req.body, reply);
      if (!body) return;
      const tradeId = body.trade_id;

      const cashRequest = getCashRequest(tradeId);
      if (!cashRequest) {
        throw new ApiError(404, ErrorCode.TRADE_NOT_FOUND, "Trade request not found");
      }
      if (cashRequest.status !== "locked") {
        throw new ApiError(
          409,
          ErrorCode.WRONG_STATUS,
          `Trade is not releasable (current status: ${cashRequest.status})`,
        );
      }

      const contractId = cashRequest.contractId || ESCROW_CONTRACT_ID;
      const signerSet = await getTradeSignersOnChain(contractId, tradeId);
      if (!signerSet) {
        throw new ApiError(
          409,
          ErrorCode.TRADE_SIGNERS_NOT_CONFIGURED,
          "This trade has no registered recovery/threshold signer set. Call register_trade_signers first.",
        );
      }

      // Contributor note on #433: ALWAYS verify a candidate signature
      // corresponds to a registered threshold signer before recording it.
      // Two checks, both mandatory: (1) the address derives to a pubkey
      // that is actually on the trade's registered signer list, (2) the
      // signature verifies against that pubkey over the exact pinned
      // payload — never trust either alone.
      const signerPubkeyHex = ed25519PublicKeyHexFromAddress(body.signer_address);
      if (!signerSet.keys.includes(signerPubkeyHex)) {
        throw new ApiError(
          403,
          ErrorCode.NOT_A_REGISTERED_SIGNER,
          "This address is not a registered threshold signer for this trade",
        );
      }

      const release = await store.getOrCreateRelease({
        tradeId,
        recipientAddress: cashRequest.seller,
        releaseAmountStroops: cashRequest.amountStroops,
        threshold: signerSet.threshold,
      });

      const validSignature = verifyTradeSignerSignature({
        tradeId,
        releaseAmountStroops: release.releaseAmountStroops,
        recipientAddress: release.recipientAddress,
        nonce: release.nonce,
        signerPublicKeyHex: signerPubkeyHex,
        signatureHex: body.signature,
      });
      if (!validSignature) {
        throw new ApiError(
          401,
          ErrorCode.INVALID_MULTISIG_SIGNATURE,
          "Signature does not verify against the pinned release payload",
        );
      }

      let outcome;
      try {
        outcome = await store.addApproval({
          tradeId,
          signerAddress: body.signer_address,
          signerPubkeyHex,
          signature: body.signature,
        });
      } catch (error) {
        if (error instanceof MultisigReleaseNotFoundError) {
          throw new ApiError(404, ErrorCode.TRADE_NOT_FOUND, error.message);
        }
        throw error;
      }

      if (!outcome.claimedForSubmission) {
        return reply.code(200).send({
          released: false,
          trade_id: tradeId,
          approvals_collected: outcome.approvals.length,
          threshold: outcome.release.threshold,
          approved_by: outcome.approvals.map((a) => a.signerAddress),
        });
      }

      // This request is the one that met threshold — submit on-chain.
      try {
        const { hash } = await submitThresholdRelease({
          contractId,
          tradeId,
          releaseAmountStroops: release.releaseAmountStroops,
          recipientAddress: release.recipientAddress,
          nonce: release.nonce,
          signatures: outcome.approvals.map((a) => ({
            signerPublicKeyHex: a.signerPubkeyHex,
            signatureHex: a.signature,
          })),
        });
        await store.markReleased(tradeId, hash);
        updateStatus(tradeId, "released");

        return reply.code(200).send({
          released: true,
          trade_id: tradeId,
          tx_hash: hash,
          approvals_collected: outcome.approvals.length,
          threshold: outcome.release.threshold,
          approved_by: outcome.approvals.map((a) => a.signerAddress),
        });
      } catch (error) {
        req.log.error(error, "threshold release submission failed");
        await store.markFailed(tradeId);
        throw new ApiError(
          502,
          ErrorCode.ESCROW_RELEASE_FAILED,
          "Threshold met but the on-chain release transaction failed; approvals were kept and the release can be retried",
          { retryable: true },
        );
      }
    },
  );
}
