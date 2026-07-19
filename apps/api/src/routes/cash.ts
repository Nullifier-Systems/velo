import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTRACTS } from "@velo/shared";
import {
  lockEscrow,
  releaseEscrow,
  refundEscrow,
  buildLockEscrowTransaction,
  submitSignedTransaction,
  submitReleaseTx,
  submitRefundTx,
  NETWORK_PASSPHRASE,
} from "../lib/stellar.js";
import { sendRefundAlert } from "../lib/webhook.js";
import { randomHex32 } from "../lib/crypto.js";
import { saveCashRequest, getCashRequest, updateStatus, saveProvider, getProviders, countProvidersByNetwork } from "../lib/store.js";
import { parseBody } from "../lib/validation.js";
import { sendNotification } from "../lib/notification.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15-20 min at Stellar's ~5-6s ledger close time

const cashRequestSchema = z.object({
  seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  buyer: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
  secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
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

interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Calculates bounding-box coordinates for a given search point and radius.
 * @param lat Target Latitude (degrees)
 * @param lng Target Longitude (degrees)
 * @param radiusInKm Search radius in kilometers (defaults to 5km)
 */
function getBoundingBox(lat: number, lng: number, radiusInKm: number): BoundingBox {
  const kmPerDegreeLat = 111;
  // Account for longitude shrinkage as we move away from the equator
  const kmPerDegreeLng = 111 * Math.cos(lat * (Math.PI / 180));

  const latDelta = radiusInKm / kmPerDegreeLat;
  const lngDelta = radiusInKm / kmPerDegreeLng;

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/**
 * Simple Haversine distance formula to calculate exact path distance
 */
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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
  app.get<{ Querystring: { lat?: string; lng?: string; radius?: string } }>(
    "/cash/agents",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.001");
      if (!paid) return;

      const { lat, lng, radius } = req.query;
      const providers = getProviders().filter(p => p.status === "available");

      if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);
        const searchRadiusKm = radius ? parseFloat(radius) : 5.0; // Default to 5km radius if not provided

        if (isNaN(userLat) || isNaN(userLng) || isNaN(searchRadiusKm)) {
          reply.code(400).send({ error: "Invalid numeric coordinates or radius supplied" });
          return;
        }

        // 1. Obtain bounding box
        const box = getBoundingBox(userLat, userLng, searchRadiusKm);

        // 2. High-speed Bounding-box pre-filtering
        const candidates = providers.filter(p =>
          p.lat >= box.minLat && p.lat <= box.maxLat &&
          p.lng >= box.minLng && p.lng <= box.maxLng
        );

        // 3. Exact distance calculation on remaining filtered candidates
        const withDistance = candidates
          .map(p => ({
            ...p,
            distance_km: parseFloat(getDistanceFromLatLonInKm(userLat, userLng, p.lat, p.lng).toFixed(2))
          }))
          // Prune out mathematical corner cases falling in the box but outside the circle radius
          .filter(p => p.distance_km <= searchRadiusKm);

        withDistance.sort((a, b) => a.distance_km - b.distance_km);
        return { agents: withDistance };
      }

      // Default if no coordinates are provided
      return { agents: providers };
    }
  );

  app.post<{ Body: RegisterProviderBody }>("/cash/agents", async (req, reply) => {
      // Economic hurdle: require 5.000 USDC payment to register
      const paid = await (app as any).requirePayment(req, reply, "5.000");
      if (!paid) return;

      const { name, lat, lng, rate, device_id } = req.body ?? ({} as RegisterProviderBody);
      if (!name || typeof lat !== "number" || typeof lng !== "number") {
          reply.code(400).send({ error: "name, lat (number), and lng (number) are required" });
          return;
      }
      
      // Network Fingerprinting
      const networkCount = countProvidersByNetwork(req.ip, device_id);
      if (networkCount >= 2) {
          reply.code(403).send({ error: "Registration limit exceeded for this network or device" });
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
          createdAt: new Date().toISOString()
      };

      saveProvider(provider);
      reply.code(201).send(provider);
  });

  const requestSchema = z.object({
    seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    buyer: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
    secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
  });

  const prepareLockSchema = z.object({
    seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    buyer: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
    amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
    secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
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

      const { seller, buyer, amount_stroops, secret_hash, mode: rawMode, notification_type, contact_info } = body;
      const mode = rawMode ?? "custodial";
      if (mode !== "custodial" && mode !== "non_custodial") {
        reply.code(400).send({ error: "mode must be either 'custodial' or 'non_custodial'" });
        return;
      }

      if (notification_type && notification_type !== "none") {
        if (!contact_info) {
          reply.code(400).send({ error: "contact_info is required when notification_type is specified" });
          return;
        }
        if (notification_type === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(contact_info)) {
            reply.code(400).send({ error: "Invalid email address format for contact_info" });
            return;
          }
        } else if (notification_type === "sms") {
          const phoneRegex = /^\+?[1-9]\d{5,14}$/;
          if (!phoneRegex.test(contact_info)) {
            reply.code(400).send({ error: "Invalid phone number format for contact_info" });
            return;
          }
        }
      }

      const tradeId = randomHex32();
      const qrPayload = `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`;
      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";

      if (mode === "custodial") {
        try {
          await lockEscrow({
            contractId: ESCROW_CONTRACT_ID,
            tradeId,
            seller,
            buyer,
            amountStroops: BigInt(amount_stroops),
            secretHashHex: secret_hash,
            timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
          });
        } catch (err) {
          req.log.error(err, "lockEscrow failed");
          reply.code(502).send({
            error: "escrow lock failed",
            detail: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          return;
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
          createdAt: new Date().toISOString(),
          notificationType: notification_type,
          contactInfo: contact_info,
        });

        reply.code(201).send({
          // The secret is held client-side and is NOT returned by the API
          claim_url: `${baseUrl}/claim/${tradeId}`,
          qr_payload: qrPayload,
          instructions: "Show this QR to the cash provider to receive your cash.",
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
            timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
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

          reply.code(201).send({
            request_id: tradeId,
            unsigned_xdr: unsignedXdr,
            network_passphrase: NETWORK_PASSPHRASE,
            submit_url: `/api/v1/cash/request/${tradeId}/submit`,
            claim_url: `${baseUrl}/claim/${tradeId}`,
            qr_payload: qrPayload,
            instructions: "Sign the transaction with your wallet and submit to the provided endpoint.",
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
    }
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

      const { seller, buyer, amount_stroops, secret_hash, notification_type, contact_info } = body;

      if (notification_type && notification_type !== "none") {
        if (!contact_info) {
          reply.code(400).send({ error: "contact_info is required when notification_type is specified" });
          return;
        }
        if (notification_type === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(contact_info)) {
            reply.code(400).send({ error: "Invalid email address format for contact_info" });
            return;
          }
        } else if (notification_type === "sms") {
          const phoneRegex = /^\+?[1-9]\d{5,14}$/;
          if (!phoneRegex.test(contact_info)) {
            reply.code(400).send({ error: "Invalid phone number format for contact_info" });
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

      try {
        await lockEscrow({
          contractId: ESCROW_CONTRACT_ID,
          tradeId,
          seller,
          buyer,
          amountStroops: BigInt(amount_stroops),
          secretHashHex: secret_hash,
          timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
        });
      } catch (err) {
        req.log.error(err, "lockEscrow failed");
        reply.code(502).send({
          error: "escrow lock failed",
          detail: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
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
        createdAt: new Date().toISOString(),
        notificationType: notification_type,
        contactInfo: contact_info,
      });

      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      reply.code(201).send({
        claim_url: `${baseUrl}/claim/${tradeId}`,
        qr_payload: qrPayload,
        instructions: "Show this QR to the cash provider to receive your cash.",
      });
    }
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
        reply.code(404).send({ error: "request not found" });
        return;
      }
      const { secretHex: _omit, ...safe } = record;
      return safe;
    }
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
        reply.code(404).send({ error: "request not found" });
        return;
      }
      if (record.status !== "pending_signature") {
        reply.code(409).send({ error: `request is in status ${record.status}, expected pending_signature` });
        return;
      }

      const { signed_xdr } = req.body ?? {};
      if (!signed_xdr) {
        reply.code(400).send({ error: "signed_xdr is required" });
        return;
      }

      try {
        const result = await submitSignedTransaction(signed_xdr);
        updateStatus(record.id, "locked");

        const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
        reply.code(200).send({
          id: record.id,
          status: "locked",
          transaction_hash: result.hash,
          claim_url: `${baseUrl}/claim/${record.id}`,
          qr_payload: record.qrPayload,
          instructions: "Show this QR to the cash provider to receive your cash.",
        });
      } catch (err) {
        req.log.error(err, "submitSignedTransaction failed");
        reply.code(502).send({ error: "transaction submission failed", detail: String(err) });
        return;
      }
    }
  );

  app.post<{ Params: { id: string }; Body: { secret?: string; signed_xdr?: string } }>(
    "/cash/request/:id/release",
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
        reply
      );
      if (!releaseBody) return;

      const { secret, signed_xdr } = releaseBody;

      if (signed_xdr) {
        try {
          await submitReleaseTx(signed_xdr);
        } catch (err) {
          req.log.error(err, "submitReleaseTx failed");
          reply.code(502).send({ error: "release submission failed", detail: String(err) });
          return;
        }
      } else if (secret) {
        try {
          await releaseEscrow({
            contractId: record.contractId,
            tradeId: record.id,
            secretHex: secret,
          });
        } catch (err) {
          req.log.error(err, "releaseEscrow failed");
          reply.code(502).send({ error: "escrow release failed", detail: String(err) });
          return;
        }
      } else {
        reply.code(400).send({ error: "either secret or signed_xdr is required" });
        return;
      }

      updateStatus(record.id, "released");
      notifyTradeStatus(record.id, "released");
      await sendNotification(record, "released");
      return { id: record.id, status: "released" };
    }
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
        reply.code(404).send({ error: "request not found" });
        return;
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const refundBody = parseBody(
        z.object({ signed_xdr: z.string().trim().min(1).optional() }),
        req.body ?? {},
        reply
      );
      if (!refundBody) return;

      if (refundBody.signed_xdr) {
        try {
          await submitRefundTx(refundBody.signed_xdr);
        } catch (err) {
          req.log.error(err, "submitRefundTx failed");
          reply.code(502).send({ error: "refund submission failed", detail: String(err) });
          return;
        }
      } else {
        try {
          await refundEscrow({
            contractId: record.contractId,
            tradeId: record.id,
          });
        } catch (err) {
          req.log.error(err, "refundEscrow failed");
          reply.code(502).send({ error: "escrow refund failed", detail: String(err) });
          return;
        }
      }

      updateStatus(record.id, "refunded");
      notifyTradeStatus(record.id, "refunded");
      await sendNotification(record, "refunded");

      sendRefundAlert({
        tradeId: record.id,
        amountStroops: record.amountStroops,
        buyer: record.buyer,
        seller: record.seller,
      });

      return { id: record.id, status: "refunded" };
    }
  );
}