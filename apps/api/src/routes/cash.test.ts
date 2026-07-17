import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";

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

  it("paginates agents list", async () => {
    const app: any = Fastify();
    registerApp(app);

    // Get initial providers count
    const initialRes = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents",
      headers: { "x-payment": "test-tx-hash" }
    });
    expect(initialRes.statusCode).toBe(200);
    const initialAgents = initialRes.json().agents ?? [];
    const initialCount = initialAgents.length;

    // Register 5 providers
    const names = ["Agent A", "Agent B", "Agent C", "Agent D", "Agent E"];
    for (let i = 0; i < names.length; i++) {
      const regResponse = await app.inject({
        method: "POST",
        url: "/api/v1/cash/agents",
        payload: {
          name: names[i],
          lat: 10 + i,
          lng: 20 + i,
          rate: "1.0",
        },
      });
      expect(regResponse.statusCode).toBe(201);
    }

    // Now, query with limit=2, offset=initialCount + 1
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents",
      headers: { "x-payment": "test-tx-hash" },
      query: {
        limit: "2",
        offset: String(initialCount + 1),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.agents.length).toBe(2);
    expect(body.agents[0].name).toBe("Agent B");
    expect(body.agents[1].name).toBe("Agent C");
    expect(body.pagination).toEqual({
      limit: 2,
      offset: initialCount + 1,
      total: initialCount + 5,
    });

    // Query with invalid limit
    const resInvalidLimit = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents",
      headers: { "x-payment": "test-tx-hash" },
      query: { limit: "-1" },
    });
    expect(resInvalidLimit.statusCode).toBe(400);

    // Query with invalid offset
    const resInvalidOffset = await app.inject({
      method: "GET",
      url: "/api/v1/cash/agents",
      headers: { "x-payment": "test-tx-hash" },
      query: { offset: "invalid" },
    });
    expect(resInvalidOffset.statusCode).toBe(400);

    await app.close();
  });
});
