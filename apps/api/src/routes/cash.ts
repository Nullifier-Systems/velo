import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTRACTS } from "@velo/shared";
import {
  lockEscrow,
  releaseEscrow,
  refundEscrow,
  disputeEscrow,
  buildLockEscrowTransaction,
  submitSignedTransaction,
  submitReleaseTx,
  submitRefundTx,
  batchReleaseEscrow,
  releaseBatchEscrow,
  NETWORK_PASSPHRASE,
  getLatestLedgerSequence,
  getTradeOnChain,
} from "../lib/stellar.js";
import { CASH_CASH_DEFAULT_TIMEOUT_LEDGERS } from "../lib/timeouts.js";
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
import { ApiError } from "../lib/errors.js";
import { globalH3SpatialIndex, type H3Resolution } from "../lib/h3-spatial-index.js";
import { globalMatchingEngine } from "../lib/matching-engine.js";
import { globalOrderAllocator } from "../lib/order-allocator.js";

const ESCROW_CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;

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
 */
export async function cashRoutes(app: FastifyInstance) {
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
    const amount = BigInt(amount_stroops ?? "100000000"); // Default 10 USDC

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

      const {
        seller,
        buyer,
        amount_stroops,
        secret_hash,
        mode: rawMode,
        notification_type,
        contact_info,
      } = body;
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
          lockedAtLedger = await lockEscrow({
            contractId: ESCROW_CONTRACT_ID,
            tradeId,
            seller,
            buyer,
            amountStroops: BigInt(amount_stroops),
            secretHashHex: secret_hash,
            timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
          });
        } catch (err) {
          req.log.error(err, "lockEscrow failed");
          if (err instanceof RpcTimeoutError) {
            throw new ApiError(504, "RPC_TIMEOUT", "RPC timeout", {
              extra: { operation: err.operation, elapsed_ms: err.elapsedMs },
              detail: err.message,
            });
          }
          throw new ApiError(502, "ESCROW_LOCK_FAILED", "Escrow lock failed", {
            detail: String(err),
          });
        }

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
        lockedAtLedger = await lockEscrow({
          contractId: ESCROW_CONTRACT_ID,
          tradeId,
          seller,
          buyer,
          amountStroops: BigInt(amount_stroops),
          secretHashHex: secret_hash,
          timeoutLedgers: CASH_DEFAULT_TIMEOUT_LEDGERS,
        });
      } catch (err) {
        req.log.error(err, "lockEscrow failed");
        if (err instanceof RpcTimeoutError) {
          reply.code(504).send({
            error: "rpc_timeout",
            detail: err.message,
            operation: err.operation,
            elapsed_ms: err.elapsedMs,
          });
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
      try {
        expireCashRequest(record, await getLatestLedgerSequence());
      } catch (err) {
        req.log.warn(err, "could not check cash request expiry");
      }
      const { secretHex: _omit, ...safe } = record;
      return safe;
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
   * The contract validates ALL trades, then releases ALL or NONE (atomic).
   *
   * Contract behavior:
   * - Validates ALL trades exist, are Locked, and have valid secrets BEFORE any changes
   * - If ANY trade fails validation, the entire batch reverts (no partial settlement)
   * - Aggregates fees across all trades and pays them once
   * - All succeed together or all fail together (true atomicity)
   *
   * Request body: { trade_ids: string[] }  — array of hex trade IDs to release
   *
   * Returns: { released_count: number, total_payout: string, total_fees: string }
   * On error: { error: string, detail: string } + 400/502/504 status
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
        // If ANY trade fails validation, the entire batch reverts.
        await releaseBatchEscrow({
          contractId,
          releases,
        });
      } catch (err) {
        req.log.error(err, "releaseBatchEscrow failed");
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

      // On success, mark all trades as released and notify.
      let totalPayout = 0n;
      let totalFees = 0n;

      for (const record of records) {
        const amount = BigInt(record.amountStroops);
        // Fee calculation matches contract: fee = (amount * fee_bps) / 10_000
        // We don't have fee_bps here, but the contract applied it, so we just track totals.
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
}
