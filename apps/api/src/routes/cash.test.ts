import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";

vi.mock("../lib/stellar.js", () => ({
  lockEscrow: vi.fn().mockResolvedValue(undefined),
  releaseEscrow: vi.fn().mockResolvedValue(undefined),
  refundEscrow: vi.fn().mockResolvedValue(undefined),
}));

describe("cashRoutes", () => {
  const registerApp = (app: any) => {
    app.decorate("requirePayment", async (req: any, reply: any, priceUsdc: string) => {
      const payment = req.headers["x-payment"];
      if (!payment) {
        reply.code(402).send({
          challenge: {
            amount_usdc: priceUsdc,
            pay_to: process.env.MERCHANT_ADDRESS ?? "G...SET_ME",
            memo: "velo:request",
          },
        });
        return false;
      }
      return true;
    });

    app.register(cashRoutes, { prefix: "/api/v1" });
  };

  it("returns a payment challenge when no payment header is present", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/cash/agents" });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      challenge: {
        amount_usdc: "0.001",
      },
    });

    await app.close();
  });

  it("rejects malformed cash request bodies with a 400 response", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "not-a-stellar-address",
        buyer: "G123",
        amount_stroops: "not-a-number",
        secret_hash: "abc",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
    });

    await app.close();
  });

  it("returns English instructions by default when creating cash request", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount_stroops: "10000000",
        secret_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.instructions).toBe("Show this QR to the cash provider to receive your cash.");

    await app.close();
  });

  it("returns Spanish instructions when lang=es is supplied in query", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      query: { lang: "es" },
      headers: { "x-payment": "test" },
      payload: {
        seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount_stroops: "10000000",
        secret_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.instructions).toBe("Muestra este QR al proveedor de efectivo para recibir tu efectivo.");

    await app.close();
  });
});
