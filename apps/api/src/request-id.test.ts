import { describe, expect, it, vi } from "vitest";

// Mock the Stellar lib so importing the app never touches the network.
vi.mock("./lib/stellar.js", () => ({
  server: {
    getTransaction: vi.fn(),
  },
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  lockEscrow: vi.fn(),
  releaseEscrow: vi.fn(),
  refundEscrow: vi.fn(),
}));

import { app } from "./app.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("request ID correlation", () => {
  it("attaches a generated request ID to every response", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });

  it("generates a distinct ID per request", async () => {
    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });

  it("honors an inbound x-request-id header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "client-supplied-id-123" },
    });
    expect(res.headers["x-request-id"]).toBe("client-supplied-id-123");
  });

  it("falls back to Vercel's x-vercel-id header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-vercel-id": "iad1::abcd-1234567890" },
    });
    expect(res.headers["x-request-id"]).toBe("iad1::abcd-1234567890");
  });

  it("prefers x-request-id over x-vercel-id when both are present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-request-id": "explicit-id",
        "x-vercel-id": "iad1::abcd-1234567890",
      },
    });
    expect(res.headers["x-request-id"]).toBe("explicit-id");
  });

  it("ignores oversized inbound IDs and generates one instead", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "x".repeat(300) },
    });
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });

  it("includes the request ID on error responses too", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/cash/request/missing" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });
});
