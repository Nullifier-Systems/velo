import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { app } from "./app.js";
import { server } from "./lib/stellar.js";

// Mock the Stellar server to avoid real network calls
vi.mock("./lib/stellar.js", () => ({
  server: {
    getTransaction: vi.fn(),
  },
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

// Mock the TransactionBuilder to return dummy objects based on the XDR we inject
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    TransactionBuilder: {
      fromXDR: vi.fn(),
    },
  };
});

import { TransactionBuilder } from "@stellar/stellar-sdk";

describe("requirePayment verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MERCHANT_ADDRESS = "GBMERCHANT";
  });

  it("fails if payment is already used (replay attack prevention)", async () => {
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    const mockReq = {
      headers: { "x-payment": "already-used-hash" },
      log: { error: vi.fn() },
    };

    // First time should pass through to getTransaction (we'll mock a success to register it)
    vi.mocked(server.getTransaction).mockResolvedValueOnce({
      status: "SUCCESS",
      envelopeXdr: "dummy-xdr",
    } as any);

    vi.mocked(TransactionBuilder.fromXDR).mockReturnValueOnce({
      memo: { value: "velo:request" },
      operations: [
        { type: "payment", destination: "GBMERCHANT", amount: "10.0" }
      ],
    } as any);

    const firstCall = await (app as any).requirePayment(mockReq, mockReply, "1.0");
    expect(firstCall).toBe(true);

    // Second time with same hash should fail immediately
    const secondCall = await (app as any).requirePayment(mockReq, mockReply, "1.0");
    expect(secondCall).toBe(false);
    expect(mockReply.code).toHaveBeenCalledWith(402);
    expect(mockReply.send).toHaveBeenCalledWith({ error: "Payment already used" });
  });

  it("fails if transaction has wrong memo", async () => {
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    const mockReq = {
      headers: { "x-payment": "wrong-memo-hash" },
      log: { error: vi.fn() },
    };

    vi.mocked(server.getTransaction).mockResolvedValueOnce({
      status: "SUCCESS",
      envelopeXdr: "dummy-xdr",
    } as any);

    vi.mocked(TransactionBuilder.fromXDR).mockReturnValueOnce({
      memo: { value: "wrong:memo" },
      operations: [
        { type: "payment", destination: "GBMERCHANT", amount: "10.0" }
      ],
    } as any);

    const result = await (app as any).requirePayment(mockReq, mockReply, "1.0");
    expect(result).toBe(false);
    expect(mockReply.code).toHaveBeenCalledWith(402);
    expect(mockReply.send).toHaveBeenCalledWith({ error: "Invalid payment memo" });
  });

  it("fails if amount is insufficient", async () => {
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    const mockReq = {
      headers: { "x-payment": "insufficient-funds-hash" },
      log: { error: vi.fn() },
    };

    vi.mocked(server.getTransaction).mockResolvedValueOnce({
      status: "SUCCESS",
      envelopeXdr: "dummy-xdr",
    } as any);

    vi.mocked(TransactionBuilder.fromXDR).mockReturnValueOnce({
      memo: { value: "velo:request" },
      operations: [
        { type: "payment", destination: "GBMERCHANT", amount: "0.5" } // Less than 1.0
      ],
    } as any);

    const result = await (app as any).requirePayment(mockReq, mockReply, "1.0");
    expect(result).toBe(false);
    expect(mockReply.code).toHaveBeenCalledWith(402);
    expect(mockReply.send).toHaveBeenCalledWith({ error: "Transaction does not contain a valid payment" });
  });

  it("fails if destination is incorrect", async () => {
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    const mockReq = {
      headers: { "x-payment": "wrong-dest-hash" },
      log: { error: vi.fn() },
    };

    vi.mocked(server.getTransaction).mockResolvedValueOnce({
      status: "SUCCESS",
      envelopeXdr: "dummy-xdr",
    } as any);

    vi.mocked(TransactionBuilder.fromXDR).mockReturnValueOnce({
      memo: { value: "velo:request" },
      operations: [
        { type: "payment", destination: "GBWRONG", amount: "10.0" }
      ],
    } as any);

    const result = await (app as any).requirePayment(mockReq, mockReply, "1.0");
    expect(result).toBe(false);
    expect(mockReply.code).toHaveBeenCalledWith(402);
    expect(mockReply.send).toHaveBeenCalledWith({ error: "Transaction does not contain a valid payment" });
  });
});

describe("GET /version", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns commit and timestamp", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef123456";
    process.env.DEPLOY_TIMESTAMP = "2026-01-01T12:00:00Z";

    const response = await app.inject({
      method: "GET",
      url: "/version",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      commit: "abcdef123456",
      timestamp: "2026-01-01T12:00:00Z",
    });
  });
});
