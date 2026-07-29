import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../lib/errors.js";
import { clearReputationCache } from "../lib/reputation-cache.js";
import {
  clearStore,
  saveCashRequest,
  type CashRequestRecord,
} from "../lib/store.js";
import { reputationRoutes } from "./reputation.js";

const VALID_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeTrade(
  overrides: Partial<CashRequestRecord> & Pick<CashRequestRecord, "id" | "seller" | "status">,
): CashRequestRecord {
  return {
    contractId: "CTEST",
    buyer: OTHER_ADDRESS,
    amountStroops: "10000000",
    secretHex: "aa".repeat(32),
    secretHashHex: "bb".repeat(32),
    qrPayload: "qr",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("GET /api/v1/reputation/:address", () => {
  let app: ReturnType<typeof Fastify>;
  let paymentStub: (req: any, reply: any, price: string) => Promise<boolean>;

  beforeEach(async () => {
    clearStore();
    await clearReputationCache();
    delete process.env.REDIS_URL;

    paymentStub = async (req: any, reply: any, priceUsdc: string) => {
      const payment = req.headers["x-payment"];
      if (!payment) {
        reply.code(402).send({
          challenge: {
            amount_usdc: priceUsdc,
            pay_to: "G...SET_ME",
            memo: "velo:request",
          },
        });
        return false;
      }
      return true;
    };

    app = Fastify();
    app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send(error.toJSON());
      }
      throw error;
    });
    app.decorate("requirePayment", async (req: any, reply: any, price: string) =>
      paymentStub(req, reply, price),
    );
    await app.register(reputationRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await clearReputationCache();
    clearStore();
  });

  it("returns 402 payment challenge without X-Payment", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
    });

    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      challenge: {
        amount_usdc: "0.0005",
        pay_to: "G...SET_ME",
        memo: "velo:request",
      },
    });
  });

  it("returns 400 for invalid Stellar addresses", async () => {
    const cases = ["not-an-address", "GSHORT", "C" + "A".repeat(55), "g" + "A".repeat(55)];

    for (const address of cases) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reputation/${address}`,
        headers: { "x-payment": "ok" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "INVALID_PARAMETER",
        statusCode: 400,
      });
    }
  });

  it("returns zeroed metrics for an address with no trades", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
      headers: { "x-payment": "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      address: VALID_ADDRESS,
      total_trades: 0,
      successful_claims: 0,
      completion_rate: 0,
      trusted: false,
      cached: false,
    });
  });

  it("computes completion rate and trusted flag from trade history", async () => {
    for (let i = 0; i < 9; i++) {
      saveCashRequest(
        makeTrade({
          id: `released-${i}`,
          seller: VALID_ADDRESS,
          status: "released",
        }),
      );
    }
    saveCashRequest(
      makeTrade({
        id: "refunded-0",
        seller: VALID_ADDRESS,
        status: "refunded",
      }),
    );
    // Unrelated seller must not affect metrics.
    saveCashRequest(
      makeTrade({
        id: "other-released",
        seller: OTHER_ADDRESS,
        status: "released",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
      headers: { "x-payment": "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      address: VALID_ADDRESS,
      total_trades: 10,
      successful_claims: 9,
      completion_rate: 0.9,
      trusted: true,
      cached: false,
    });
  });

  it("marks trusted false when completion rate is below 0.90", async () => {
    for (let i = 0; i < 4; i++) {
      saveCashRequest(
        makeTrade({
          id: `ok-${i}`,
          seller: VALID_ADDRESS,
          status: "released",
        }),
      );
    }
    saveCashRequest(
      makeTrade({
        id: "bad-0",
        seller: VALID_ADDRESS,
        status: "refunded",
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
      headers: { "x-payment": "ok" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total_trades: 5,
      successful_claims: 4,
      completion_rate: 0.8,
      trusted: false,
      cached: false,
    });
  });

  it("serves a cache hit within the 60s TTL", async () => {
    saveCashRequest(
      makeTrade({
        id: "cache-1",
        seller: VALID_ADDRESS,
        status: "released",
      }),
    );

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
      headers: { "x-payment": "ok" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().cached).toBe(false);
    expect(first.json().total_trades).toBe(1);

    // New trade after cache write should not appear until TTL expires.
    saveCashRequest(
      makeTrade({
        id: "cache-2",
        seller: VALID_ADDRESS,
        status: "released",
      }),
    );

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/reputation/${VALID_ADDRESS}`,
      headers: { "x-payment": "ok" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      total_trades: 1,
      successful_claims: 1,
      cached: true,
    });
  });
});
