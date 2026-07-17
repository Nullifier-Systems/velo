import type { FastifyInstance } from "fastify";
import { CONTRACTS } from "@velo/shared";
import { lockEscrow, releaseEscrow } from "../lib/stellar.js";
import { randomHex32 } from "../lib/crypto.js";
import { saveCashRequest, getCashRequest, updateStatus, saveProvider, getProviders } from "../lib/store.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15-20 min at Stellar's ~5-6s ledger close time

interface CashRequestBody {
  seller: string; // G... address of the cash provider
  buyer: string; // G... address of the person requesting cash
  amount_stroops: string; // bigint as string, e.g. "10000000" = 1 XLM/USDC unit
  secret_hash: string; // 64-character hex string representing SHA256 of the secret
}

interface RegisterProviderBody {
  name: string;
  lat: number;
  lng: number;
  rate?: string;
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
 * POST /api/v1/cash/request       — lock funds via the escrow contract,
 *                                    return a claim_url + QR payload ($0.01)
 * GET  /api/v1/cash/request/:id   — poll a pending cash request (free)
 * POST /api/v1/cash/request/:id/release — merchant confirms hand-off,
 *                                    releases escrow using the secret
 *                                    embedded in the scanned QR (free)
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
      // Registration is free in this implementation
      const { name, lat, lng, rate } = req.body ?? ({} as RegisterProviderBody);
      if (!name || typeof lat !== "number" || typeof lng !== "number") {
          reply.code(400).send({ error: "name, lat (number), and lng (number) are required" });
          return;
      }
      
      const id = randomHex32();
      const provider = {
          id,
          name,
          lat,
          lng,
          rate: rate || "1.0",
          tier: "Standard",
          status: "available" as const,
          createdAt: new Date().toISOString()
      };
      
      saveProvider(provider);
      reply.code(201).send(provider);
  });

  app.post<{ Body: CashRequestBody }>(
    "/cash/request",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.01");
      if (!paid) return;

      const { seller, buyer, amount_stroops, secret_hash } = req.body ?? ({} as CashRequestBody);
      if (!seller || !buyer || !amount_stroops || !secret_hash) {
        reply.code(400).send({ error: "seller, buyer, amount_stroops, and secret_hash are required" });
        return;
      }

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
      saveCashRequest({
        id: tradeId,
        contractId: ESCROW_CONTRACT_ID,
        seller,
        buyer,
        amountStroops: amount_stroops,
        secretHex: "", // The API no longer knows the secret
        secretHashHex: secret_hash,
        status: "locked",
        createdAt: new Date().toISOString(),
      });

      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      reply.code(201).send({
        // The secret is held client-side and is NOT returned by the API
        claim_url: `${baseUrl}/claim/${tradeId}`,
        qr_payload: `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`,
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

  app.post<{ Params: { id: string }; Body: { secret: string } }>(
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

      const { secret } = req.body ?? {};
      if (!secret) {
        reply.code(400).send({ error: "secret is required (from the scanned QR)" });
        return;
      }

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

      updateStatus(record.id, "released");
      return { id: record.id, status: "released" };
    }
  );
}