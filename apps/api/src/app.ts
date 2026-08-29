import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "crypto";
import "dotenv/config";
import { ApiError } from "./lib/errors.js";
import { resolveLocale, t } from "./lib/i18n.js";
import { cashRoutes } from "./routes/cash.js";
import { chatRoutes } from "./routes/chat.js";
import { e2eeKeysRoutes } from "./routes/e2ee-keys.js";
import { openapiRoutes } from "./routes/openapi.js";
import { openApiDocument } from "./openapi.js";
import { reputationRoutes } from "./routes/reputation.js";
import { servicesRoutes } from "./routes/services.js";
import { providerRoutes } from "./routes/provider.js";
import { adminRoutes } from "./routes/admin.js";
import { sessionRoutes } from "./routes/session.js";
import { sessionRotationRoutes } from "./routes/session-rotation.js";
import { ratesRoutes } from "./routes/rates.js";
import { statusRoutes } from "./routes/status.js";
import { disputeEvidenceRoutes } from "./routes/dispute-evidence.js";
import { server, NETWORK_PASSPHRASE } from "./lib/stellar.js";
import {
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { recordRateLimitViolation } from "./lib/rate-limit-violations.js";
import { Pool } from "pg";
import { PostgresEventStore } from "./lib/stellar-event-store.js";
import { graphqlRoutes } from "./routes/graphql.js";
import { circuitBreakerRoutes } from "./routes/circuit-breaker.js";
import { batchAuctionRoutes } from "./routes/batch-auctions.js";
import { zkSettleRoutes } from "./routes/zk-settle.js";
import { enterpriseOrgsRoutes } from "./routes/enterprise-orgs.js";
import { enterprisePoliciesRoutes } from "./routes/enterprise-policies.js";
import { enterpriseApprovalsRoutes } from "./routes/enterprise-approvals.js";
import { stateChannelRoutes } from "./routes/state-channels.js";
import { spatialHotspotsRoutes } from "./routes/spatial-hotspots.js";
import { globalSpatialMetricsWorker } from "./lib/workers/spatialMetricsWorker.js";
import { collateralRoutes } from "./routes/collateral.js";
import { CollateralGuardStore } from "./lib/collateralGuard.js";
import { multisigEscrowRoutes } from "./routes/multisig-escrow.js";
import { MultisigEscrowStore } from "./lib/multisigEscrowStore.js";
import { juryArbitrationRoutes } from "./routes/jury-arbitration.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { WebhookStore } from "./lib/webhook-store.js";


const MAX_PAYMENTS_CACHE = 10000;
const usedPayments = new Map<string, number>();

function isPaymentUsed(payment: string): boolean {
  return usedPayments.has(payment);
}

function recordPaymentUsed(payment: string): void {
  const now = Date.now();
  if (usedPayments.size >= MAX_PAYMENTS_CACHE) {
    const oldestKey = usedPayments.keys().next().value;
    if (oldestKey) usedPayments.delete(oldestKey);
  }
  usedPayments.set(payment, now);
}

function isUsdcAsset(asset: any): boolean {
  if (!asset) return true;
  if (typeof asset.isNative === "function" && asset.isNative()) return false;
  if (asset.code && asset.code !== "USDC") return false;
  if (
    process.env.USDC_ISSUER &&
    asset.issuer &&
    asset.issuer !== process.env.USDC_ISSUER
  ) {
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

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
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
    if (
      inbound &&
      inbound.length > 0 &&
      inbound.length <= REQUEST_ID_MAX_LENGTH
    ) {
      return inbound;
    }
    return randomUUID();
  },
});

export const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;
export const stellarEventStore = pgPool
  ? new PostgresEventStore(pgPool)
  : undefined;
if (pgPool) app.decorate("pg", pgPool);

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
  const locale = resolveLocale(Array.isArray(raw) ? raw[0] : raw);
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
 *   GET /documentation           | 100 req/min     (interactive Swagger UI, global default, free)
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

/**
 * Interactive API documentation (GET /documentation).
 *
 * `src/openapi.ts` is already the single hand-maintained source of truth
 * for the spec (served raw at GET /api/v1/openapi.json and snapshotted to
 * apps/api/openapi.json — see routes/openapi.ts and
 * scripts/generate-openapi.ts). Rather than have @fastify/swagger try to
 * derive a second, competing spec by introspecting per-route schemas
 * (which this codebase doesn't attach route-by-route), it's registered in
 * "static" mode pointed at that same document, so there is exactly one
 * spec and the interactive UI can never drift from it.
 */
app.register(swagger, {
  mode: "static",
  specification: {
    // openApiDocument is declared `as const` (see openapi.ts) so every
    // literal/enum value in it is exactly typed within this codebase. That
    // makes its arrays/tuples `readonly`, which structurally conflicts with
    // @fastify/swagger's own OpenAPI type definitions (which want mutable
    // arrays like ServerObject[]) even though the actual shape is a valid
    // OpenAPI 3.1 document. The cast only affects what TypeScript sees at
    // this registration call; the object handed to swagger-ui at runtime
    // is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    document: openApiDocument as any,
  },
});

app.register(swaggerUi, {
  routePrefix: "/documentation",
});

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
 * Centralized error handler (#242).
 * Every ApiError thrown in a route handler is caught here and serialized
 * to the standard { error, code, statusCode, retryable, requestId } shape.
 */
app.setErrorHandler((error: any, request, reply) => {
  const requestId = request.id as string;
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send(error.toJSON(requestId));
  }
  // Rate limiting errors (429) from @fastify/rate-limit
  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: error.error || "Too Many Requests",
      code: "RATE_LIMITED",
      statusCode: 429,
      retryable: true,
      message: error.message,
      retryAfter: error.retryAfter,
      retryAfterSeconds: error.retryAfterSeconds,
      requestId,
    });
  }
  // Fastify validation errors (schema-driven)
  if ("validation" in error && Array.isArray((error as any).validation)) {
    return reply.status(400).send({
      error: "Request validation failed",
      code: "VALIDATION_ERROR",
      statusCode: 400,
      retryable: false,
      detail: (error as any).validation.map((v: any) => v.message).join("; "),
      requestId,
    });
  }
  // Unknown errors — log and return generic 500
  request.log.error(error, "Unhandled error");
  return reply.status(500).send({
    error: "An unexpected error occurred",
    code: "INTERNAL_ERROR",
    statusCode: 500,
    retryable: false,
    requestId,
  });
});

/**
 * x402 gate — every paid route calls this. If no valid X-Payment header
 * is present, respond 402 with a challenge describing what to pay and
 * where. This is the entire "auth" system: payment IS authentication,
 * there are no API keys or accounts.
 */
app.decorate(
  "requirePayment",
  async (req: any, reply: any, priceUsdc: string) => {
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
      throw new ApiError(402, "PAYMENT_ALREADY_USED", "Payment already used");
    }

    try {
      const txResponse = await server.getTransaction(payment);
      if (txResponse.status !== "SUCCESS") {
        throw new ApiError(
          402,
          "PAYMENT_NOT_SUCCESSFUL",
          "Payment transaction not successful",
        );
      }

      const parsedTx = TransactionBuilder.fromXDR(
        txResponse.envelopeXdr,
        NETWORK_PASSPHRASE,
      );
      const tx =
        "innerTransaction" in parsedTx
          ? (parsedTx as FeeBumpTransaction).innerTransaction
          : (parsedTx as Transaction);

      if (tx.memo.value?.toString() !== "velo:request") {
        throw new ApiError(402, "INVALID_PAYMENT_MEMO", "Invalid payment memo");
      }

      // Check operation
      const hasPayment = tx.operations.some((op) => {
        if (op.type === "payment") {
          const dest = (op as any).destination;
          const amt = (op as any).amount;
          const asset = (op as any).asset;
          return (
            dest === merchantAddress &&
            isUsdcAsset(asset) &&
            parseFloat(amt) >= parseFloat(priceUsdc)
          );
        } else if (
          op.type === "pathPaymentStrictReceive" ||
          op.type === "pathPaymentStrictSend"
        ) {
          const dest = (op as any).destination;
          const amt = (op as any).destAmount ?? (op as any).amount;
          const asset = (op as any).destAsset ?? (op as any).asset;
          return (
            dest === merchantAddress &&
            isUsdcAsset(asset) &&
            parseFloat(amt) >= parseFloat(priceUsdc)
          );
        }
        return false;
      });

      if (!hasPayment) {
        throw new ApiError(
          402,
          "INVALID_PAYMENT_TX",
          "Transaction does not contain a valid payment",
        );
      }

      recordPaymentUsed(payment);
      return true;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      req.log.error(err, "payment verification failed");
      throw new ApiError(
        402,
        "INVALID_PAYMENT_TX",
        "Invalid payment transaction",
      );
    }
  },
);

app.get(
  "/health",
  {
    config: {
      rateLimit: { max: 100, timeWindow: "1 minute" },
    },
  },
  async () => ({ ok: true }),
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
  }),
);

app.register(openapiRoutes, { prefix: "/api/v1" });
app.register(servicesRoutes, { prefix: "/api/v1" });
app.register(cashRoutes, { prefix: "/api/v1" });
app.register(disputeEvidenceRoutes, { prefix: "/api/v1" });
app.register(chatRoutes, { prefix: "/api/v1" });
app.register(e2eeKeysRoutes, { prefix: "/api/v1" });
app.register(reputationRoutes, { prefix: "/api/v1" });
app.register(providerRoutes, { prefix: "/api/v1" });
app.register(adminRoutes, { prefix: "/api/v1" });
app.register(sessionRoutes, { prefix: "/api/v1" });
app.register(sessionRotationRoutes, { prefix: "/api/v1" });
app.register(ratesRoutes, { prefix: "/api/v1" });
app.register(statusRoutes, { prefix: "/api/v1" });
app.register(circuitBreakerRoutes, { prefix: "/api/v1" });
app.register(batchAuctionRoutes, { prefix: "/api/v1" });
app.register(zkSettleRoutes, { prefix: "/api/v1" });
app.register(enterpriseOrgsRoutes, { prefix: "/api/v1" });
app.register(enterprisePoliciesRoutes, { prefix: "/api/v1" });
app.register(enterpriseApprovalsRoutes, { prefix: "/api/v1" });
app.register(spatialHotspotsRoutes, { prefix: "/api/v1" });
app.register(stateChannelRoutes, {
  prefix: "/api/v1",
  db: pgPool,
  redis: undefined,
});
// (#420) Collateral flash-loan protection: release-check gate. Shares the
// API's Postgres pool when configured; degrades to an in-memory store in dev.
app.register(collateralRoutes, {
  prefix: "/api/v1",
  store: new CollateralGuardStore(pgPool ?? undefined),
});
// Issue #433 — Multi-Sig Escrow Threshold Release & Key Recovery Protocol.
// Shares the API's Postgres pool when configured; degrades to an
// in-memory store in dev, same as the collateral guard above.
app.register(multisigEscrowRoutes, {
  prefix: "/api/v1",
  store: new MultisigEscrowStore(pgPool ?? undefined),
});
// (#404) Decentralized Jury Dispute Arbitration: commit-reveal voting,
// VRF juror selection, and automated escrow resolution with stake slashing.
app.register(juryArbitrationRoutes, { prefix: "/api/v1" });
// (#445) Distributed Multi-Node Webhook Event Delivery Engine & DLQ Recovery System.
export const webhookStore = new WebhookStore(pgPool ?? undefined);
app.register(webhooksRoutes, {
  prefix: "/api/v1",
  store: webhookStore,
});


