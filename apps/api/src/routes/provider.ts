import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getProviderTrades, saveProvider, getProviders, ProviderRecord } from "../lib/store.js";
import { toPublicProvider, DEFAULT_PRECISION } from "../utils/privacy.js";

const registerProviderSchema = z.object({
  stellar_address: z.string().trim().regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/, "Invalid Stellar address format"),
  name: z.string().trim().min(1, "Name is required"),
  lat: z.number().min(-90, "Latitude must be >= -90").max(90, "Latitude must be <= 90"),
  lng: z.number().min(-180, "Longitude must be >= -180").max(180, "Longitude must be <= 180"),
  rate: z.number().min(0.01, "Rate must be at least 0.01").max(100.0, "Rate cannot exceed 100.0"),
  availability: z.enum(["available", "unavailable"]).optional().default("available"),
});

async function handleProviderRegistration(req: FastifyRequest, reply: FastifyReply, app: FastifyInstance) {
  const body = (req.body ?? {}) as Record<string, any>;
  
  const rawAddress = body.stellar_address || body.stellarAddress || body.address;
  const rawName = body.name;
  const rawLat = body.lat !== undefined ? Number(body.lat) : (body.latitude !== undefined ? Number(body.latitude) : NaN);
  const rawLng = body.lng !== undefined ? Number(body.lng) : (body.longitude !== undefined ? Number(body.longitude) : NaN);
  const rawRate = body.rate !== undefined ? Number(body.rate) : NaN;
  const rawAvailability = body.availability || body.status || "available";

  const normalized = {
    stellar_address: rawAddress,
    name: rawName,
    lat: rawLat,
    lng: rawLng,
    rate: rawRate,
    availability: rawAvailability,
  };

  const parsed = registerProviderSchema.safeParse(normalized);
  if (!parsed.success) {
    const errorDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(", ");
    reply.code(400).send({
      error: "Validation failed",
      detail: errorDetail,
    });
    return;
  }

  const { stellar_address, name, lat, lng, rate, availability } = parsed.data;
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  let dbRecord: any = null;
  if ((app as any).pg) {
    try {
      const query = `
        INSERT INTO providers (id, stellar_address, name, latitude, longitude, rate, availability, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id, stellar_address, name, latitude, longitude, rate, availability, created_at;
      `;
      const { rows } = await (app as any).pg.query(query, [id, stellar_address, name, lat, lng, rate, availability]);
      if (rows && rows.length > 0) {
        dbRecord = rows[0];
      }
    } catch (err) {
      req.log.error(err, "Failed to insert provider record into database");
    }
  }

  const providerRecord: ProviderRecord = {
    id,
    stellarAddress: stellar_address,
    name,
    lat,
    lng,
    tier: "Probationary",
    rate: String(rate),
    status: availability,
    availability,
    kycStatus: "pending",
    createdAt,
  };

  saveProvider(providerRecord);

  reply.code(201).send({
    id,
    stellar_address,
    name,
    lat,
    lng,
    rate,
    availability,
    status: availability,
    created_at: createdAt,
    ...(dbRecord ? { db_persisted: true } : {}),
  });
}

/**
 * Provider routes — dashboard, export, registration, and directory
 */
export async function providerRoutes(app: FastifyInstance) {
  // POST /provider/register & POST /providers/register — Provider Onboarding (Issue #44)
  app.post("/provider/register", async (req, reply) => handleProviderRegistration(req, reply, app));
  app.post("/providers/register", async (req, reply) => handleProviderRegistration(req, reply, app));

  // GET /providers — List registered providers.
  // The public directory never exposes exact coordinates: each provider is
  // generalized to a coarse geohash cell (issue #216). Exact location is only
  // available via the reveal-on-match path once an escrow is locked.
  app.get("/providers", async (req, reply) => {
    let records: ProviderRecord[] = [];
    if ((app as any).pg) {
      try {
        const { rows } = await (app as any).pg.query("SELECT * FROM providers ORDER BY created_at DESC");
        records = rows.map((r: any) => ({
          id: r.id,
          stellarAddress: r.stellar_address,
          name: r.name,
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          tier: r.tier ?? "Probationary",
          rate: String(r.rate),
          status: r.availability ?? "available",
          kycStatus: r.kyc_status ?? "pending",
          createdAt: r.created_at,
        }));
      } catch (err) {
        req.log.error(err, "Failed to fetch providers from database");
        records = getProviders();
      }
    } else {
      records = getProviders();
    }
    return reply.send({ providers: records.map((p) => toPublicProvider(p, undefined, DEFAULT_PRECISION)) });
  });

  app.get("/provider/dashboard", async (req, reply) => {
    // Authentication: For MVP, we trust the x-provider-address header.
    // TODO: Verify SEP-10 or ed25519 signature to strictly ensure this is the provider's own address.
    const providerAddress = req.headers["x-provider-address"];
    
    if (!providerAddress || typeof providerAddress !== "string") {
      reply.code(401).send({ error: "Unauthorized: Missing x-provider-address header" });
      return;
    }

    const allTrades = getProviderTrades(providerAddress);
    
    // Calculate total volume from released/completed trades
    const completedTrades = allTrades.filter(t => t.status === "released");
    
    let totalStroops = 0n;
    for (const trade of completedTrades) {
      totalStroops += BigInt(trade.amountStroops);
    }
    
    // For MVP, assume a fixed 1% fee earned by the provider
    const totalVolume = Number(totalStroops) / 10000000;
    const feesEarned = totalVolume * 0.01;

    return {
      address: providerAddress,
      metrics: {
        total_trades: completedTrades.length,
        total_volume_usdc: totalVolume.toFixed(2),
        fees_earned_usdc: feesEarned.toFixed(2),
      },
      trades: allTrades.map(t => ({
        id: t.id,
        buyer: t.buyer,
        amount_stroops: t.amountStroops,
        status: t.status,
        created_at: t.createdAt
      })).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    };
  });

  app.get("/provider/export", async (req, reply) => {
    const providerAddress = req.headers["x-provider-address"];
    
    if (!providerAddress || typeof providerAddress !== "string") {
      reply.code(401).send({ error: "Unauthorized: Missing x-provider-address header" });
      return;
    }

    const allTrades = getProviderTrades(providerAddress);
    const completedTrades = allTrades.filter(t => t.status === "released");
    const format = (req.query as any).format;

    if (format === "csv") {
      const headers = ["Trade ID", "Buyer Address", "Amount (Stroops)", "Amount (USDC)", "Status", "Created At"];
      const csvContent = [
        headers.join(","),
        ...completedTrades.map(t => [
          t.id,
          t.buyer,
          t.amountStroops,
          (Number(t.amountStroops) / 10000000).toFixed(2),
          t.status,
          t.createdAt
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(","))
      ].join("\n");

      reply
        .header("Content-Type", "text/csv")
        .header("Content-Disposition", `attachment; filename="completed_trades_${providerAddress.substring(0, 8)}.csv"`)
        .send(csvContent);
      return;
    }

    // Default or explicit JSON format
    const jsonOutput = completedTrades.map(t => ({
      id: t.id,
      buyer: t.buyer,
      amount_stroops: t.amountStroops,
      amount_usdc: (Number(t.amountStroops) / 10000000).toFixed(2),
      status: t.status,
      created_at: t.createdAt
    }));

    reply
      .header("Content-Type", "application/json")
      .header("Content-Disposition", `attachment; filename="completed_trades_${providerAddress.substring(0, 8)}.json"`)
      .send(jsonOutput);
  });
}

