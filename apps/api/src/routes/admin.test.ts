import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCashRequest } from "../lib/store.js";
import {
  clearRateLimitViolations,
  getRateLimitViolations,
  recordRateLimitViolation,
} from "../lib/rate-limit-violations.js";

vi.mock("../lib/stellar.js", () => ({
  refundEscrow: vi.fn(),
  resolveEscrow: vi.fn(),
  submitRefundTx: vi.fn(),
}));

vi.mock("./chat.js", () => ({ notifyTradeStatus: vi.fn() }));

import { adminRoutes } from "./admin.js";

describe("admin abuse-prevention endpoints", () => {
  const adminKey = "test-admin-key";

  beforeEach(() => {
    process.env.ADMIN_API_KEY = adminKey;
    clearRateLimitViolations();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  async function buildApp() {
    const app = Fastify();
    await app.register(adminRoutes, { prefix: "/api/v1" });
    await app.ready();
    return app;
  }

  it("protects the rate-limit violation list with existing admin auth", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/rate-limit-violations",
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists persisted rate-limit violations newest first", async () => {
    recordRateLimitViolation({
      identifier: "198.51.100.1",
      route: "/older",
      method: "GET",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    recordRateLimitViolation({
      identifier: "198.51.100.2",
      route: "/newer",
      method: "POST",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/rate-limit-violations",
      headers: { "x-admin-api-key": adminKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((item: { route: string }) => item.route)).toEqual([
      "/newer",
      "/older",
    ]);
    await app.close();
  });

  it("resolves a violation idempotently and updates the underlying record", async () => {
    const violation = recordRateLimitViolation({
      identifier: "198.51.100.3",
      route: "/api/v1/cash/request",
      method: "POST",
    });
    const app = await buildApp();
    const request = {
      method: "POST" as const,
      url: `/api/v1/admin/rate-limit-violations/${violation.id}/resolve`,
      headers: {
        "x-admin-api-key": adminKey,
        "x-admin-operator-name": "Ada",
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ status: "resolved", resolved_by: "Ada" });
    expect(getRateLimitViolations()[0]).toMatchObject({
      status: "resolved",
      resolvedBy: "Ada",
    });
    await app.close();
  });

  it("keeps the existing fraud dismiss action idempotent", async () => {
    const tradeId = `flagged-${Date.now()}`;
    saveCashRequest({
      id: tradeId,
      contractId: "contract",
      seller: "seller",
      buyer: "buyer",
      amountStroops: "100",
      secretHex: "secret",
      secretHashHex: "hash",
      qrPayload: "qr",
      status: "locked",
      createdAt: new Date().toISOString(),
    });
    const app = await buildApp();
    const request = {
      method: "POST" as const,
      url: `/api/v1/admin/trades/${tradeId}/flag`,
      headers: { "x-admin-api-key": adminKey },
      payload: { suspicious: false },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ id: tradeId, is_suspicious: false });
    await app.close();
  });
});
