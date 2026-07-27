import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";

vi.mock("../lib/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stellar.js")>();
  return {
    ...actual,
    server: {
      getHealth: vi.fn().mockResolvedValue({ status: "healthy" as const, oldestLedger: 1000 }),
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
    },
  };
});

import { statusRoutes } from "./status.js";
import { saveCashRequest, clearStore } from "../lib/store.js";

describe("GET /api/v1/status", () => {
  beforeEach(() => {
    clearStore();
    vi.clearAllMocks();
  });

  it("returns api/chain/recent_activity with no sensitive fields", async () => {
    saveCashRequest({
      id: "aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111",
      contractId: "C...TEST",
      seller: "GSELLER...",
      buyer: "GBUYER...",
      amountStroops: "10000000",
      secretHex: "deadbeef",
      secretHashHex: "cafebabe",
      qrPayload: "velo://claim?request_id=aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111&secret=deadbeef",
      status: "locked",
      createdAt: new Date().toISOString(),

    });

    const app = Fastify();
    app.register(statusRoutes, { prefix: "/api/v1" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.api.status).toBe("ok");
    expect(typeof body.api.uptime_seconds).toBe("number");
    expect(body.chain.status).toBe("healthy");
    expect(body.chain.network).toBe("TESTNET");
    expect(body.chain.latest_ledger).toBe(5000);
    expect(Array.isArray(body.recent_activity)).toBe(true);

    const entry = body.recent_activity.find((a: any) => a.status === "locked");
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      id: expect.any(String),
      status: "locked",
      createdAt: expect.any(String),
    });
    expect(entry.seller).toBeUndefined();
    expect(entry.buyer).toBeUndefined();
    expect(entry.amountStroops).toBeUndefined();
    expect(entry.secretHex).toBeUndefined();
    expect(entry.secretHashHex).toBeUndefined();
    expect(entry.qrPayload).toBeUndefined();

    await app.close();
  });
});
