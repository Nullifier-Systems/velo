/**
 * ZK Range Proof Tests
 * Unit tests for Bulletproof range proof validation
 */

import { describe, it, expect } from "vitest";
import { RangeProofValidator, validateRangeProof } from "../range-proof.js";

describe("RangeProofValidator", () => {
  describe("validate", () => {
    it("accepts valid range proof with correct metadata", () => {
      const commitment = "a".repeat(64);
      const rangeMin = 700n;
      const rangeMax = 850n;

      // Generate valid proof structure
      const proofHex = generateValidProof(commitment, rangeMin, rangeMax);

      const result = RangeProofValidator.validate({
        commitmentHex: commitment,
        proofHex,
        rangeMin,
        rangeMax,
      });

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.verificationTimeMs).toBeDefined();
      expect(result.verificationTimeMs).toBeLessThan(100);
    });

    it("rejects proof with invalid commitment format", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "invalid_commitment",
        proofHex: "aa".repeat(50),
        rangeMin: 700n,
        rangeMax: 850n,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Invalid commitment format");
    });

    it("rejects proof with invalid hex format", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "a".repeat(64),
        proofHex: "not_hex_data",
        rangeMin: 700n,
        rangeMax: 850n,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Invalid proof format");
    });

    it("rejects proof with invalid range bounds", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "a".repeat(64),
        proofHex: "aa".repeat(50),
        rangeMin: 850n,
        rangeMax: 700n, // Inverted
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Invalid range");
    });

    it("rejects proof with out-of-bounds range", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "a".repeat(64),
        proofHex: "aa".repeat(50),
        rangeMin: -100n, // Negative
        rangeMax: 850n,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Range out of supported bounds");
    });

    it("rejects proof that is too short", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "a".repeat(64),
        proofHex: "aabbccdd", // Only 4 bytes
        rangeMin: 700n,
        rangeMax: 850n,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Proof too short");
    });

    it("rejects proof with mismatched metadata hash", () => {
      const commitment = "a".repeat(64);
      const rangeMin = 700n;
      const rangeMax = 850n;

      // Create proof with wrong metadata hash
      const wrongProof =
        Buffer.alloc(32, 0xff).toString("hex") + "aa".repeat(100);

      const result = RangeProofValidator.validate({
        commitmentHex: commitment,
        proofHex: wrongProof,
        rangeMin,
        rangeMax,
      });

      expect(result.isValid).toBe(false);
    });

    it("rejects proof with mismatched range bits", () => {
      const commitment = "a".repeat(64);
      const rangeMin = 700n;
      const rangeMax = 850n;

      const proofHex = generateValidProof(commitment, rangeMin, rangeMax);
      // Truncate proof to claim fewer bits
      const truncatedProof = proofHex.slice(0, 64);

      const result = RangeProofValidator.validate({
        commitmentHex: commitment,
        proofHex: truncatedProof,
        rangeMin,
        rangeMax,
      });

      expect(result.isValid).toBe(false);
    });
  });

  describe("validateBatch", () => {
    it("validates multiple proofs in parallel", () => {
      const commitment = "a".repeat(64);
      const requests = [
        {
          commitmentHex: commitment,
          proofHex: generateValidProof(commitment, 700n, 850n),
          rangeMin: 700n,
          rangeMax: 850n,
        },
        {
          commitmentHex: commitment,
          proofHex: generateValidProof(commitment, 0n, 1000n),
          rangeMin: 0n,
          rangeMax: 1000n,
        },
        {
          commitmentHex: "invalid",
          proofHex: "invalid",
          rangeMin: 100n,
          rangeMax: 200n,
        },
      ];

      const results = RangeProofValidator.validateBatch(requests);

      expect(results).toHaveLength(3);
      expect(results[0].isValid).toBe(true);
      expect(results[1].isValid).toBe(true);
      expect(results[2].isValid).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles maximum 32-bit range", () => {
      const commitment = "a".repeat(64);
      const rangeMin = 0n;
      const rangeMax = 2n ** 32n - 1n;

      const proofHex = generateValidProof(commitment, rangeMin, rangeMax);

      const result = RangeProofValidator.validate({
        commitmentHex: commitment,
        proofHex,
        rangeMin,
        rangeMax,
      });

      expect(result.isValid).toBe(true);
    });

    it("handles single-value range", () => {
      const commitment = "a".repeat(64);
      const rangeMin = 750n;
      const rangeMax = 750n; // Same value

      const proofHex = generateValidProof(commitment, rangeMin, rangeMax);

      const result = RangeProofValidator.validate({
        commitmentHex: commitment,
        proofHex,
        rangeMin,
        rangeMax,
      });

      expect(result.isValid).toBe(true);
    });

    it("rejects range exceeding 32-bit maximum", () => {
      const result = RangeProofValidator.validate({
        commitmentHex: "a".repeat(64),
        proofHex: "aa".repeat(50),
        rangeMin: 0n,
        rangeMax: 2n ** 33n, // Too large
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Range out of supported bounds");
    });
  });

  describe("shorthand function", () => {
    it("validateRangeProof works as expected", () => {
      const commitment = "a".repeat(64);
      const proofHex = generateValidProof(commitment, 700n, 850n);

      const result = validateRangeProof({
        commitmentHex: commitment,
        proofHex,
        rangeMin: 700n,
        rangeMax: 850n,
      });

      expect(result.isValid).toBe(true);
    });
  });
});

/**
 * Helper: Generate a valid proof structure for testing
 */
function generateValidProof(
  commitmentHex: string,
  rangeMin: bigint,
  rangeMax: bigint,
): string {
  const crypto = require("crypto");

  // Create metadata hash
  const metadata = Buffer.concat([
    Buffer.from(commitmentHex, "hex"),
    Buffer.from(rangeMin.toString(16).padStart(16, "0"), "hex"),
    Buffer.from(rangeMax.toString(16).padStart(16, "0"), "hex"),
  ]);

  const metadataHash = crypto.createHash("sha256").update(metadata).digest();

  // Create full proof: metadata + random vectors + path + response
  const proof = Buffer.concat([
    metadataHash, // 32 bytes
    crypto.randomBytes(32), // A vector
    crypto.randomBytes(32), // S vector
    crypto.randomBytes(64), // T1, T2
    crypto.randomBytes(32 * 32), // Merkle path (32 levels)
    crypto.randomBytes(384), // Response values
  ]);

  return proof.toString("hex");
}
