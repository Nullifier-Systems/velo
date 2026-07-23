import { describe, it, expect, beforeEach } from "vitest";
import {
  generateRecoveryToken,
  hashContactInfo,
  encryptRecoveryToken,
  decryptRecoveryToken,
  validateRecoveryAttempt,
  validateRecoveryTokenExpiry,
  computeTokenExpiration,
} from "./recovery";

describe("recovery", () => {
  describe("generateRecoveryToken", () => {
    it("generates a 64-character hex string (256 bits)", () => {
      const token = generateRecoveryToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(token.length).toBe(64);
    });

    it("generates unique tokens on each call", () => {
      const token1 = generateRecoveryToken();
      const token2 = generateRecoveryToken();
      expect(token1).not.toBe(token2);
    });
  });

  describe("hashContactInfo", () => {
    it("returns null when both email and phone are undefined", () => {
      expect(hashContactInfo(undefined, undefined)).toBeNull();
    });

    it("hashes email addresses to 32-character hex", () => {
      const email = "user@example.com";
      const hash = hashContactInfo(email, undefined);
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
      expect(hash?.length).toBe(32);
    });

    it("hashes phone numbers to 32-character hex", () => {
      const phone = "+1234567890";
      const hash = hashContactInfo(undefined, phone);
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
      expect(hash?.length).toBe(32);
    });

    it("normalizes email addresses (case-insensitive, trimmed)", () => {
      const email1 = "User@Example.com";
      const email2 = "user@example.com ";
      const email3 = " USER@EXAMPLE.COM";
      
      const hash1 = hashContactInfo(email1, undefined);
      const hash2 = hashContactInfo(email2, undefined);
      const hash3 = hashContactInfo(email3, undefined);
      
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("produces different hashes for different inputs", () => {
      const hash1 = hashContactInfo("user1@example.com", undefined);
      const hash2 = hashContactInfo("user2@example.com", undefined);
      expect(hash1).not.toBe(hash2);
    });

    it("prefers email over phone if both are provided", () => {
      const hash1 = hashContactInfo("user@example.com", "+1234567890");
      const hash2 = hashContactInfo("user@example.com", undefined);
      expect(hash1).toBe(hash2);
    });
  });

  describe("encryptRecoveryToken and decryptRecoveryToken", () => {
    let token: string;
    let challenge: string;

    beforeEach(() => {
      token = generateRecoveryToken();
      challenge = "user@example.com";
    });

    it("encrypts and decrypts a token successfully", () => {
      const encrypted = encryptRecoveryToken(token, challenge);
      const decrypted = decryptRecoveryToken(encrypted, challenge);
      expect(decrypted).toBe(token);
    });

    it("returns null when decrypting with wrong challenge", () => {
      const encrypted = encryptRecoveryToken(token, challenge);
      const decrypted = decryptRecoveryToken(encrypted, "wrong@example.com");
      expect(decrypted).toBeNull();
    });

    it("returns null when decrypting malformed ciphertext", () => {
      const decrypted = decryptRecoveryToken("invalid json", challenge);
      expect(decrypted).toBeNull();
    });

    it("returns null when decrypting with corrupted payload", () => {
      const encrypted = encryptRecoveryToken(token, challenge);
      const payload = JSON.parse(encrypted);
      payload.ciphertext = "corrupted";
      const corrupted = JSON.stringify(payload);
      const decrypted = decryptRecoveryToken(corrupted, challenge);
      expect(decrypted).toBeNull();
    });

    it("produces different ciphertexts for the same token (due to random IV)", () => {
      const encrypted1 = encryptRecoveryToken(token, challenge);
      const encrypted2 = encryptRecoveryToken(token, challenge);
      expect(encrypted1).not.toBe(encrypted2);
      // But both should decrypt to the same token
      expect(decryptRecoveryToken(encrypted1, challenge)).toBe(token);
      expect(decryptRecoveryToken(encrypted2, challenge)).toBe(token);
    });

    it("supports custom salt", () => {
      const encrypted = encryptRecoveryToken(token, challenge, "custom-salt");
      const decrypted = decryptRecoveryToken(encrypted, challenge, "custom-salt");
      expect(decrypted).toBe(token);
    });

    it("fails if salt doesn't match during decryption", () => {
      const encrypted = encryptRecoveryToken(token, challenge, "salt1");
      const decrypted = decryptRecoveryToken(encrypted, challenge, "salt2");
      expect(decrypted).toBeNull();
    });
  });

  describe("validateRecoveryAttempt", () => {
    it("allows first attempt when lastAttemptAt is undefined", () => {
      const result = validateRecoveryAttempt(undefined, 0, 3);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("allows attempt when less than max allowed within 24 hours", () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryAttempt(oneHourAgo, 1, 3);
      expect(result.allowed).toBe(true);
    });

    it("rejects attempt when max attempts reached within 24 hours", () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryAttempt(oneHourAgo, 3, 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Too many recovery attempts");
      expect(result.reason).toContain("24");
    });

    it("resets counter when more than 24 hours have passed", () => {
      const dayAndAHalfAgo = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryAttempt(dayAndAHalfAgo, 3, 3);
      expect(result.allowed).toBe(true);
    });

    it("provides reason message with estimated time until reset", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryAttempt(twoHoursAgo, 3, 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("minutes");
      // Should have approximately 22 hours left (24 - 2)
      expect(result.reason).toContain("120");
    });
  });

  describe("validateRecoveryTokenExpiry", () => {
    it("rejects when expiresAt is undefined", () => {
      const result = validateRecoveryTokenExpiry(undefined);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expiration not set");
    });

    it("accepts when token hasn't expired", () => {
      const oneHourFromNow = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryTokenExpiry(oneHourFromNow);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("rejects when token has expired", () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryTokenExpiry(oneHourAgo);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("respects custom maxAgeHours parameter", () => {
      const oneHourFromNow = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
      const result = validateRecoveryTokenExpiry(oneHourFromNow, 0.5);
      // Token is valid for 1 hour but maxAge is 0.5 hours, so it should be expired
      expect(result.valid).toBe(false);
    });
  });

  describe("computeTokenExpiration", () => {
    it("computes expiration 24 hours from now by default", () => {
      const before = new Date();
      const expiry = computeTokenExpiration();
      const after = new Date();

      const expiryDate = new Date(expiry);
      const expectedMin = new Date(before.getTime() + 24 * 60 * 60 * 1000 - 1000);
      const expectedMax = new Date(after.getTime() + 24 * 60 * 60 * 1000 + 1000);

      expect(expiryDate.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
      expect(expiryDate.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
    });

    it("respects custom hoursFromNow parameter", () => {
      const before = new Date();
      const expiry = computeTokenExpiration(12);
      const after = new Date();

      const expiryDate = new Date(expiry);
      const expectedMin = new Date(before.getTime() + 12 * 60 * 60 * 1000 - 1000);
      const expectedMax = new Date(after.getTime() + 12 * 60 * 60 * 1000 + 1000);

      expect(expiryDate.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
      expect(expiryDate.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
    });

    it("returns an ISO timestamp string", () => {
      const expiry = computeTokenExpiration();
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Should be parseable as a date
      expect(() => new Date(expiry)).not.toThrow();
    });
  });
});
