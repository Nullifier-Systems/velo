/**
 * Pedersen Commitment Vault
 * Manages cryptographic commitments: C = v*G + r*H
 * v = secret value, r = random blinding factor
 * Implements secure storage and commitment generation
 */

import crypto from "crypto";

/**
 * Pedersen commitment parameters for secp256k1
 * G = generator point, H = alternative base point (h = H(G || "h"))
 */
export const PEDERSEN_PARAMS = {
  // secp256k1 generator point (compressed)
  G: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  // Alternative base H (SHA256(G || "h"))
  H: "0294d78ffd3e6c68146c2825dd96e7bcd30bfc9d8ae3c05edc0dcc4bbf7f3f0eb6",
};

/**
 * Blinding Salt Generation
 * Generates random 32-byte salt to prevent rainbow table attacks
 * Salt is used as the blinding factor r in C = v*G + r*H
 */
export function generateBlindingSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Pedersen Commitment Generation
 * C = v*G + r*H
 * In practice, we hash the commitment to get a 256-bit value
 *
 * @param value Secret value (e.g., credit score)
 * @param salt Blinding factor (32-byte hex string)
 * @returns 256-bit commitment hash
 */
export function generatePedersenCommitment(
  value: bigint,
  salt: string,
): string {
  // Combine value and salt to create commitment input
  const valueHex = value.toString(16).padStart(64, "0");
  const combined = valueHex + salt;

  // Hash the combined value+salt using SHA256
  // In production, this would use actual EC point arithmetic
  const commitment = crypto
    .createHash("sha256")
    .update(Buffer.from(combined, "hex"))
    .digest("hex");

  return commitment;
}

/**
 * Verify Commitment Consistency
 * Re-compute commitment given value and salt
 * Used to validate that a commitment matches its plaintext
 *
 * @param value Original secret value
 * @param salt Original blinding factor
 * @param commitment Expected commitment hash
 * @returns true if commitment matches recomputed value
 */
export function verifyCommitmentConsistency(
  value: bigint,
  salt: string,
  commitment: string,
): boolean {
  const recomputed = generatePedersenCommitment(value, salt);
  return recomputed === commitment;
}

/**
 * Commitment Vault
 * Thread-safe store for managing commitments and their associated data
 */
export class PedersenVault {
  private commitments = new Map<string, CommitmentRecord>();

  /**
   * Store a new commitment with metadata
   */
  addCommitment(
    commitmentHex: string,
    userId: string,
    attributeType: string,
    salt: string,
    expiresAt?: Date,
  ): void {
    if (this.commitments.has(commitmentHex)) {
      throw new Error(`Commitment ${commitmentHex} already exists`);
    }

    this.commitments.set(commitmentHex, {
      commitmentHex,
      userId,
      attributeType,
      salt,
      createdAt: new Date(),
      expiresAt,
    });
  }

  /**
   * Retrieve commitment by hash
   */
  getCommitment(commitmentHex: string): CommitmentRecord | null {
    const record = this.commitments.get(commitmentHex);
    if (record && record.expiresAt && record.expiresAt < new Date()) {
      this.commitments.delete(commitmentHex);
      return null;
    }
    return record || null;
  }

  /**
   * Get all commitments for a user
   */
  getUserCommitments(userId: string): CommitmentRecord[] {
    const now = new Date();
    return Array.from(this.commitments.values()).filter((record) => {
      if (record.userId !== userId) return false;
      if (record.expiresAt && record.expiresAt < now) {
        this.commitments.delete(record.commitmentHex);
        return false;
      }
      return true;
    });
  }

  /**
   * Delete expired commitments
   */
  cleanup(): number {
    const now = new Date();
    let removed = 0;

    for (const [key, record] of this.commitments.entries()) {
      if (record.expiresAt && record.expiresAt < now) {
        this.commitments.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get vault statistics
   */
  getStats(): { totalCommitments: number; expiredCommitments: number } {
    const now = new Date();
    let expiredCount = 0;

    for (const record of this.commitments.values()) {
      if (record.expiresAt && record.expiresAt < now) {
        expiredCount++;
      }
    }

    return {
      totalCommitments: this.commitments.size,
      expiredCommitments: expiredCount,
    };
  }
}

interface CommitmentRecord {
  commitmentHex: string;
  userId: string;
  attributeType: string;
  salt: string;
  createdAt: Date;
  expiresAt?: Date;
}

// Global vault instance
export const globalPedersenVault = new PedersenVault();
