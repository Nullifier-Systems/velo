import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { randomUUID } from "crypto";
import "dotenv/config";
import { resolveLocale, t } from "./lib/i18n.js";
import { cashRoutes } from "./routes/cash.js";
import { chatRoutes } from "./routes/chat.js";
import { openapiRoutes } from "./routes/openapi.js";
import { reputationRoutes } from "./routes/reputation.js";
import { servicesRoutes } from "./routes/services.js";
import { providerRoutes } from "./routes/provider.js";
import { adminRoutes } from "./routes/admin.js";
import { statusRoutes } from "./routes/status.js";
import { disputeEvidenceRoutes } from "./routes/dispute-evidence.js";
import { server, NETWORK_PASSPHRASE } from "./lib/stellar.js";
import { TransactionBuilder, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { recordRateLimitViolation } from "./lib/rate-limit-violations.js";

const PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAYMENTS_CACHE = 10000;
const usedPayments = new Map<string, number>();

function isPaymentUsed(payment: string): boolean {
  const timestamp = usedPayments.get(payment);
  if (!timestamp) return false;
  if (Date.now() - timestamp > PAYMENT_TTL_MS) {
    usedPayments.delete(payment);
    return false;
  }
  return true;
}

function recordPaymentUsed(payment: string): void {
  const now = Date.now();
  if (usedPayments.size >= MAX_PAYMENTS_CACHE) {
    for (const [key, timestamp] of usedPayments.entries()) {
      if (now - timestamp > PAYMENT_TTL_MS) {
        usedPayments.delete(key);
      }
    }
    if (usedPayments.size >= MAX_PAYMENTS_CACHE) {
      const oldestKey = usedPayments.keys().next().value;
      if (oldestKey) usedPayments.delete(oldestKey);
    }
  }
  usedPayments.set(payment, now);
}

function isUsdcAsset(asset: any): boolean {
  if (!asset) return true;
  if (typeof asset.isNative === "function" && asset.isNative()) return false;
  if (asset.code && asset.code !== "USDC") return false;
  if (process.env.USDC_ISSUER && asset.issuer && asset.issuer !== process.env.USDC_ISSUER) {
    return false;
  }
  return true;
}

/**
 * Request ID correlation — every request gets a stable ID that Fastify
 * binds to `req.log` (as `reqId`), so every log line emitted during the
 * request carries it, including the escrow lifecycle stages logged from
 * lib/stellar.ts (simulate → sign → submit → poll).
 *
 * Inbound `x-request-id` headers are honored so retrying clients and
 * upstream proxies can supply their own ID. On Vercel we fall back to
 * `x-vercel-id` (set by Vercel's edge on every invocation), which makes
 * our `reqId` match the ID Vercel's log viewer groups function logs by.
 * Otherwise a UUID is generated. See docs/request-tracing.md.
 */
const REQUEST_ID_MAX_LENGTH = 128;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const app = Fastify({
  logger: true,
  genReqId: (req) => {
    const inbound =
      firstHeaderValue(req.headers["x-request-id"]) ??
      firstHeaderValue(req.headers["x-vercel-id"]);
    // Reject oversized inbound IDs so a hostile header can't bloat every
    // log line for the request.
    if (inbound && inbound.length > 0 && inbound.length <= REQUEST_ID_MAX_LENGTH) {
      return inbound;
    }
    return randomUUID();
  },
});

// Echo the request ID back to the client so a failed call can be traced
// in the logs — see docs/request-tracing.md.
app.addHook("onRequest", async (req, reply) => {
  reply.header("x-request-id", req.id);
});

/**
 * Locale detection — resolve the best supported locale from the
 * Accept-Language header and attach it to the request for downstream
 * handlers. Falls back to "en" when no supported locale matches.
 */
app.decorateRequest("locale", "");
app.addHook("onRequest", async (req) => {
  const raw = req.headers["accept-language"];
  const locale = resolveLocale(
    Array.isArray(raw) ? raw[0] : raw
  );
  (req as any).locale = locale;
});

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
 * Rate limiting — IP-based soft limits applied to all routes.
 *
 * Global rate limit:           100 req/min
 * ------------------------------+-----------------
 *   GET /health                 | 100 req/min     (infrastructure health check, free)
 *   GET /api/v1/openapi.json    |  60 req/min     (OpenAPI spec, free)
 *   GET /api/v1/services        |  60 req/min     (catalog endpoint, free)
 *   GET /api/v1/cash/agents     |  30 req/min     (paid — agent discovery)
 *   POST /api/v1/cash/request   |  20 req/min     (paid — escrow lock, costly)
 *   GET /api/v1/cash/request/:id|  60 req/min     (free — polling)
 *   POST /api/v1/cash/request/:id/release | 20 req/min (free — state transition)
 *   GET /api/v1/reputation/:addr|  30 req/min     (paid — on-chain reputation)
 *   GET /api/v1/status           |  60 req/min     (public transparency page data, free)
 *   /api/v1/admin/*              |  n/a            (internal, behind ADMIN_API_KEY)
 *
 * Responses exceeding the limit get a 429 + Retry-After header.
 *
 * @fastify/rate-limit uses the requesting IP as the key by default
 * (trust proxy is enabled but default 0 hops — adjust via
 * FASTIFY_TRUST_PROXY when deployed behind a reverse proxy).
 */
app.register(websocket);

app.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: "1 minute",
  onExceeded: (request, identifier) => {
    recordRateLimitViolation(
      {
        identifier,
        route: request.routeOptions.url ?? request.url.split("?", 1)[0],
        method: request.method,
      },
      (app as any).pg,
    );
  },
  errorResponseBuilder: (request, context) => {
    const locale = (request as any).locale ?? "en";
    return {
      statusCode: 429,
      error: t(locale, "errors.tooManyRequests"),
      message: t(locale, "errors.rateLimited", { after: context.after }),
      retryAfter: context.after,
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    };
  },
});

/**
 * x402 gate — every paid route calls this. If no valid X-Payment header
 * is present, respond 402 with a challenge describing what to pay and
 * where. This is the entire "auth" system: payment IS authentication,
 * there are no API keys or accounts.
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

  if (isPaymentUsed(payment)) {
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
    const hasPayment = tx.operations.some(op => {
        if (op.type === "payment") {
            const dest = (op as any).destination;
            const amt = (op as any).amount;
            const asset = (op as any).asset;
            return dest === merchantAddress && isUsdcAsset(asset) && parseFloat(amt) >= parseFloat(priceUsdc);
        } else if (op.type === "pathPaymentStrictReceive" || op.type === "pathPaymentStrictSend") {
            const dest = (op as any).destination;
            const amt = (op as any).destAmount ?? (op as any).amount;
            const asset = (op as any).destAsset ?? (op as any).asset;
            return dest === merchantAddress && isUsdcAsset(asset) && parseFloat(amt) >= parseFloat(priceUsdc);
        }
        return false;
    });

    if (!hasPayment) {
        reply.code(402).send({ error: "Transaction does not contain a valid payment" });
        return false;
    }

    recordPaymentUsed(payment);
    return true;
  } catch (err) {
    req.log.error(err, "payment verification failed");
    reply.code(402).send({ error: "Invalid payment transaction" });
    return false;
  }
});

app.get(
  "/health",
  {
    config: {
      rateLimit: { max: 100, timeWindow: "1 minute" },
    },
  },
  async () => ({ ok: true })
);

app.get(
  "/version",
  {
    config: {
      rateLimit: { max: 100, timeWindow: "1 minute" },
    },
  },
  async () => ({
    commit: process.env.VERCEL_GIT_COMMIT_SHA || "unknown",
    timestamp: process.env.DEPLOY_TIMESTAMP || "unknown",
  })
);

app.register(openapiRoutes, { prefix: "/api/v1" });
app.register(servicesRoutes, { prefix: "/api/v1" });
app.register(cashRoutes, { prefix: "/api/v1" });
app.register(disputeEvidenceRoutes, { prefix: "/api/v1" });
app.register(chatRoutes, { prefix: "/api/v1" });
app.register(reputationRoutes, { prefix: "/api/v1" });
app.register(providerRoutes, { prefix: "/api/v1" });
app.register(adminRoutes, { prefix: "/api/v1" });
app.register(statusRoutes, { prefix: "/api/v1" });
