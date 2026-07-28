// @ts-nocheck
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  initializeSessionAccount,
  createSessionKey,
  revokeSessionKey,
  updateSpendingCap,
  getSessionKeyInfo,
  getSessionKeySpent,
  buildInitializeSessionAccountTx,
  buildCreateSessionKeyTx,
  buildRevokeSessionKeyTx,
  buildUpdateSpendingCapTx,
  submitSignedTransaction,
} from "../lib/stellar.js";

const SESSION_ACCOUNT_CONTRACT_ID = process.env.SESSION_ACCOUNT_CONTRACT_ID || "";

// Schemas
const initializeSchema = z.object({
  main_account: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  mode: z.enum(["custodial", "non_custodial"]).optional(),
  signer_public_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/).optional(),
});

const createSessionKeySchema = z.object({
  session_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  spending_cap: z.string().trim().min(1).regex(/^\d+$/),
  duration_days: z.number().int().min(1).max(30),
  start_delay_days: z.number().int().min(0).max(30),
  mode: z.enum(["custodial", "non_custodial"]).optional(),
  signer_public_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/).optional(),
});

const revokeSessionKeySchema = z.object({
  session_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  mode: z.enum(["custodial", "non_custodial"]).optional(),
  signer_public_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/).optional(),
});

const updateSpendingCapSchema = z.object({
  session_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  new_spending_cap: z.string().trim().min(1).regex(/^\d+$/),
  mode: z.enum(["custodial", "non_custodial"]).optional(),
  signer_public_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/).optional(),
});

const getSessionKeySchema = z.object({
  session_key: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
});

export async function sessionRoutes(app: FastifyInstance) {
  // Initialize session account contract
  app.post<{ Body: z.infer<typeof initializeSchema> }>("/session/initialize", async (req, reply) => {
    if (!SESSION_ACCOUNT_CONTRACT_ID) {
      reply.code(500).send({ error: "SESSION_ACCOUNT_CONTRACT_ID not configured" });
      return;
    }

    const { main_account, mode, signer_public_key } = req.body || ({} as z.infer<typeof initializeSchema>);

    try {
      if (mode === "non_custodial" && signer_public_key) {
        // Non-custodial: return unsigned XDR
        const unsignedXdr = await buildInitializeSessionAccountTx({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          mainAccount: main_account,
          signerPublicKey: signer_public_key,
        });
        reply.code(200).send({
          unsigned_xdr: unsignedXdr,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          instructions: "Sign this transaction with your main account to initialize the session account.",
        });
      } else {
        // Custodial: sign and submit (testnet only)
        const result = await initializeSessionAccount({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          mainAccount: main_account,
        });
        reply.code(200).send({
          hash: result.hash,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          message: "Session account initialized successfully.",
        });
      }
    } catch (err) {
      req.log.error(err, "initialize session account failed");
      reply.code(502).send({
        error: "initialization failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  // Create a new session key
  app.post<{ Body: z.infer<typeof createSessionKeySchema> }>("/session/keys", async (req, reply) => {
    if (!SESSION_ACCOUNT_CONTRACT_ID) {
      reply.code(500).send({ error: "SESSION_ACCOUNT_CONTRACT_ID not configured" });
      return;
    }

    const { session_key, spending_cap, duration_days, start_delay_days, mode, signer_public_key } = req.body || ({} as z.infer<typeof createSessionKeySchema>);

    try {
      if (mode === "non_custodial" && signer_public_key) {
        // Non-custodial: return unsigned XDR
        const unsignedXdr = await buildCreateSessionKeyTx({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
          spendingCap: BigInt(spending_cap),
          durationDays: duration_days,
          startDelayDays: start_delay_days,
          signerPublicKey: signer_public_key,
        });
        reply.code(200).send({
          unsigned_xdr: unsignedXdr,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          instructions: "Sign this transaction with your main account to create the session key.",
        });
      } else {
        // Custodial: sign and submit (testnet only)
        const result = await createSessionKey({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
          spendingCap: BigInt(spending_cap),
          durationDays: duration_days,
          startDelayDays: start_delay_days,
        });
        reply.code(200).send({
          hash: result.hash,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          message: "Session key created successfully.",
        });
      }
    } catch (err) {
      req.log.error(err, "create session key failed");
      reply.code(502).send({
        error: "session key creation failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  // Revoke a session key
  app.post<{ Body: z.infer<typeof revokeSessionKeySchema> }>("/session/keys/revoke", async (req, reply) => {
    if (!SESSION_ACCOUNT_CONTRACT_ID) {
      reply.code(500).send({ error: "SESSION_ACCOUNT_CONTRACT_ID not configured" });
      return;
    }

    const { session_key, mode, signer_public_key } = req.body || ({} as z.infer<typeof revokeSessionKeySchema>);

    try {
      if (mode === "non_custodial" && signer_public_key) {
        // Non-custodial: return unsigned XDR
        const unsignedXdr = await buildRevokeSessionKeyTx({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
          signerPublicKey: signer_public_key,
        });
        reply.code(200).send({
          unsigned_xdr: unsignedXdr,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          instructions: "Sign this transaction with your main account to revoke the session key.",
        });
      } else {
        // Custodial: sign and submit (testnet only)
        const result = await revokeSessionKey({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
        });
        reply.code(200).send({
          hash: result.hash,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          message: "Session key revoked successfully.",
        });
      }
    } catch (err) {
      req.log.error(err, "revoke session key failed");
      reply.code(502).send({
        error: "session key revocation failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  // Update session key spending cap
  app.post<{ Body: z.infer<typeof updateSpendingCapSchema> }>("/session/keys/update-cap", async (req, reply) => {
    if (!SESSION_ACCOUNT_CONTRACT_ID) {
      reply.code(500).send({ error: "SESSION_ACCOUNT_CONTRACT_ID not configured" });
      return;
    }

    const { session_key, new_spending_cap, mode, signer_public_key } = req.body || ({} as z.infer<typeof updateSpendingCapSchema>);

    try {
      if (mode === "non_custodial" && signer_public_key) {
        // Non-custodial: return unsigned XDR
        const unsignedXdr = await buildUpdateSpendingCapTx({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
          newSpendingCap: BigInt(new_spending_cap),
          signerPublicKey: signer_public_key,
        });
        reply.code(200).send({
          unsigned_xdr: unsignedXdr,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          instructions: "Sign this transaction with your main account to update the spending cap.",
        });
      } else {
        // Custodial: sign and submit (testnet only)
        const result = await updateSpendingCap({
          contractId: SESSION_ACCOUNT_CONTRACT_ID,
          sessionKey: session_key,
          newSpendingCap: BigInt(new_spending_cap),
        });
        reply.code(200).send({
          hash: result.hash,
          contract_id: SESSION_ACCOUNT_CONTRACT_ID,
          message: "Spending cap updated successfully.",
        });
      }
    } catch (err) {
      req.log.error(err, "update spending cap failed");
      reply.code(502).send({
        error: "spending cap update failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  // Get session key information
  app.get<{ Params: { session_key: string } }>("/session/keys/:session_key", async (req, reply) => {
    if (!SESSION_ACCOUNT_CONTRACT_ID) {
      reply.code(500).send({ error: "SESSION_ACCOUNT_CONTRACT_ID not configured" });
      return;
    }

    const { session_key } = req.params as { session_key: string };

    try {
      const info = await getSessionKeyInfo(SESSION_ACCOUNT_CONTRACT_ID, session_key);
      const spent = await getSessionKeySpent(SESSION_ACCOUNT_CONTRACT_ID, session_key);
      reply.code(200).send({
        session_key,
        info,
        spent: spent.toString(),
      });
    } catch (err) {
      req.log.error(err, "get session key info failed");
      reply.code(502).send({
        error: "failed to retrieve session key info",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });

  // Submit a signed transaction (for non-custodial flow)
  app.post("/session/submit", async (req, reply) => {
    const { signed_xdr } = req.body as { signed_xdr?: string };

    if (!signed_xdr) {
      reply.code(400).send({ error: "signed_xdr is required" });
      return;
    }

    try {
      const result = await submitSignedTransaction(signed_xdr);
      reply.code(200).send({
        hash: result.hash,
        status: result.status,
        message: "Transaction submitted successfully.",
      });
    } catch (err) {
      req.log.error(err, "submit signed transaction failed");
      reply.code(502).send({
        error: "transaction submission failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });
}
