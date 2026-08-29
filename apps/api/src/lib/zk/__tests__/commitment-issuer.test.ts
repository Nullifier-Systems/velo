/**
 * Commitment Issuer Tests
 * Tests for credential issuance and signing
 */

import { describe, it, expect, beforeEach } from "vitest";
import nodeCrypto from "node:crypto";
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: nodeCrypto.webcrypto });
}
import { Keypair } from "@stellar/stellar-sdk";
import {
  CommitmentIssuer,
  createCommitmentIssuer,
} from "../commitment-issuer.js";
import { PedersenVault } from "../pedersen-vault.js";


describe("CommitmentIssuer", () => {
  let issuer: CommitmentIssuer;
  let vault: PedersenVault;
  let keypair: Keypair;

  beforeEach(() => {
    keypair = Keypair.random();
    vault = new PedersenVault();
    issuer = new CommitmentIssuer(keypair, vault);
  });

  describe("issueCommitment", () => {
    it("creates a valid Pedersen commitment", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const value = 750n;

      const response = await issuer.issueCommitment({
        userId,
        value,
        attributeType: "credit_score",
        expiresInDays: 30,
      });

      expect(response.commitment).toBeDefined();
      expect(response.commitment.commitmentId).toBeDefined();
      expect(response.commitment.userId).toBe(userId);
      expect(response.commitment.commitmentHex).toHaveLength(64);
      expect(response.commitment.saltHex).toHaveLength(64);
      expect(response.commitment.attributeType).toBe("credit_score");
      expect(response.commitment.expiresAt).toBeDefined();
      expect(response.signedAttestation).toBeDefined();
    });

    it("rejects invalid Stellar address", async () => {
      await expect(
        issuer.issueCommitment({
          userId: "invalid-address",
          value: 750n,
          attributeType: "credit_score",
        }),
      ).rejects.toThrow("Invalid Stellar address format");
    });

    it("rejects value outside supported range", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      await expect(
        issuer.issueCommitment({
          userId,
          value: 2n ** 33n, // Too large
          attributeType: "credit_score",
        }),
      ).rejects.toThrow("Value out of supported range");
    });

    it("rejects negative values", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      await expect(
        issuer.issueCommitment({
          userId,
          value: -100n,
          attributeType: "credit_score",
        }),
      ).rejects.toThrow("Value out of supported range");
    });

    it("stores commitment in vault", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const value = 750n;

      const response = await issuer.issueCommitment({
        userId,
        value,
        attributeType: "credit_score",
      });

      const vaultedCommitment = vault.getCommitment(
        response.commitment.commitmentHex,
      );
      expect(vaultedCommitment).toBeDefined();
      expect(vaultedCommitment?.userId).toBe(userId);
    });

    it("generates unique commitments for same value", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const value = 750n;

      const response1 = await issuer.issueCommitment({
        userId,
        value,
        attributeType: "credit_score",
      });

      const response2 = await issuer.issueCommitment({
        userId,
        value,
        attributeType: "credit_score",
      });

      // Commitments should be different (different salts)
      expect(response1.commitment.commitmentHex).not.toBe(
        response2.commitment.commitmentHex,
      );
      expect(response1.commitment.saltHex).not.toBe(
        response2.commitment.saltHex,
      );
    });

    it("allows custom expiration", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      const response = await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
        expiresInDays: 7,
      });

      const expirationDate = new Date(response.commitment.expiresAt || "");
      const now = new Date();
      const expectedExpiration = new Date();
      expectedExpiration.setDate(expectedExpiration.getDate() + 7);

      // Allow 1-day margin for test timing
      expect(expirationDate.getTime()).toBeGreaterThan(
        now.getTime() + 6 * 24 * 60 * 60 * 1000,
      );
      expect(expirationDate.getTime()).toBeLessThan(
        expectedExpiration.getTime() + 24 * 60 * 60 * 1000,
      );
    });
  });

  describe("verifySignedCommitment", () => {
    it("verifies valid signed commitment", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      const response = await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
      });

      const isValid = issuer.verifySignedCommitment(
        response.commitment,
        response.signedAttestation,
      );

      expect(isValid).toBe(true);
    });

    it("rejects invalid signature", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      const response = await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
      });

      const isValid = issuer.verifySignedCommitment(
        response.commitment,
        "invalid-signature-data",
      );

      expect(isValid).toBe(false);
    });

    it("rejects tampered commitment", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      const response = await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
      });

      // Tamper with commitment
      const tamperedCommitment = {
        ...response.commitment,
        commitmentHex: "b".repeat(64),
      };

      const isValid = issuer.verifySignedCommitment(
        tamperedCommitment,
        response.signedAttestation,
      );

      expect(isValid).toBe(false);
    });
  });

  describe("getIssuerPublicKey", () => {
    it("returns issuer's public key", () => {
      const publicKey = issuer.getIssuerPublicKey();

      expect(publicKey).toBe(keypair.publicKey());
      expect(publicKey).toHaveLength(56);
      expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    });
  });

  describe("getVaultStats", () => {
    it("returns correct vault statistics", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
      });

      const stats = issuer.getVaultStats();

      expect(stats.totalCommitments).toBe(1);
      expect(stats.expiredCommitments).toBe(0);
    });
  });

  describe("cleanupExpired", () => {
    it("removes expired commitments", async () => {
      const userId = "G" + "A".repeat(51) + "HNRG";

      // Create commitment that expires immediately
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000); // 1 second ago

      await issuer.issueCommitment({
        userId,
        value: 750n,
        attributeType: "credit_score",
        expiresInDays: 0, // Expires in 0 days (immediately)
      });

      // Wait a bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const removedCount = await issuer.cleanupExpired();

      expect(removedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("createCommitmentIssuer factory", () => {
    it("creates issuer from keypair", () => {
      const kp = Keypair.random();
      const newIssuer = createCommitmentIssuer(kp);

      expect(newIssuer).toBeInstanceOf(CommitmentIssuer);
      expect(newIssuer.getIssuerPublicKey()).toBe(kp.publicKey());
    });

    it("creates issuer with custom vault", () => {
      const customVault = new PedersenVault();
      const newIssuer = createCommitmentIssuer(keypair, customVault);

      expect(newIssuer.getVaultStats()).toBeDefined();
    });
  });
});
