/**
 * Pedersen Vault Tests
 * Tests for commitment storage and management
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PedersenVault,
  generateBlindingSalt,
  generatePedersenCommitment,
  verifyCommitmentConsistency,
} from "../pedersen-vault.js";

describe("Pedersen Vault", () => {
  let vault: PedersenVault;

  beforeEach(() => {
    vault = new PedersenVault();
  });

  describe("addCommitment", () => {
    it("stores a new commitment", () => {
      const commitment = "a".repeat(64);
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt = generateBlindingSalt();

      vault.addCommitment(commitment, userId, "credit_score", salt);

      const retrieved = vault.getCommitment(commitment);
      expect(retrieved).toBeDefined();
      expect(retrieved?.userId).toBe(userId);
      expect(retrieved?.salt).toBe(salt);
    });

    it("rejects duplicate commitments", () => {
      const commitment = "a".repeat(64);
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt = generateBlindingSalt();

      vault.addCommitment(commitment, userId, "credit_score", salt);

      expect(() => {
        vault.addCommitment(commitment, userId, "credit_score", salt);
      }).toThrow("already exists");
    });

    it("stores commitment with expiration", () => {
      const commitment = "a".repeat(64);
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt = generateBlindingSalt();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      vault.addCommitment(commitment, userId, "credit_score", salt, expiresAt);

      const retrieved = vault.getCommitment(commitment);
      expect(retrieved?.expiresAt).toBeDefined();
    });
  });

  describe("getCommitment", () => {
    it("retrieves stored commitment", () => {
      const commitment = "a".repeat(64);
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt = generateBlindingSalt();

      vault.addCommitment(commitment, userId, "credit_score", salt);

      const retrieved = vault.getCommitment(commitment);
      expect(retrieved?.commitmentHex).toBe(commitment);
    });

    it("returns null for nonexistent commitment", () => {
      const retrieved = vault.getCommitment("nonexistent");
      expect(retrieved).toBeNull();
    });

    it("returns null and removes expired commitment", () => {
      const commitment = "a".repeat(64);
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt = generateBlindingSalt();
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000); // Expired 1 second ago

      vault.addCommitment(commitment, userId, "credit_score", salt, expiresAt);

      const retrieved = vault.getCommitment(commitment);
      expect(retrieved).toBeNull();
    });
  });

  describe("getUserCommitments", () => {
    it("returns all commitments for a user", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      vault.addCommitment("a".repeat(64), userId, "credit_score", salt1);
      vault.addCommitment("b".repeat(64), userId, "net_worth", salt2);

      const commitments = vault.getUserCommitments(userId);
      expect(commitments).toHaveLength(2);
      expect(commitments.map((c: any) => c.commitmentHex)).toContain(
        "a".repeat(64),
      );
      expect(commitments.map((c: any) => c.commitmentHex)).toContain(
        "b".repeat(64),
      );
    });

    it("returns empty array for user with no commitments", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const commitments = vault.getUserCommitments(userId);
      expect(commitments).toHaveLength(0);
    });

    it("filters out expired commitments", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      // Active commitment
      vault.addCommitment("a".repeat(64), userId, "credit_score", salt1);

      // Expired commitment
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000);
      vault.addCommitment(
        "b".repeat(64),
        userId,
        "net_worth",
        salt2,
        expiresAt,
      );

      const commitments = vault.getUserCommitments(userId);
      expect(commitments).toHaveLength(1);
      expect(commitments[0].commitmentHex).toBe("a".repeat(64));
    });

    it("separates commitments by user", () => {
      const user1 = "G" + "A".repeat(51) + "HNRG";
      const user2 = "G" + "B".repeat(51) + "3FBT";
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      vault.addCommitment("a".repeat(64), user1, "credit_score", salt1);
      vault.addCommitment("b".repeat(64), user2, "credit_score", salt2);

      const user1Commitments = vault.getUserCommitments(user1);
      const user2Commitments = vault.getUserCommitments(user2);

      expect(user1Commitments).toHaveLength(1);
      expect(user2Commitments).toHaveLength(1);
      expect(user1Commitments[0].commitmentHex).toBe("a".repeat(64));
      expect(user2Commitments[0].commitmentHex).toBe("b".repeat(64));
    });
  });

  describe("cleanup", () => {
    it("removes expired commitments", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      vault.addCommitment("a".repeat(64), userId, "credit_score", salt1);

      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000);
      vault.addCommitment(
        "b".repeat(64),
        userId,
        "net_worth",
        salt2,
        expiresAt,
      );

      const removed = vault.cleanup();

      expect(removed).toBe(1);
      expect(vault.getUserCommitments(userId)).toHaveLength(1);
    });

    it("returns count of removed commitments", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000);

      vault.addCommitment(
        "a".repeat(64),
        userId,
        "credit_score",
        generateBlindingSalt(),
        expiresAt,
      );
      vault.addCommitment(
        "b".repeat(64),
        userId,
        "net_worth",
        generateBlindingSalt(),
        expiresAt,
      );
      vault.addCommitment(
        "c".repeat(64),
        userId,
        "account_age_days",
        generateBlindingSalt(),
      ); // Active

      const removed = vault.cleanup();

      expect(removed).toBe(2);
    });
  });

  describe("getStats", () => {
    it("returns accurate vault statistics", () => {
      const userId = "G" + "A".repeat(51) + "HNRG";
      const expiresAt = new Date();
      expiresAt.setTime(expiresAt.getTime() - 1000);

      vault.addCommitment(
        "a".repeat(64),
        userId,
        "credit_score",
        generateBlindingSalt(),
      );
      vault.addCommitment(
        "b".repeat(64),
        userId,
        "net_worth",
        generateBlindingSalt(),
        expiresAt,
      );

      const stats = vault.getStats();

      expect(stats.totalCommitments).toBe(2);
      expect(stats.expiredCommitments).toBe(1);
    });

    it("returns zeros for empty vault", () => {
      const stats = vault.getStats();

      expect(stats.totalCommitments).toBe(0);
      expect(stats.expiredCommitments).toBe(0);
    });
  });
});

describe("Pedersen Commitment Functions", () => {
  describe("generateBlindingSalt", () => {
    it("generates random 64-char hex strings", () => {
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      expect(salt1).toHaveLength(64);
      expect(salt2).toHaveLength(64);
      expect(salt1).toMatch(/^[a-f0-9]{64}$/);
      expect(salt2).toMatch(/^[a-f0-9]{64}$/);
      expect(salt1).not.toBe(salt2); // Different each time
    });
  });

  describe("generatePedersenCommitment", () => {
    it("generates consistent commitments from same inputs", () => {
      const value = 750n;
      const salt = generateBlindingSalt();

      const commitment1 = generatePedersenCommitment(value, salt);
      const commitment2 = generatePedersenCommitment(value, salt);

      expect(commitment1).toBe(commitment2);
    });

    it("generates different commitments from different salts", () => {
      const value = 750n;
      const salt1 = generateBlindingSalt();
      const salt2 = generateBlindingSalt();

      const commitment1 = generatePedersenCommitment(value, salt1);
      const commitment2 = generatePedersenCommitment(value, salt2);

      expect(commitment1).not.toBe(commitment2);
    });

    it("generates different commitments from different values", () => {
      const salt = generateBlindingSalt();

      const commitment1 = generatePedersenCommitment(700n, salt);
      const commitment2 = generatePedersenCommitment(750n, salt);

      expect(commitment1).not.toBe(commitment2);
    });

    it("returns 64-char hex commitment", () => {
      const commitment = generatePedersenCommitment(
        750n,
        generateBlindingSalt(),
      );

      expect(commitment).toHaveLength(64);
      expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("verifyCommitmentConsistency", () => {
    it("verifies matching commitment", () => {
      const value = 750n;
      const salt = generateBlindingSalt();
      const commitment = generatePedersenCommitment(value, salt);

      const isValid = verifyCommitmentConsistency(value, salt, commitment);
      expect(isValid).toBe(true);
    });

    it("rejects mismatched commitment", () => {
      const value = 750n;
      const salt = generateBlindingSalt();

      const isValid = verifyCommitmentConsistency(
        value,
        salt,
        "wrong".repeat(16),
      );
      expect(isValid).toBe(false);
    });

    it("rejects wrong value", () => {
      const salt = generateBlindingSalt();
      const commitment = generatePedersenCommitment(750n, salt);

      const isValid = verifyCommitmentConsistency(800n, salt, commitment);
      expect(isValid).toBe(false);
    });

    it("rejects wrong salt", () => {
      const value = 750n;
      const salt = generateBlindingSalt();
      const commitment = generatePedersenCommitment(value, salt);
      const wrongSalt = generateBlindingSalt();

      const isValid = verifyCommitmentConsistency(value, wrongSalt, commitment);
      expect(isValid).toBe(false);
    });
  });
});
