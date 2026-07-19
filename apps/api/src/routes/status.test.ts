import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { statusRoutes } from "./status.js";
import { saveCashRequest } from "../lib/store.js";

describe("GET /api/v1/status", () => {
  it("returns api/chain/recent_activity with no sensitive fields", async () => {
    saveCashRequest({
      id: "aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111",
      contractId: "C...TEST",
      seller: "GSELLER...",
      buyer: "GBUYER...",
      amountStroops: "10000000",
      secretHex: "deadbeef",
      secretHashHex: "cafebabe",
      qrPayload: "velo://claim?request_id=aaaabbbbccccddddeeeeffff00001111aaaabbbbccccddddeeeeffff00001111&contract=C...TEST",
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
    expect(["healthy", "unreachable"]).toContain(body.chain.status);
    expect(Array.isArray(body.recent_activity)).toBe(true);

    const entry = body.recent_activity.find((a: any) => a.status === "locked");
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      id: expect.any(String),
      status: "locked",
      createdAt: expect.any(String),
    });
    // No seller/buyer/amount/secret material should ever leak through.
    expect(entry.seller).toBeUndefined();
    expect(entry.buyer).toBeUndefined();
    expect(entry.amountStroops).toBeUndefined();
    expect(entry.secretHex).toBeUndefined();
    expect(entry.secretHashHex).toBeUndefined();

    await app.close();
  });
});
