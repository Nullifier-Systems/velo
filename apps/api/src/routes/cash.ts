import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTRACTS } from "@velo/shared";
import {
  lockEscrow,
  lockEscrowWithTranches,
  releaseEscrow,
  releaseTrancheEscrow,
  refundEscrow,
  disputeEscrow,
  buildLockEscrowTransaction,
  submitSignedTransaction,
  submitReleaseTx,
  submitRefundTx,
  buildChainReleaseToLockTransaction,
  submitChainReleaseToLockTx,
  getTradeState,
  getEscrowPauseState,
  releaseBatchAtomic,
  NETWORK_PASSPHRASE,
  getLatestLedgerSequence,
  getTradeOnChain,
} from "../lib/stellar.js";
import {
  CASH_DEFAULT_TIMEOUT_LEDGERS,
  buildRefundCountdown,
} from "../lib/timeouts.js";
import { RpcTimeoutError } from "../lib/rpc-errors.js";
import { sendRefundAlert } from "../lib/webhook.js";
import { notifyTradeStatus } from "./chat.js";
import { randomHex32 } from "../lib/crypto.js";
import {
  saveCashRequest,
  getCashRequest,
  updateStatus,
  expireCashRequest,
  saveProvider,
  getProviders,
  countProvidersByNetwork,
  getProviderByAddress,
  enqueueForBatch,
  getPendingBatchesByProvider,
  logTimeoutIncident,
} from "../lib/store.js";
import { parseBody } from "../lib/validation.js";
import { sendNotification } from "../lib/notification.js";
import {
  toPublicProvider,
  withinRadius,
  applyKAnonymity,
  DEFAULT_PRECISION,
} from "../utils/privacy.js";
import {
  cellFor,
  haversineKm,
  GEOHASH_CELL_SIZE_METERS,
} from "../utils/geohash.js";
import { t, type Locale } from "../lib/i18n.js";
import { issueChatCapability } from "../lib/chat-capability.js";
import { registerTradeForChat } from "../lib/chat-infrastructure.js";
import { ApiError, ErrorCode } from "../lib/errors.js";
import {
  applyNetPayout,
  computeTrancheFeeStroops,
  FeeArithmeticOverflowError,
} from "../lib/fee-math.js";
import { globalH3SpatialIndex, type H3Resolution } from "../lib/h3-spatial-index.js";
import { globalMatchingEngine } from "../lib/matching-engine.js";
import { globalOrderAllocator } from "../lib/order-allocator.js";

const ESCROW_CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;

/**
 * Platform fee in basis points used for the off-chain safe-math pre-check
 * (issue #381). Must mirror the value configured on the escrow contract.
 * Out-of-range values are rejected so the pre-check can never disagree
 * with the contract's own bounds.
 */
const PLATFORM_FEE_BPS = (() => {
  const raw = process.env.PLATFORM_FEE_BPS;
  const parsed = raw === undefined ? 0 : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(
      `PLATFORM_FEE_BPS must be an integer in [0, 10000], got: ${raw}`,
    );
  }
  return parsed;
})();

const PAUSED_NEW_TRADE_MESSAGE =
  "New trades are temporarily paused. Existing locked trades can still be released or refunded.";

const REQUEST_TIMEOUT_MS = 10_000; // 10 second timeout for downstream RPC calls

/**
 * Wraps an async operation with a strict timeout. If the operation exceeds
 * REQUEST_TIMEOUT_MS, it throws an RpcTimeoutError and logs the incident.
 */
async function withRequestTimeout<T>(
  operation: string,
  fn: () => Promise<T>,
  req: { log: { error: (err: unknown, msg: string) => void }; headers?: { 'user-agent'?: string } }
): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      logTimeoutIncident(
        operation,
        req.headers?.['user-agent'],
        elapsed
      );
      reject(new RpcTimeoutError(operation, elapsed));
    }, REQUEST_TIMEOUT_MS);

    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Reject new locks when the on-chain circuit breaker is effective (issue #266). */
async function rejectIfEscrowPaused(
  req: { log: { warn: (err: unknown, msg: string) => void } },
  reply: { code: (n: number) => { send: (body: unknown) => void } },
): Promise<boolean> {
  try {
    const state = await getEscrowPauseState(ESCROW_CONTRACT_ID);
    if (state.paused) {
      reply.code(503).send({
        error: "escrow_paused",
        message: PAUSED_NEW_TRADE_MESSAGE,
        pause_effective_ledger: state.pause_effective_ledger,
      });
      return true;
    }
  } catch (err) {
    // If the pause read fails, allow the lock attempt — the contract itself
    // still enforces pause; this is a UX pre-check only.
    req.log.warn(err, "getEscrowPauseState failed; continuing without pause pre-check");
  }
  return false;
}

const cashRequestSchema = z.object({
  seller: z
    .string()
    .trim()
    .min(1)
    .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  buyer: z
    .string()
    .trim()
    .min(1)
    .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
  secret_hash: z
    .string()
    .trim()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/),
  // Validated manually below (rather than via z.enum) so we can return the
  // specific "mode must be either..." error message callers depend on.
  mode: z.string().trim().optional(),
  notification_type: z.enum(["email", "sms", "none"]).optional(),
  contact_info: z.string().optional(),
  signed_xdr: z.string().optional(),
});

type CashRequestBody = z.infer<typeof cashRequestSchema>;

interface RegisterProviderBody {
  name: string;
  lat: number;
  lng: number;
  rate?: string;
  device_id?: string;
}

function discoveryAvailability(agentCount: number, locale: Locale) {
  if (agentCount > 0) {
    return { state: "available" as const };
  }

  return {
    state: "no_providers_nearby" as const,
    message: t(locale, "discovery.noProvidersNearby"),
    suggested_action: "check_back_later" as const,
    retry_after_seconds: 3600,
  };
}

// Proximity matching is privacy-preserving: providers are generalized to a
// geohash cell and never returned with exact coordinates (issue #216). See
// ../utils/privacy.ts and docs/privacy/proximity-matching.md.

/**
 * GET  /api/v1/cash/agents        — find nearby cash providers ($0.001)
 * POST /api/v1/cash/agents        — register a cash provider ($0.000)
 * POST /api/v1/cash/request/prepare — lock funds via the escrow contract
 *                                    (custodial mode) or build an unsigned
 *                                    XDR for the buyer to sign (non_custodial
 *                                    mode); returns a claim_url + QR
 *                                    payload ($0.01)
 * POST /api/v1/cash/request       — legacy one-shot custodial lock; returns
 *                                    a claim_url + QR payload ($0.01)
 *                                    (testnet-only; use /prepare on mainnet)
 * GET  /api/v1/cash/request/:id   — poll a pending cash request (free)
 * POST /api/v1/cash/request/:id/submit — submit a buyer-signed XDR from the
 *                                    non-custodial flow to finish locking
 *                                    escrow (free)
 * POST /api/v1/cash/request/:id/release — merchant confirms hand-off,
 *                                    releases escrow using the secret
 *                                    embedded in the scanned QR (free)
 * POST /api/v1/cash/request/:id/refund  — refund escrow back to the buyer
 *                                    if the trade times out or fails (free)
 * POST /api/v1/cash/request/:id/chain — atomically release this trade
 *                                    directly into a new trade's lock
 *                                    (chain_release_to_lock), so a cash
 *                                    provider can re-circulate incoming
 *                                    funds without them landing in a
 *                                    wallet first. Non-custodial only —
 *                                    the contract requires this trade's
 *                                    seller to sign, so callers first POST
 *                                    without signed_xdr to get an unsigned
 *                                    transaction, then POST again with
 *                                    signed_xdr to submit it (free)
 * GET  /api/v1/cash/pause         — on-chain circuit breaker state (free)
 */
export async function cashRoutes(app: FastifyInstance) {
  app.get(
    "/cash/pause",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      try {
        const state = await getEscrowPauseState(ESCROW_CONTRACT_ID);
        return {
          ...state,
          message: state.paused ? PAUSED_NEW_TRADE_MESSAGE : null,
        };
      } catch (err) {
        req.log.error(err, "getEscrowPauseState failed");
        reply.code(502).send({
          error: "failed to read escrow pause state",
          detail: String(err),
        });
      }
    }
  );

  app.get<{
    Querystring: {
      lat?: string;
      lng?: string;
      radius?: string;
      precision?: string;
      k?: string;
    };
  }>(
    "/cash/agents",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.001");
      if (!paid) return;

      const { lat, lng, radius, precision, k } = req.query;
      const providers = getProviders().filter(
        (p) => p.status === "available" && p.kycStatus === "approved",
      );
      const prec = precision ? parseInt(precision, 10) : DEFAULT_PRECISION;
      const kAnon = k ? parseInt(k, 10) : 1;

      if (Number.isNaN(prec) || prec < 4 || prec > 8) {
        throw new ApiError(
          400,
          "INVALID_PRECISION",
          "precision must be an integer between 4 and 8",
        );
        return;
      }

      const privacyMeta = {
        precision: prec,
        cell_size_m: GEOHASH_CELL_SIZE_METERS[prec],
        k_anonymity: kAnon,
        note: t((req as any).locale ?? "en", "privacy.note"),
      };

      if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);
        const searchRadiusKm = radius ? parseFloat(radius) : 5.0; // Default to 5km radius if not provided

        if (isNaN(userLat) || isNaN(userLng) || isNaN(searchRadiusKm)) {
          throw new ApiError(
            400,
            "INVALID_COORDINATES",
            "Invalid numeric coordinates or radius supplied",
          );
          return;
        }

        // Filter at cell granularity (never by exact distance), then sort by the
        // cell-centroid distance computed server-side. Only the coarse public
        // view (cell + quantized band) is returned.
        const inRange = withinRadius(
          providers,
          { lat: userLat, lng: userLng },
          searchRadiusKm,
          prec,
        );
        const queryCell = cellFor(userLat, userLng, prec);
        inRange.sort((a, b) => {
          const ca = cellFor(a.lat, a.lng, prec);
          const cb = cellFor(b.lat, b.lng, prec);
          return (
            haversineKm(queryCell.lat, queryCell.lon, ca.lat, ca.lon) -
            haversineKm(queryCell.lat, queryCell.lon, cb.lat, cb.lon)
          );
        });

        let agents = inRange.map((p) =>
          toPublicProvider(
            p,
            { lat: userLat, lng: userLng, precision: prec },
            prec,
          ),
        );
        agents = applyKAnonymity(agents, kAnon);
        const availability = discoveryAvailability(
          agents.length,
          (req as any).locale ?? "en",
        );
        if (availability.state === "no_providers_nearby") {
          req.log.info(
            {
              event: "provider_discovery_empty",
              search_cell: queryCell.hash,
              radius_km: searchRadiusKm,
            },
            "no providers available near requester",
          );
        }
        return { agents, availability, privacy: privacyMeta };
      }

      // Default if no coordinates are provided: still coarse, no exact coords.
      let agents = providers.map((p) => toPublicProvider(p, undefined, prec));
      agents = applyKAnonymity(agents, kAnon);
      return {
        agents,
        availability: discoveryAvailability(
          agents.length,
          (req as any).locale ?? "en",
        ),
        privacy: privacyMeta,
      };
    },
  );

  app.post<{ Body: RegisterProviderBody }>(
    "/cash/agents",
    async (req, reply) => {
      // Economic hurdle: require 5.000 USDC payment to register
      const paid = await (app as any).requirePayment(req, reply, "5.000");
      if (!paid) return;

      const { name, lat, lng, rate, device_id } =
        req.body ?? ({} as RegisterProviderBody);
      if (!name || typeof lat !== "number" || typeof lng !== "number") {
        throw new ApiError(
          400,
          "MISSING_FIELD",
          "name, lat (number), and lng (number) are required",
        );
        return;
      }

      // Network Fingerprinting
      const networkCount = countProvidersByNetwork(req.ip, device_id);
      if (networkCount >= 2) {
        throw new ApiError(
          403,
          "REGISTRATION_LIMIT_EXCEEDED",
          "Registration limit exceeded for this network or device",
        );
        return;
      }

      const id = randomHex32();
      const provider = {
        id,
        name,
        lat,
        lng,
        rate: rate || "1.0",
        tier: "Probationary" as const,
        status: "available" as const,
        kycStatus: "pending" as const,
        ipAddress: req.ip,
        deviceId: device_id,
        createdAt: new Date().toISOString(),
      };

      saveProvider(provider);
      reply.code(201).send(provider);
    },
  );

  app.post<{
    Body: {
      lat: number;
      lng: number;
      radius?: number;
      amount_stroops?: string;
      h3_resolution?: H3Resolution;
    };
  }>("/cash/match", async (req, reply) => {
    const { lat, lng, radius, amount_stroops, h3_resolution } = req.body ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      throw new ApiError(400, "MISSING_COORDINATES", "lat and lng numeric coordinates are required");
    }

    const searchRadiusKm = radius && radius > 0 ? radius : 5.0;
    let amount: bigint;
    if (amount_stroops !== undefined && amount_stroops !== null && amount_stroops !== "") {
      const rawStr = String(amount_stroops).trim();
      if (!/^\d+$/.test(rawStr)) {
        throw new ApiError(400, "INVALID_AMOUNT", "amount_stroops must be a positive integer string");
      }
      amount = BigInt(rawStr);
    } else {
      amount = BigInt("100000000"); // Default 10 USDC
    }

    // 1. Uber H3 Hierarchical Spatial Indexing O(1) query with boundary hex crossings
    const h3Candidates = globalH3SpatialIndex.findProvidersInRadius(
      lat,
      lng,
      searchRadiusKm,
      h3_resolution
    );

    if (h3Candidates.length === 0) {
      return reply.code(404).send({
        matched: false,
        message: "No liquidity providers available in the specified spatial area",
        availability: discoveryAvailability(0, (req as any).locale ?? "en"),
      });
    }

    // 2. Multi-Parametric Matching Engine Scoring
    const scoredCandidates = globalMatchingEngine.scoreCandidates(
      h3Candidates,
      searchRadiusKm
    );

    // 3. Lock-Free Optimistic Concurrency Control Order Allocation
    const allocation = globalOrderAllocator.attemptAllocation(amount, scoredCandidates);

    if (!allocation.success || !allocation.matchedProvider) {
      return reply.code(409).send({
        matched: false,
        error: allocation.error ?? "ALLOCATION_FAILED",
        message: "Liquidity providers are fully committed or lack sufficient balance",
        attempts: allocation.attempts,
      });
    }

    return reply.code(200).send({
      matched: true,
      provider: toPublicProvider(
        allocation.matchedProvider,
        { lat, lng, precision: DEFAULT_PRECISION },
        DEFAULT_PRECISION
      ),
      matching_score: allocation.score,
      allocated_amount_stroops: allocation.allocatedAmountStroops?.toString(),
      attempts: allocation.attempts,
    });
  });

  const requestSchema = z.object({
    seller: z
      .string()
      .trim()
      .min(1)
      .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    buyer: z
      .string()
      .trim()
      .min(1)
      .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
    secret_hash: z
      .string()
      .trim()
      .length(64)
      .regex(/^[0-9a-fA-F]+$/),
  });

  const trancheSchema = z.object({
    amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
    secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
  });

  const prepareLockSchema = z.object({
    seller: z
      .string()
      .trim()
      .min(1)
      .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    buyer: z
      .string()
      .trim()
      .min(1)
      .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
    secret_hash: z
      .string()
      .trim()
      .length(64)
      .regex(/^[0-9a-fA-F]+$/),
    tranches: z.array(trancheSchema).optional(),
    // Validated manually below (rather than via z.enum) so we can return the
    // specific "mode must be either..." error message callers depend on.
    mode: z.string().trim().optional(),
    notification_type: z.enum(["email", "sms", "none"]).optional(),
    contact_info: z.string().optional(),
  });

  app.post<{ Body: z.infer<typeof prepareLockSchema> }>(
    "/cash/request/prepare",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.01");
      if (!paid) return;

      const body = parseBody(prepareLockSchema, req.body, reply);
      if (!body) return;

      if (await rejectIfEscrowPaused(req, reply)) return;

      const {
        seller,
        buyer,
        amount_stroops,
        secret_hash,
        tranches: rawTranches,
        mode: rawMode,
        notification_type,
        contact_info,
      } = body;

      if (rawTranches && rawTranches.length > 0) {
        const sum = rawTranches.reduce(
          (acc, t) => acc + BigInt(t.amount_stroops),
          0n,
        );
        if (sum !== BigInt(amount_stroops)) {
          throw new ApiError(
            400,
            "TRANCHE_SUM_MISMATCH",
            "Sum of tranche amounts must equal total amount_stroops",
          );
          return;
        }
      }

      const mode = rawMode ?? "custodial";
      if (mode !== "custodial" && mode !== "non_custodial") {
        throw new ApiError(
          400,
          "INVALID_MODE",
          "mode must be either 'custodial' or 'non_custodial'",
        );
        return;
      }

      if (notification_type && notification_type !== "none") {
        if (!contact_info) {
          throw new ApiError(
            400,
            "MISSING_FIELD",
            "contact_info is required when notification_type is specified",
          );
          return;
        }
        if (notification_type === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(contact_info)) {
            throw new ApiError(
              400,
              "INVALID_EMAIL",
              "Invalid email address format for contact_info",
            );
            return;
          }
        } else if (notification_type === "sms") {
          const phoneRegex = /^\+?[1-9]\d{5,14}$/;
          if (!phoneRegex.test(contact_info)) {
            throw new ApiError(
              400,
              "INVALID_PHONE",
              "Invalid phone number format for contact_info",
            );
            return;
          }
        }
      }

      const tradeId = randomHex32();
      const qrPayload = `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`;
      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      const locale = (req as any).locale ?? "en";

      if (mode === "custodial") {
        let lockedAtLedger: number;
        try {
          // Both the tranche and single-secret lock paths go through the
          // shared RPC timeout wrapper so a slow/hanging Horizon call
          // surfaces as a 504 with a proper incident log instead of hanging
          // the request indefinitely.
          lockedAtLedger = await withRequestTimeout(
            "POST /cash/request/prepare (custodial lock)",
            () => {
              if (rawTranches && rawTranches.length > 0) {
                return lockEscrowWithTranches({
                  contractId: ESCROW_CONTRACT_ID,
                  tradeId,
                  seller,
                  buyer,
                  amountStroops: BigInt(amount_stroops),
                  tranches: rawTranches.map((t) => ({
                    amountStroops: BigInt(t.amount_stroops),
                    secretHashHex: t.secret_hash,
                  })),
                  timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
                });
              }
              return lockEscrow({
                contractId: ESCROW_CONTRACT_ID,
                tradeId,
                seller,
                buyer,
                amountStroops: BigInt(amount_stroops),
                secretHashHex: secret_hash,
                timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
              });
            },
            req,
          );
        } catch (err) {
          req.log.error(err, "lockEscrow failed");
          if (err instanceof RpcTimeoutError) {
            reply.code(504).send({
              error: {
                code: "GATEWAY_TIMEOUT",
                message: "The payment network request timed out. Please retry your operation.",
                requestId: `req-tout-504-${tradeId}`,
                operation: err.operation,
                elapsed_ms: err.elapsedMs,
              }
            });
            return;
          }
          throw new ApiError(502, "ESCROW_LOCK_FAILED", "Escrow lock failed", {
            detail: String(err),
          });
        }

        const tranchesRecord = rawTranches
          ? rawTranches.map((t) => ({
              amountStroops: t.amount_stroops,
              secretHashHex: t.secret_hash,
              released: false,
            }))
          : undefined;

        saveCashRequest({
          id: tradeId,
          contractId: ESCROW_CONTRACT_ID,
          seller,
          buyer,
          amountStroops: amount_stroops,
          secretHex: "", // The API no longer knows the secret
          secretHashHex: secret_hash,
          qrPayload,
          status: "locked",
          timeoutLedger: lockedAtLedger + CASH_DEFAULT_TIMEOUT_LEDGERS,
          createdAt: new Date().toISOString(),
          notificationType: notification_type,
          contactInfo: contact_info,
          tranches: tranchesRecord,
          releasedTranchesCount: tranchesRecord ? 0 : undefined,
          releasedAmountStroops: tranchesRecord ? "0" : undefined,
        });
        await registerTradeForChat(getCashRequest(tradeId)!);

        reply.code(201).send({
          // The secret is held client-side and is NOT returned by the API
          claim_url: `${baseUrl}/claim/${tradeId}`,
          chat_token: issueChatCapability(tradeId, buyer),
          qr_payload: qrPayload,
          instructions: t(locale, "instructions.showQR"),
        });
      } else {
        try {
          const unsignedXdr = await buildLockEscrowTransaction({
            contractId: ESCROW_CONTRACT_ID,
            tradeId,
            seller,
            buyer,
            amountStroops: BigInt(amount_stroops),
            secretHashHex: secret_hash,
            timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
            signerPublicKey: buyer,
          });

          saveCashRequest({
            id: tradeId,
            contractId: ESCROW_CONTRACT_ID,
            seller,
            buyer,
            amountStroops: amount_stroops,
            secretHex: "",
            secretHashHex: secret_hash,
            qrPayload,
            status: "pending_signature",
            createdAt: new Date().toISOString(),
            notificationType: notification_type,
            contactInfo: contact_info,
          });
          await registerTradeForChat(getCashRequest(tradeId)!);

          reply.code(201).send({
            request_id: tradeId,
            unsigned_xdr: unsignedXdr,
            network_passphrase: NETWORK_PASSPHRASE,
            submit_url: `/api/v1/cash/request/${tradeId}/submit`,
            claim_url: `${baseUrl}/claim/${tradeId}`,
            chat_token: issueChatCapability(tradeId, buyer),
            qr_payload: qrPayload,
            instructions: t(locale, "instructions.signAndSubmit"),
          });
        } catch (err) {
          req.log.error(err, "buildLockEscrowTransaction failed");
          reply.code(502).send({
            error: "failed to build transaction",
            detail: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          return;
        }
      }
    },
  );

  app.post<{ Body: z.infer<typeof cashRequestSchema> }>(
    "/cash/request",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.01");
      if (!paid) return;

      const body = parseBody(cashRequestSchema, req.body, reply);
      if (!body) return;

      if (await rejectIfEscrowPaused(req, reply)) return;

      const {
        seller,
        buyer,
        amount_stroops,
        secret_hash,
        notification_type,
        contact_info,
      } = body;

      if (notification_type && notification_type !== "none") {
        if (!contact_info) {
          throw new ApiError(
            400,
            "MISSING_FIELD",
            "contact_info is required when notification_type is specified",
          );
          return;
        }
        if (notification_type === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(contact_info)) {
            throw new ApiError(
              400,
              "INVALID_EMAIL",
              "Invalid email address format for contact_info",
            );
            return;
          }
        } else if (notification_type === "sms") {
          const phoneRegex = /^\+?[1-9]\d{5,14}$/;
          if (!phoneRegex.test(contact_info)) {
            throw new ApiError(
              400,
              "INVALID_PHONE",
              "Invalid phone number format for contact_info",
            );
            return;
          }
        }
      }

      // Legacy custodial-only path. Non-custodial callers should use
      // POST /cash/request/prepare (mode: "non_custodial") followed by
      // POST /cash/request/:id/submit instead — this endpoint always
      // generates a fresh trade ID, so it cannot be paired with a
      // signed XDR built against some other trade ID.
      const tradeId = randomHex32();
      let lockedAtLedger: number;

      try {
        lockedAtLedger = await withRequestTimeout(
          "POST /cash/request (custodial lock)",
          () => lockEscrow({
            contractId: ESCROW_CONTRACT_ID,
            tradeId,
            seller,
            buyer,
            amountStroops: BigInt(amount_stroops),
            secretHashHex: secret_hash,
            timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
          }),
          req
        );
      } catch (err) {
        req.log.error(err, "lockEscrow failed");
        if (err instanceof RpcTimeoutError) {
          reply.code(504).send({
            error: {
              code: "GATEWAY_TIMEOUT",
              message: "The payment network request timed out. Please retry your operation.",
              requestId: `req-tout-504-${tradeId}`,
              operation: err.operation,
              elapsed_ms: err.elapsedMs,
            }
          });
          return;
        } else {
          reply.code(502).send({
            error: "escrow lock failed",
            detail: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
        return;
      }

      const qrPayload = `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`;
      saveCashRequest({
        id: tradeId,
        contractId: ESCROW_CONTRACT_ID,
        seller,
        buyer,
        amountStroops: amount_stroops,
        secretHex: "",
        secretHashHex: secret_hash,
        qrPayload,
        status: "locked",
        timeoutLedger: lockedAtLedger + CASH_DEFAULT_TIMEOUT_LEDGERS,
        createdAt: new Date().toISOString(),
        notificationType: notification_type,
        contactInfo: contact_info,
      });
      await registerTradeForChat(getCashRequest(tradeId)!);

      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      const locale = (req as any).locale ?? "en";
      reply.code(201).send({
        claim_url: `${baseUrl}/claim/${tradeId}`,
        chat_token: issueChatCapability(tradeId, buyer),
        qr_payload: qrPayload,
        instructions: t(locale, "instructions.showQR"),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/cash/request/:id",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      let latestLedger: number | null = null;
      try {
        latestLedger = await getLatestLedgerSequence();
        expireCashRequest(record, latestLedger);
      } catch (err) {
        req.log.warn(err, "could not check cash request expiry");
      }
      const { secretHex: _omit, ...safe } = record;
      const showCountdown =
        latestLedger !== null &&
        record.timeoutLedger !== undefined &&
        (record.status === "locked" || record.status === "expired");
      if (!showCountdown) {
        return safe;
      }
      const countdown = buildRefundCountdown(
        record.timeoutLedger!,
        latestLedger!,
      );
      return {
        ...safe,
        latestLedger: countdown.latestLedger,
        ledgersUntilRefund: countdown.ledgersUntilRefund,
        refundAvailable: countdown.refundAvailable,
        estimatedSecondsUntilRefund: countdown.estimatedSecondsUntilRefund,
      };
    },
  );

  // Reveal-on-match: exact provider coordinates are released ONLY once buyer and
  // provider share a confirmed escrow (locked/released/disputed). A requester
  // with no such match can never obtain precise coordinates from the API — the
  // discovery endpoints expose only coarse geohash cells (issue #216).
  app.get<{ Params: { id: string } }>(
    "/cash/request/:id/provider-location",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      const matched =
        record.status === "locked" ||
        record.status === "released" ||
        record.status === "disputed";
      if (!matched) {
        reply.code(403).send({
          error:
            "location is revealed only after a match is confirmed (escrow locked)",
          status: record.status,
        });
        return;
      }
      const provider = getProviderByAddress(record.seller);
      if (!provider) {
        throw new ApiError(
          404,
          "PROVIDER_NOT_FOUND",
          "no registered provider for this trade",
        );
        return;
      }
      return {
        request_id: record.id,
        provider_id: provider.id,
        name: provider.name,
        stellar_address: provider.stellarAddress ?? record.seller,
        lat: provider.lat,
        lng: provider.lng,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { signed_xdr: string } }>(
    "/cash/request/:id/submit",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      if (record.status === "locked") {
        const baseUrl =
          process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
        const locale = (req as any).locale ?? "en";
        reply.code(200).send({
          id: record.id,
          status: "locked",
          transaction_hash: null,
          claim_url: `${baseUrl}/claim/${record.id}`,
          chat_token: issueChatCapability(record.id, record.buyer),
          qr_payload: record.qrPayload,
          instructions: t(locale, "instructions.showQR"),
        });
        return;
      }
      if (record.status !== "pending_signature") {
        reply.code(409).send({
          error: `request is in status ${record.status}, expected pending_signature`,
        });
        return;
      }

      const { signed_xdr } = req.body ?? {};
      if (!signed_xdr) {
        throw new ApiError(400, "MISSING_SIGNED_XDR", "signed_xdr is required");
        return;
      }

      try {
        const result = await submitSignedTransaction(signed_xdr);
        updateStatus(record.id, "locked");
        record.timeoutLedger = result.ledger + CASH_DEFAULT_TIMEOUT_LEDGERS;

        const baseUrl =
          process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
        const locale = (req as any).locale ?? "en";
        reply.code(200).send({
          id: record.id,
          status: "locked",
          transaction_hash: result.hash,
          claim_url: `${baseUrl}/claim/${record.id}`,
          chat_token: issueChatCapability(record.id, record.buyer),
          qr_payload: record.qrPayload,
          instructions: t(locale, "instructions.showQR"),
        });
      } catch (err) {
        const current = getCashRequest(record.id);
        if (current && current.status === "locked") {
          const baseUrl =
            process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
          const locale = (req as any).locale ?? "en";
          reply.code(200).send({
            id: record.id,
            status: "locked",
            transaction_hash: null,
            claim_url: `${baseUrl}/claim/${record.id}`,
            chat_token: issueChatCapability(record.id, record.buyer),
            qr_payload: record.qrPayload,
            instructions: t(locale, "instructions.showQR"),
          });
          return;
        }
        req.log.error(err, "submitSignedTransaction failed");
        reply.code(502).send({
          error: "transaction submission failed",
          detail: String(err),
        });
        return;
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { secret?: string; signed_xdr?: string };
  }>(
    "/cash/request/:id/release",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      if (record.status === "released") {
        return { id: record.id, status: "released" };
      }
      if (record.status === "pending_batch") {
        return { id: record.id, status: "pending_batch" };
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const releaseBody = parseBody(
        z.object({
          secret: z.string().trim().min(1).optional(),
          signed_xdr: z.string().trim().min(1).optional(),
        }),
        req.body,
        reply,
      );
      if (!releaseBody) return;

      const { secret, signed_xdr } = releaseBody;

      if (signed_xdr) {
        try {
          await submitReleaseTx(signed_xdr);
        } catch (err) {
          const onChainTrade = await getTradeOnChain(record.contractId, record.id);
          if (onChainTrade?.status === "released") {
            updateStatus(record.id, "released");
            await notifyTradeStatus(record.id, "released");
            await sendNotification(record, "released", (req as any).locale ?? "en");
            return { id: record.id, status: "released" };
          }
          const current = getCashRequest(record.id);
          if (current && current.status === "released") {
            return { id: record.id, status: "released" };
          }
          req.log.error(err, "submitReleaseTx failed");
          reply
            .code(502)
            .send({ error: "release submission failed", detail: String(err) });
          return;
        }
      } else if (secret) {
        // Providers who opted into batched payouts (POST /provider/payout-settings)
        // don't get an immediate on-chain release() here — the secret is queued
        // and settled later alongside their other pending trades in one
        // batch_release() call. See docs/provider-payout-batching.md.
        const provider = getProviderByAddress(record.seller);
        if (provider?.payoutMode === "batched") {
          enqueueForBatch(record.id, secret);
          return { id: record.id, status: "pending_batch" };
        }

        try {
          await releaseEscrow({
            contractId: record.contractId,
            tradeId: record.id,
            secretHex: secret,
          });
        } catch (err) {
          const onChainTrade = await getTradeOnChain(record.contractId, record.id);
          if (onChainTrade?.status === "released") {
            updateStatus(record.id, "released");
            await notifyTradeStatus(record.id, "released");
            await sendNotification(record, "released", (req as any).locale ?? "en");
            return { id: record.id, status: "released" };
          }
          const current = getCashRequest(record.id);
          if (current && current.status === "released") {
            return { id: record.id, status: "released" };
          }
          req.log.error(err, "releaseEscrow failed");
          if (err instanceof RpcTimeoutError) {
            reply.code(504).send({
              error: "rpc_timeout",
              detail: err.message,
              operation: err.operation,
              elapsed_ms: err.elapsedMs,
            });
          } else {
            reply
              .code(502)
              .send({ error: "escrow release failed", detail: String(err) });
          }
          return;
        }
      } else {
        throw new ApiError(
          400,
          "MISSING_SECRET_OR_XDR",
          "either secret or signed_xdr is required",
        );
        return;
      }

      updateStatus(record.id, "released");
      await notifyTradeStatus(record.id, "released");
      await sendNotification(record, "released", (req as any).locale ?? "en");
      return { id: record.id, status: "released" };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/cash/request/:id/release-tranche",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }
      if (!record.tranches || record.tranches.length === 0) {
        throw new ApiError(400, "NO_TRANCHES", "This request was not created with tranches");
        return;
      }

      const releaseBody = parseBody(
        z.object({
          tranche_index: z.number().int().min(0),
          secret: z.string().trim().min(1),
        }),
        req.body,
        reply,
      );
      if (!releaseBody) return;

      const { tranche_index, secret } = releaseBody;
      if (tranche_index >= record.tranches.length) {
        throw new ApiError(400, "INVALID_TRANCHE_INDEX", "tranche_index out of bounds");
        return;
      }

      const tranche = record.tranches[tranche_index];
      if (tranche.released) {
        reply.code(409).send({ error: "tranche already released" });
        return;
      }

      // Issue #381: validate the tranche fee against safe-math bounds
      // BEFORE submitting on-chain, mirroring the contract's checked
      // arithmetic (checked_mul / checked_div + 1-stroop micro-tranche
      // floor). A computation that would overflow i128 or lose precision
      // fails here with 422 instead of trapping funds in a panicking call.
      try {
        const grossStroops = BigInt(tranche.amountStroops);
        const feeStroops = computeTrancheFeeStroops(grossStroops, PLATFORM_FEE_BPS);
        const netStroops = applyNetPayout(grossStroops, feeStroops);
        req.log.info(
          {
            tradeId: record.id,
            tranche_index,
            gross: grossStroops.toString(),
            fee: feeStroops.toString(),
            net: netStroops.toString(),
          },
          "tranche fee safe-math pre-check passed",
        );
      } catch (err) {
        if (err instanceof FeeArithmeticOverflowError) {
          throw new ApiError(
            422,
            ErrorCode.FEE_ARITHMETIC_OVERFLOW,
            "Tranche fee calculation resulted in arithmetic overflow or invalid precision.",
            { detail: err.message },
          );
        }
        throw err;
      }

      try {
        await releaseTrancheEscrow({
          contractId: record.contractId,
          tradeId: record.id,
          trancheIndex: tranche_index,
          secretHex: secret,
        });
      } catch (err) {
        req.log.error(err, "releaseTrancheEscrow failed");
        if (err instanceof RpcTimeoutError) {
          reply.code(504).send({
            error: "rpc_timeout",
            detail: err.message,
            operation: err.operation,
            elapsed_ms: err.elapsedMs,
          });
        } else {
          reply
            .code(502)
            .send({ error: "tranche release failed", detail: String(err) });
        }
        return;
      }

      tranche.released = true;
      const releasedCount = record.tranches.filter((t) => t.released).length;
      record.releasedTranchesCount = releasedCount;
      const releasedAmountStroops = record.tranches
        .filter((t) => t.released)
        .reduce((acc, t) => acc + BigInt(t.amountStroops), 0n)
        .toString();
      record.releasedAmountStroops = releasedAmountStroops;

      if (releasedCount === record.tranches.length) {
        updateStatus(record.id, "released");
        await notifyTradeStatus(record.id, "released");
        await sendNotification(record, "released", (req as any).locale ?? "en");
      } else {
        await notifyTradeStatus(record.id, "locked");
      }

      return {
        id: record.id,
        status: record.status,
        releasedTranchesCount: releasedCount,
        totalTranchesCount: record.tranches.length,
        releasedAmountStroops,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { signed_xdr?: string } }>(
    "/cash/request/:id/refund",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      if (record.status === "refunded") {
        return { id: record.id, status: "refunded" };
      }
      if (record.status !== "locked" && record.status !== "expired") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const refundBody = parseBody(
        z.object({ signed_xdr: z.string().trim().min(1).optional() }),
        req.body ?? {},
        reply,
      );
      if (!refundBody) return;

      if (refundBody.signed_xdr) {
        try {
          await submitRefundTx(refundBody.signed_xdr);
        } catch (err) {
          const onChainTrade = await getTradeOnChain(record.contractId, record.id);
          if (onChainTrade?.status === "refunded") {
            updateStatus(record.id, "refunded");
            await notifyTradeStatus(record.id, "refunded");
            await sendNotification(record, "refunded", (req as any).locale ?? "en");
            sendRefundAlert({
              tradeId: record.id,
              amountStroops: record.amountStroops,
              buyer: record.buyer,
              seller: record.seller,
            });
            return { id: record.id, status: "refunded" };
          }
          const current = getCashRequest(record.id);
          if (current && current.status === "refunded") {
            return { id: record.id, status: "refunded" };
          }
          req.log.error(err, "submitRefundTx failed");
          reply
            .code(502)
            .send({ error: "refund submission failed", detail: String(err) });
          return;
        }
      } else {
        try {
          await refundEscrow({
            contractId: record.contractId,
            tradeId: record.id,
          });
        } catch (err) {
          const onChainTrade = await getTradeOnChain(record.contractId, record.id);
          if (onChainTrade?.status === "refunded") {
            updateStatus(record.id, "refunded");
            await notifyTradeStatus(record.id, "refunded");
            await sendNotification(record, "refunded", (req as any).locale ?? "en");
            sendRefundAlert({
              tradeId: record.id,
              amountStroops: record.amountStroops,
              buyer: record.buyer,
              seller: record.seller,
            });
            return { id: record.id, status: "refunded" };
          }
          const current = getCashRequest(record.id);
          if (current && current.status === "refunded") {
            return { id: record.id, status: "refunded" };
          }
          req.log.error(err, "refundEscrow failed");
          if (err instanceof RpcTimeoutError) {
            reply.code(504).send({
              error: "rpc_timeout",
              detail: err.message,
              operation: err.operation,
              elapsed_ms: err.elapsedMs,
            });
          } else {
            reply
              .code(502)
              .send({ error: "escrow refund failed", detail: String(err) });
          }
          return;
        }
      }

      updateStatus(record.id, "refunded");
      await notifyTradeStatus(record.id, "refunded");
      await sendNotification(record, "refunded", (req as any).locale ?? "en");

      sendRefundAlert({
        tradeId: record.id,
        amountStroops: record.amountStroops,
        buyer: record.buyer,
        seller: record.seller,
      });

      return { id: record.id, status: "refunded" };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { caller: string; reason?: string };
  }>(
    "/cash/request/:id/dispute",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        throw new ApiError(404, "TRADE_NOT_FOUND", "request not found");
        return;
      }
      if (record.status === "disputed") {
        return {
          id: record.id,
          status: "disputed",
          disputedAt: record.disputedAt,
          disputedBy: record.disputedBy,
          disputeReason: record.disputeReason || "",
        };
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const disputeBody = parseBody(
        z.object({
          caller: z
            .string()
            .trim()
            .min(1)
            .regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
          reason: z.string().trim().optional(),
        }),
        req.body,
        reply,
      );
      if (!disputeBody) return;

      const { caller, reason } = disputeBody;

      if (caller !== record.buyer && caller !== record.seller) {
        throw new ApiError(
          403,
          "NOT_TRADE_PARTICIPANT",
          "Only trade participants can dispute a trade",
        );
        return;
      }

      try {
        await disputeEscrow({
          contractId: record.contractId,
          tradeId: record.id,
          caller,
        });
      } catch (err) {
        const current = getCashRequest(record.id);
        if (current && current.status === "disputed") {
          return {
            id: record.id,
            status: "disputed",
            disputedAt: current.disputedAt,
            disputedBy: current.disputedBy,
            disputeReason: current.disputeReason || "",
          };
        }
        req.log.error(err, "disputeEscrow failed");
        reply
          .code(502)
          .send({ error: "escrow dispute failed", detail: String(err) });
        return;
      }

      const disputedAt = new Date().toISOString();
      updateStatus(record.id, "disputed");
      record.disputedAt = disputedAt;
      record.disputedBy = caller;
      record.disputeReason = reason || "";

      try {
        if ((app as any).pg) {
          const query = `
            UPDATE cash_requests
            SET 
              status = 'disputed',
              disputed_at = $1,
              disputed_by = $2,
              dispute_reason = $3,
              updated_at = NOW()
            WHERE id = $4;
          `;
          await (app as any).pg.query(query, [
            disputedAt,
            caller,
            reason || null,
            record.id,
          ]);
        }
      } catch (dbErr) {
        req.log.error(dbErr, "failed to update database status to disputed");
      }

      return {
        id: record.id,
        status: "disputed",
        disputedAt,
        disputedBy: caller,
        disputeReason: reason || "",
      };
    },
  );

  /**
   * POST /api/v1/cash/batch-release — Atomically release a batch of pending trades.
   *
   * Provider provides a list of trade IDs they want to release together.
   * This maps to the escrow contract's atomic `release_batch()` entrypoint,
   * which releases ALL or NONE — distinct from `batch_release()`, which skips
   * invalid legs and is used by the background payout batcher.
   *
   * Contract behavior:
   * - Validates ALL trades exist, are Locked, and have valid secrets BEFORE any changes
   * - If ANY trade fails validation, the entire batch reverts (no partial settlement)
   * - Aggregates fees across all trades and pays them once
   * - All succeed together or all fail together (true atomicity)
   *
   * Because settlement is all-or-nothing, off-chain records are only marked
   * `released` after the contract call succeeds. If it reverts, every trade is
   * left in `pending_batch` untouched, so a single bad leg never leaves the
   * batch half-settled.
   *
   * Request body: { trade_ids: string[] }  — array of hex trade IDs to release
   *
   * Returns: { released_count: number, trade_ids: string[], total_amount: string }
   * On error: { error, code, statusCode } (validation) or { error, detail } (502/504)
   */
  app.post<{ Body: { trade_ids?: string[] } }>(
    "/cash/batch-release",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const body = parseBody(
        z.object({ trade_ids: z.array(z.string().regex(/^[0-9a-f]{64}$/i)) }),
        req.body,
        reply,
      );
      if (!body) return;

      const { trade_ids } = body;
      if (!trade_ids || trade_ids.length === 0) {
        throw new ApiError(400, "EMPTY_BATCH", "trade_ids cannot be empty");
        return;
      }

      if (trade_ids.length > 25) {
        throw new ApiError(
          400,
          "BATCH_TOO_LARGE",
          "Maximum 25 trades per batch",
        );
        return;
      }

      // Collect the records and verify they're all pending_batch for the same seller.
      const records = trade_ids
        .map((id) => getCashRequest(id))
        .filter((r) => r !== undefined) as typeof trade_ids extends any[]
        ? any[]
        : never;

      if (records.length !== trade_ids.length) {
        throw new ApiError(
          404,
          "TRADE_NOT_FOUND",
          "One or more trade IDs not found",
        );
        return;
      }

      // Verify all trades are pending_batch and belong to the same seller.
      const statuses = new Set(records.map((r) => r.status));
      if (statuses.size > 1 || !statuses.has("pending_batch")) {
        throw new ApiError(
          409,
          "INVALID_STATUS",
          "All trades must be in pending_batch status",
        );
        return;
      }

      const sellers = new Set(records.map((r) => r.seller));
      if (sellers.size > 1) {
        throw new ApiError(
          400,
          "MIXED_SELLERS",
          "All trades in a batch must have the same seller",
        );
        return;
      }

      const contractId = records[0].contractId;
      const contractIds = new Set(records.map((r) => r.contractId));
      if (contractIds.size > 1) {
        throw new ApiError(
          400,
          "MIXED_CONTRACTS",
          "All trades must use the same contract",
        );
        return;
      }

      // Verify all records have secretHex set (shouldn't fail if status is pending_batch).
      const missing = records.filter((r) => !r.secretHex);
      if (missing.length > 0) {
        throw new ApiError(
          400,
          "MISSING_SECRET",
          `${missing.length} trade(s) missing revealed secret`,
        );
        return;
      }

      // Build the releases array for the contract call.
      const releases = records.map((r) => ({
        tradeId: r.id,
        secretHex: r.secretHex!,
      }));

      try {
        // Call the atomic release_batch() function on the contract.
        // If ANY trade fails validation, the entire batch reverts and this
        // throws, so no trade below is marked released (clean rollback).
        await releaseBatchAtomic({
          contractId,
          releases,
        });
      } catch (err) {
        req.log.error(err, "releaseBatchAtomic failed");
        if (err instanceof RpcTimeoutError) {
          reply.code(504).send({
            error: "rpc_timeout",
            detail: err.message,
            operation: err.operation,
            elapsed_ms: err.elapsedMs,
          });
        } else {
          reply.code(502).send({
            error: "batch release failed",
            detail: String(err),
          });
        }
        return;
      }

      // The atomic release_batch() succeeded, so every leg settled on-chain.
      // Mark them all released and notify.
      let totalPayout = 0n;

      for (const record of records) {
        const amount = BigInt(record.amountStroops);
        updateStatus(record.id, "released");
        await notifyTradeStatus(record.id, "released");
        await sendNotification(record, "released", (req as any).locale ?? "en");
        totalPayout += amount;
      }

      reply.code(200).send({
        released_count: records.length,
        trade_ids: trade_ids,
        total_amount: totalPayout.toString(),
      });
    },
  );

  // See chain_release_to_lock() in contracts/escrow/src/lib.rs and
  // docs/escrow-chain-release-to-lock.md for the authorization model this
  // endpoint relies on: only this trade's seller can authorize the chain,
  // so unlike /release there is no custodial path here — the caller must
  // build (this endpoint, no signed_xdr), sign as the seller, then submit
  // (this endpoint again, with signed_xdr).
  app.post<{
    Params: { id: string };
    Body: {
      release_secret?: string;
      new_seller?: string;
      new_secret_hash?: string;
      new_timeout_ledgers?: number;
      signed_xdr?: string;
    };
  }>(
    "/cash/request/:id/chain",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        reply.code(404).send({ error: "request not found" });
        return;
      }

      if (record.status === "released") {
        return record.chainedToId
          ? { id: record.id, status: "released", chained_to: record.chainedToId }
          : { id: record.id, status: "released" };
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const chainSchema = z.object({
        release_secret: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
        new_seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
        new_secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
        new_timeout_ledgers: z.number().int().positive().optional(),
        signed_xdr: z.string().trim().min(1).optional(),
      });
      const body = parseBody(chainSchema, req.body, reply);
      if (!body) return;

      const { release_secret, new_seller, new_secret_hash, new_timeout_ledgers, signed_xdr } = body;
      const timeoutLedgers = new_timeout_ledgers ?? CASH_DEFAULT_TIMEOUT_LEDGERS;

      if (!signed_xdr) {
        try {
          const unsignedXdr = await buildChainReleaseToLockTransaction({
            contractId: record.contractId,
            releaseTradeId: record.id,
            releaseSecretHex: release_secret,
            newSeller: new_seller,
            newSecretHashHex: new_secret_hash,
            newTimeoutLedgers: timeoutLedgers,
            signerPublicKey: record.seller,
          });
          reply.code(200).send({
            id: record.id,
            status: record.status,
            unsigned_xdr: unsignedXdr,
            network_passphrase: NETWORK_PASSPHRASE,
            submit_url: `/api/v1/cash/request/${record.id}/chain`,
            instructions: "Sign as this trade's seller, then POST the signed envelope back to submit_url as signed_xdr.",
          });
        } catch (err) {
          req.log.error(err, "buildChainReleaseToLockTransaction failed");
          reply.code(502).send({ error: "failed to build chain transaction", detail: String(err) });
        }
        return;
      }

      let newTradeId: string;
      try {
        const result = await submitChainReleaseToLockTx(signed_xdr);
        newTradeId = result.newTradeId;
      } catch (err) {
        const current = getCashRequest(record.id);
        if (current && current.status === "released" && current.chainedToId) {
          return { id: record.id, status: "released", chained_to: current.chainedToId };
        }
        req.log.error(err, "submitChainReleaseToLockTx failed");
        if (err instanceof RpcTimeoutError) {
          reply.code(504).send({
            error: "rpc_timeout",
            detail: err.message,
            operation: err.operation,
            elapsed_ms: err.elapsedMs,
          });
        } else {
          reply.code(502).send({ error: "chain release failed", detail: String(err) });
        }
        return;
      }

      // Best-effort: read trade B's authoritative on-chain amount (derived
      // on-chain from trade A's amount minus the platform fee, which this
      // API does not independently track). The chain itself already
      // succeeded regardless of whether this read does.
      let newAmountStroops = "0";
      let newTimeoutLedger: number | undefined;
      try {
        const onChain = await getTradeState(record.contractId, newTradeId, record.seller);
        if (onChain) {
          newAmountStroops = onChain.amountStroops;
          newTimeoutLedger = onChain.timeoutLedger;
        }
      } catch (err) {
        req.log.warn(err, "could not read chained trade's on-chain state");
      }

      const qrPayload = `velo://claim?request_id=${newTradeId}&contract=${record.contractId}`;
      saveCashRequest({
        id: newTradeId,
        contractId: record.contractId,
        seller: new_seller,
        buyer: record.seller,
        amountStroops: newAmountStroops,
        secretHex: "",
        secretHashHex: new_secret_hash,
        qrPayload,
        status: "locked",
        timeoutLedger: newTimeoutLedger,
        createdAt: new Date().toISOString(),
        chainedFromId: record.id,
      });
      await registerTradeForChat(getCashRequest(newTradeId)!);

      updateStatus(record.id, "released");
      record.chainedToId = newTradeId;
      await notifyTradeStatus(record.id, "released");
      await sendNotification(record, "released", (req as any).locale ?? "en");

      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      return {
        id: record.id,
        status: "released",
        chained_to: newTradeId,
        new_trade: {
          id: newTradeId,
          claim_url: `${baseUrl}/claim/${newTradeId}`,
          qr_payload: qrPayload,
        },
      };
    }
  );
}