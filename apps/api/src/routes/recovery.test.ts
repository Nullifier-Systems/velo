import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { recoveryRoutes } from "./recovery";
import * as store from "../lib/store.js";
import * as recovery from "../lib/recovery.js";

// Mock implementations for testing
vi.mock("../lib/store.js");
vi.mock("../lib/recovery.js");

describe("recovery routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.register(recoveryRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /recovery/request/:id/secret", () => {
    it("returns 404 when cash request not found", async () => {
      vi.mocked(store.getCashRequest).mockReturnValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/missing/secret",
        payload: {
          recovery_method: "email",
          contact_info: "user@example.com",
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toHaveProperty("error", "claim not found");
    });

    it("returns 400 when recovery not available on claim", async () => {
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        // No recovery fields
      } as any);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
          contact_info: "user@example.com",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("recovery_not_available");
    });

    it("returns 410 when recovery token has expired", async () => {
      const expiredDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: expiredDate,
      } as any);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
          contact_info: "user@example.com",
        },
      });

      expect(response.statusCode).toBe(410);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("recovery_token_expired");
    });

    it("returns 400 when contact_info required but not provided for email recovery", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
        recoveryAttempts: 0,
      } as any);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("contact_info is required for email/sms recovery");
    });

    it("returns 403 when contact info doesn't match stored hash for email recovery", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
        recoveryContactHash: "expected_hash",
        recoveryAttempts: 0,
      } as any);

      vi.mocked(recovery.hashContactInfo).mockReturnValue("different_hash");

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
          contact_info: "wrong@example.com",
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("recovery_challenge_failed");
    });

    it("returns 429 when too many recovery attempts", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const recentAttempt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
        recoveryContactHash: "hash",
        recoveryAttempts: 3,
        lastRecoveryAttemptAt: recentAttempt,
      } as any);

      vi.mocked(recovery.hashContactInfo).mockReturnValue("hash");
      vi.mocked(recovery.validateRecoveryAttempt).mockReturnValue({
        allowed: false,
        reason: "Too many recovery attempts. Try again in 120 minutes.",
      });

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
          contact_info: "user@example.com",
        },
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("too_many_recovery_attempts");
      expect(body.detail).toContain("Try again");
    });

    it("successfully processes email recovery request", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const record = {
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
        recoveryContactHash: "hash",
        recoveryAttempts: 0,
      } as any;

      vi.mocked(store.getCashRequest).mockReturnValue(record);
      vi.mocked(recovery.hashContactInfo).mockReturnValue("hash");
      vi.mocked(recovery.validateRecoveryAttempt).mockReturnValue({ allowed: true });

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "email",
          contact_info: "user@example.com",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("recovery_link_sent");
    });

    it("successfully processes signature recovery request", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const record = {
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
        recoveryAttempts: 0,
      } as any;

      vi.mocked(store.getCashRequest).mockReturnValue(record);
      vi.mocked(recovery.validateRecoveryAttempt).mockReturnValue({ allowed: true });

      const response = await app.inject({
        method: "POST",
        url: "/recovery/request/test/secret",
        payload: {
          recovery_method: "signature",
          signature: "SIGNATURE_DATA",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("signature_verified");
    });
  });

  describe("POST /recovery/verify/:id", () => {
    it("returns 404 when cash request not found", async () => {
      vi.mocked(store.getCashRequest).mockReturnValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/verify/missing",
        payload: {
          token: "valid_token",
          challenge: "challenge",
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("claim not found");
    });

    it("returns 410 when recovery token has expired", async () => {
      const expiredDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: expiredDate,
      } as any);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/verify/test",
        payload: {
          token: "token",
          challenge: "challenge",
        },
      });

      expect(response.statusCode).toBe(410);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("recovery_token_expired");
    });

    it("returns 403 when token or challenge is invalid", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
      } as any);

      vi.mocked(recovery.decryptRecoveryToken).mockReturnValue(null);

      const response = await app.inject({
        method: "POST",
        url: "/recovery/verify/test",
        payload: {
          token: "wrong_token",
          challenge: "wrong_challenge",
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("invalid_recovery_token");
    });

    it("returns 403 when decrypted token doesn't match provided token", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(store.getCashRequest).mockReturnValue({
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
      } as any);

      vi.mocked(recovery.decryptRecoveryToken).mockReturnValue("different_token");

      const response = await app.inject({
        method: "POST",
        url: "/recovery/verify/test",
        payload: {
          token: "provided_token",
          challenge: "challenge",
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("invalid_recovery_token");
    });

    it("successfully verifies recovery token", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const record = {
        id: "test",
        contractId: "CONTRACT",
        seller: "SELLER",
        buyer: "BUYER",
        amountStroops: "1000000",
        secretHex: "",
        secretHashHex: "hash",
        qrPayload: "payload",
        status: "locked",
        createdAt: new Date().toISOString(),
        recoveryEncryptedToken: "encrypted",
        recoveryTokenExpiresAt: futureDate,
      } as any;

      vi.mocked(store.getCashRequest).mockReturnValue(record);
      vi.mocked(recovery.decryptRecoveryToken).mockReturnValue("valid_token");

      const response = await app.inject({
        method: "POST",
        url: "/recovery/verify/test",
        payload: {
          token: "valid_token",
          challenge: "challenge",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("recovery_verified");
      expect(body).toHaveProperty("claim_url");
    });
  });
});
