import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { providerRoutes } from "./provider.js";
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

    const validAddress = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWCDH";
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
        stellar_address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWCDH",
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
});
