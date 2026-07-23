import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { providerRoutes } from "./provider.js";
import { adminRoutes } from "./admin.js";
import { getProviderByAddress } from "../lib/store.js";
import { saveCashRequest, CashRequestRecord } from "../lib/store.js";

describe("providerRoutes", () => {
  const registerApp = (app: any) => {
    app.register(providerRoutes, { prefix: "/api/v1" });
  };

  it("returns 401 when x-provider-address header is missing", async () => {
    const app = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/provider/export"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized: Missing x-provider-address header" });
    await app.close();
  });

  it("exports completed trades as CSV when format=csv is set", async () => {
    const app = Fastify();
    registerApp(app);

    const providerAddress = "G_PROVIDER_TEST_CSV";

    // Save a sample completed trade (released)
    const trade: CashRequestRecord = {
      id: "abc123csv",
      contractId: "contract123",
      seller: providerAddress,
      buyer: "buyer123",
      amountStroops: "10000000", // 1.00 USDC
      secretHex: "secret123",
      secretHashHex: "hash123",
      qrPayload: "qr123",
      status: "released",
      createdAt: new Date().toISOString()
    };
    saveCashRequest(trade);

    // Save a non-completed trade (locked) which shouldn't be in the export
    const lockedTrade: CashRequestRecord = {
      id: "locked123",
      contractId: "contract123",
      seller: providerAddress,
      buyer: "buyer123",
      amountStroops: "50000000",
      secretHex: "secret123",
      secretHashHex: "hash123",
      qrPayload: "qr123",
      status: "locked",
      createdAt: new Date().toISOString()
    };
    saveCashRequest(lockedTrade);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/provider/export?format=csv",
      headers: {
        "x-provider-address": providerAddress
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("completed_trades_G_PROVID.csv");
    expect(response.body).toContain("Trade ID,Buyer Address,Amount (Stroops),Amount (USDC),Status,Created At");
    expect(response.body).toContain("abc123csv");
    expect(response.body).toContain("buyer123");
    expect(response.body).toContain("10000000");
    expect(response.body).toContain("1.00");
    expect(response.body).toContain("released");
    expect(response.body).not.toContain("locked123");

    await app.close();
  });

  it("exports completed trades as JSON by default or when format=json", async () => {
    const app = Fastify();
    registerApp(app);

    const providerAddress = "G_PROVIDER_TEST_JSON";

    const trade: CashRequestRecord = {
      id: "abc123json",
      contractId: "contract123",
      seller: providerAddress,
      buyer: "buyer123",
      amountStroops: "20000000", // 2.00 USDC
      secretHex: "secret123",
      secretHashHex: "hash123",
      qrPayload: "qr123",
      status: "released",
      createdAt: new Date().toISOString()
    };
    saveCashRequest(trade);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/provider/export?format=json",
      headers: {
        "x-provider-address": providerAddress
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toContain("completed_trades_G_PROVID.json");
    
    const payload = response.json();
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: "abc123json",
      buyer: "buyer123",
      amount_stroops: "20000000",
      amount_usdc: "2.00",
      status: "released"
    });

    await app.close();
  });

  it("registers a new provider with valid inputs", async () => {
    const app = Fastify();
    registerApp(app);

    const validAddress = "G89DhpGrErixM8KWnBMFtmksuYyUCdKATotri57YxZzkdVaRPaXvaQGN";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/provider/register",
      payload: {
        stellar_address: validAddress,
        name: "Test Provider Shop",
        lat: 19.4326,
        lng: -99.1332,
        rate: 1.05,
        availability: "available"
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.stellar_address).toBe(validAddress);
    expect(body.name).toBe("Test Provider Shop");
    expect(body.rate).toBe(1.05);
    expect(body.availability).toBe("available");
    expect(body.verification_status).toBe("pending");
    expect(getProviderByAddress(validAddress)?.kycStatus).toBe("pending");

    await app.close();
  });

  it("rejects provider registration with invalid Stellar address", async () => {
    const app = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/provider/register",
      payload: {
        stellar_address: "INVALID_STELLAR_ADDRESS",
        name: "Invalid Shop",
        lat: 19.4326,
        lng: -99.1332,
        rate: 1.0
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Validation failed");
    await app.close();
  });

  it("rejects provider registration with out-of-range rate", async () => {
    const app = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/provider/register",
      payload: {
        stellar_address: "G89DhpGrErixM8KWnBMFtmksuYyUCdKATotri57YxZzkdVaRPaXvaQGN",
        name: "Out of range rate shop",
        lat: 19.4326,
        lng: -99.1332,
        rate: 150.0 // Exceeds max rate 100.0
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Validation failed");
    await app.close();
  });

  it("uploads a valid verification document and rejects spoofed images", async () => {
    const app = Fastify();
    registerApp(app);
    const address = "GAVZLKC6ZV3K6GX7VAW3JXGJH2JAWQJMD5KFEFQJTYLZTKXOK5YQY3AI";
    await app.inject({
      method: "POST",
      url: "/api/v1/provider/register",
      payload: { stellar_address: address, name: "Document Shop", lat: 1, lng: 2, rate: 1 },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/provider/verification-document",
      headers: { "x-provider-address": address, "content-type": "image/png" },
      payload: Buffer.from("not an image"),
    });
    expect(invalid.statusCode).toBe(415);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/provider/verification-document",
      headers: { "x-provider-address": address, "x-file-name": "identity.png", "content-type": "image/png" },
      payload: png,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({
      file_name: "identity.png",
      verification_status: "pending",
      size_bytes: png.length,
    });
    await app.close();
  });

  it("excludes pending providers until an administrator approves them", async () => {
    process.env.ADMIN_API_KEY = "provider-review-test";
    const app = Fastify();
    registerApp(app);
    app.register(adminRoutes, { prefix: "/api/v1" });
    const address = "GCG5UQF4Z3BLRB4C7YQYFPE3NZYUXA67HYRGX5R4TKHQOSWE2SNY2UQP";
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/provider/register",
      payload: { stellar_address: address, name: "Approval Shop", lat: 3, lng: 4, rate: 1 },
    });
    const providerId = registration.json().id;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    await app.inject({
      method: "POST",
      url: "/api/v1/provider/verification-document",
      headers: { "x-provider-address": address, "content-type": "image/png" },
      payload: png,
    });

    const before = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(before.json().providers.some((provider: { id: string }) => provider.id === providerId)).toBe(false);

    const invalidReview = await app.inject({
      method: "POST",
      url: `/api/v1/admin/providers/${providerId}/verification`,
      headers: { "x-admin-api-key": "provider-review-test" },
      payload: { status: "pending" },
    });
    expect(invalidReview.statusCode).toBe(400);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/providers/${providerId}/verification`,
      headers: { "x-admin-api-key": "provider-review-test" },
      payload: { status: "approved" },
    });
    expect(approved.statusCode).toBe(200);
    expect(getProviderByAddress(address)?.kycStatus).toBe("approved");

    const after = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(after.json().providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: providerId, verification_status: "approved" }),
    ]));
    delete process.env.ADMIN_API_KEY;
    await app.close();
  });

  describe("POST /provider/payout-settings", () => {
    it("returns 401 when x-provider-address header is missing", async () => {
      const app = Fastify();
      registerApp(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/provider/payout-settings",
        payload: { payout_mode: "batched" },
      });

      expect(response.statusCode).toBe(401);
      await app.close();
    });

    it("rejects an invalid payout_mode", async () => {
      const app = Fastify();
      registerApp(app);
      const providerAddress = "G89DhpGrErixM8KWnBMFtmksuYyUCdKATotri57YxZzkdVaRPaXvaQGN";

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/provider/payout-settings",
        headers: { "x-provider-address": providerAddress },
        payload: { payout_mode: "sometimes" },
      });

      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("returns 404 for an address with no registered provider", async () => {
      const app = Fastify();
      registerApp(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/provider/payout-settings",
        headers: { "x-provider-address": "G2RMx5BpwMMtD2xoS5WtysX8TLYSeuztbTwRsjdJZkQbaq21GGhnJVLJ" },
        payload: { payout_mode: "batched" },
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("opts a registered provider into batched payouts", async () => {
      const app = Fastify();
      registerApp(app);
      const providerAddress = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWCDH";

      await app.inject({
        method: "POST",
        url: "/api/v1/provider/register",
        payload: {
          stellar_address: providerAddress,
          name: "Batching Test Shop",
          lat: 19.4326,
          lng: -99.1332,
          rate: 1.0,
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/provider/payout-settings",
        headers: { "x-provider-address": providerAddress },
        payload: { payout_mode: "batched" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        stellar_address: providerAddress,
        payout_mode: "batched",
      });

      await app.close();
    });
  });
});
