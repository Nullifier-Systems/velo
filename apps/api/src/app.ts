 import Fastify from "fastify";
import cors from "@fastify/cors";
import "dotenv/config";
import { cashRoutes } from "./routes/cash.js";
import { reputationRoutes } from "./routes/reputation.js";
import { servicesRoutes } from "./routes/services.js";
import { server, NETWORK_PASSPHRASE } from "./lib/stellar.js";
import { TransactionBuilder, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";

const usedPayments = new Set<string>();

export const app = Fastify({ logger: true });

// Allow the mobile frontend (and other trusted origins) to call this API
// from the browser. Locked to specific origins rather than "*" since
// this API also handles authenticated/paid requests later.
app.register(cors, {
  origin: [
    "http://localhost:5181",
    process.env.FRONTEND_BASE_URL ?? "http://localhost:5181",
  ],
});

/**
 * x402 gate — every paid route calls this. If no valid X-Payment header
 * is present, respond 402 with a challenge describing what to pay and
 * where. This is the entire "auth" system: payment IS authentication,
 * there are no API keys or accounts.
 *
 * TODO: replace the stub check with real Stellar tx verification
 * (submitted, correct amount, correct destination, memo matches, not
 * already used — track spent tx hashes to prevent replay).
 */
app.decorate("requirePayment", async (req: any, reply: any, priceUsdc: string) => {
  const payment = req.headers["x-payment"];
  const merchantAddress = process.env.MERCHANT_ADDRESS ?? "G...SET_ME";
  if (!payment || typeof payment !== "string") {
    reply.code(402).send({
      challenge: {
        amount_usdc: priceUsdc,
        pay_to: merchantAddress,
        memo: "velo:request",
      },
    });
    return false;
  }

  if (usedPayments.has(payment)) {
    reply.code(402).send({ error: "Payment already used" });
    return false;
  }

  try {
    const txResponse = await server.getTransaction(payment);
    if (txResponse.status !== "SUCCESS") {
      reply.code(402).send({ error: "Payment transaction not successful" });
      return false;
    }

    const parsedTx = TransactionBuilder.fromXDR(txResponse.envelopeXdr, NETWORK_PASSPHRASE);
    const tx = "innerTransaction" in parsedTx ? (parsedTx as FeeBumpTransaction).innerTransaction : (parsedTx as Transaction);
    
    // Check memo
    if (tx.memo.value?.toString() !== "velo:request") {
        reply.code(402).send({ error: "Invalid payment memo" });
        return false;
    }

    // Check operation
    // For simplicity, assuming a standard native payment or path payment operation.
    // In production, you would check the exact asset matches USDC, and destination matches merchantAddress.
    const hasPayment = tx.operations.some(op => {
        if (op.type === "payment" || op.type === "pathPaymentStrictReceive" || op.type === "pathPaymentStrictSend") {
            const dest = (op as any).destination;
            const amt = (op as any).amount;
            // A production app must also check (op as any).asset is USDC!
            return dest === merchantAddress && parseFloat(amt) >= parseFloat(priceUsdc);
        }
        return false;
    });

    if (!hasPayment) {
        reply.code(402).send({ error: "Transaction does not contain a valid payment" });
        return false;
    }

    usedPayments.add(payment);
    return true;
  } catch (err) {
    req.log.error(err, "payment verification failed");
    reply.code(402).send({ error: "Invalid payment transaction" });
    return false;
  }
});

app.get("/health", async () => ({ ok: true }));

app.register(servicesRoutes, { prefix: "/api/v1" });
app.register(cashRoutes, { prefix: "/api/v1" });
app.register(reputationRoutes, { prefix: "/api/v1" });