import type { FastifyInstance } from "fastify";
import { CONTRACTS } from "@velo/shared";
import { lockEscrow } from "../lib/stellar.js";
import { generateSecretPair } from "../lib/crypto.js";
import {
  acceptQuote,
  createIntent,
  createQuote,
  getQuote,
  listActiveIntents,
} from "../lib/store-bazaar.js";
import { randomHex32 } from "../lib/crypto.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;

// NOTE: For this product slice we keep matching + persistence server-side.
// Cross-chain token routing is outside scope of #13.

export interface BazaarIntentBody {
  seller: string;
  amount_stroops: string;
  secret_hash: string;
  timeout_ledgers?: number;
  // optional override for intent expiry window (ISO string)
  expires_at?: string;
}

export interface BazaarQuoteBody {
  buyer: string;
  // Optional hint to quote a specific intent.
  intent_id?: string;
  // If intent_id isn't provided, the server chooses the best matching intent.
  // For now, "best" = highest amount_stroops.
}

export interface BazaarAcceptBody {
  quote_id: string;
}

function toBigIntString(x: string) {
  // ensure JSON-safe bigint representation
  try {
    const bi = BigInt(x);
    return bi.toString();
  } catch {
    throw new Error("amount_stroops must be a valid bigint string");
  }
}

export async function bazaarRoutes(app: FastifyInstance) {
  app.post<{ Body: BazaarIntentBody }>("/bazaar/intent", async (req, reply) => {
    const body = req.body ?? ({} as BazaarIntentBody);
    const { seller, amount_stroops, secret_hash, timeout_ledgers, expires_at } = body;

    if (!seller || !amount_stroops || !secret_hash) {
      reply.code(400).send({
        error: "seller, amount_stroops, and secret_hash are required",
      });
      return;
    }

    const amountStr = toBigIntString(amount_stroops);

    try {
      const intent = createIntent({
        seller,
        amountStroops: amountStr,
        secretHashHex: secret_hash,
        timeoutLedgers: timeout_ledgers ?? 100,
        expiresAt: expires_at,
      });
      return reply.code(201).send({
        intent_id: intent.id,
        seller: intent.seller,
        amount_stroops: intent.amountStroops,
        secret_hash: intent.secretHashHex,
        timeout_ledgers: intent.timeoutLedgers,
        created_at: intent.createdAt,
        expires_at: intent.expiresAt,
        status: intent.status,
      });
    } catch (err) {
      reply.code(502).send({ error: "failed to create intent", detail: String(err) });
    }
  });

  app.get("/bazaar/feed", async (req, reply) => {
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === "string" ? Number(limitRaw) : undefined;

    const intents = listActiveIntents({
      limit: limit && Number.isFinite(limit) ? limit : undefined,
    });

    return {
      intents: intents.map((i) => ({
        intent_id: i.id,
        seller: i.seller,
        amount_stroops: i.amountStroops,
        secret_hash: i.secretHashHex,
        timeout_ledgers: i.timeoutLedgers,
        created_at: i.createdAt,
        expires_at: i.expiresAt,
      })),
    };
  });

  app.post<{ Body: BazaarQuoteBody }>("/bazaar/quote", async (req, reply) => {
    const body = req.body ?? ({} as BazaarQuoteBody);
    const { buyer, intent_id } = body;

    if (!buyer) {
      reply.code(400).send({ error: "buyer is required" });
      return;
    }

    try {
      let chosenIntentId = intent_id;

      if (!chosenIntentId) {
        const intents = listActiveIntents({});
        if (intents.length === 0) {
          reply.code(404).send({ error: "no active intents" });
          return;
        }
        // best = highest amount_stroops
        const best = intents
          .slice()
          .sort((a, b) => {
            const ab = BigInt(a.amountStroops);
            const bb = BigInt(b.amountStroops);
            return bb > ab ? 1 : bb < ab ? -1 : 0;
          })[0];

        chosenIntentId = best.id;
      }

      const quote = createQuote({
        intentId: chosenIntentId,
        buyer,
      });

      return reply.code(201).send({
        quote_id: quote.id,
        intent_id: quote.intentId,
        buyer: quote.buyer,
        created_at: quote.createdAt,
        expires_at: quote.expiresAt,
        status: quote.status,
      });
    } catch (err) {
      reply.code(502).send({ error: "failed to create quote", detail: String(err) });
    }
  });

  app.post<{ Body: BazaarAcceptBody }>("/bazaar/accept", async (req, reply) => {
    const body = req.body ?? ({} as BazaarAcceptBody);
    const { quote_id } = body;

    if (!quote_id) {
      reply.code(400).send({ error: "quote_id is required" });
      return;
    }

    // Server-side custody for the purpose of invoking escrow lock.
    // In a future non-custodial design, the quote accept would return
    // an unsigned tx requiring user signature.
    try {
      const quote = getQuote(quote_id);
      if (!quote) {
        reply.code(404).send({ error: "quote not found" });
        return;
      }

      // Accept first (idempotency is simplified by store).
      const { intent, quote: acceptedQuote } = acceptQuote({ quoteId: quote_id });

      // lockEscrow expects secret_hash committed; escrow release later needs secret.
      // Here we assume the acceptor can provide/know the secret later on a separate flow;
      // for now, only the lock is required by acceptance criteria.
      await lockEscrow({
        contractId: ESCROW_CONTRACT_ID,
        tradeId: acceptedQuote.id,
        seller: intent.seller,
        buyer: acceptedQuote.buyer,
        amountStroops: BigInt(intent.amountStroops),
        secretHashHex: intent.secretHashHex,
        timeoutLedgers: intent.timeoutLedgers,
      });

      return reply.code(200).send({
        acceptance: {
          acceptance_id: randomHex32(),
          quote_id: acceptedQuote.id,
          intent_id: intent.id,
          seller: intent.seller,
          buyer: acceptedQuote.buyer,
          escrow_contract_id: ESCROW_CONTRACT_ID,
          trade_id: acceptedQuote.id,
        },
        status: "accepted",
      });
    } catch (err) {
      reply.code(502).send({
        error: "escrow accept failed",
        detail: String(err),
      });
    }
  });
}

