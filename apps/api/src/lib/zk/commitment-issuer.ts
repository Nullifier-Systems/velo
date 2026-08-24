/**
 * Commitment Issuer Service
 * Issues and signs Pedersen commitments for users
 * Manages credential lifecycle: issuance → proof generation → attestation
 */

import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import {
  generatePedersenCommitment,
  generateBlindingSalt,
  PedersenVault,
} from "./pedersen-vault.js";
import type { PedersenCommitment } from "@velo/shared";

export interface CommitmentIssuanceRequest {
  userId: string; // 56-char Stellar address
  value: bigint; // Secret value (e.g., credit score)
  attributeType: string; // credit_score, net_worth, etc.
  expiresInDays?: number; // Default: 30 days
}

export interface CommitmentIssuanceResponse {
  commitment: PedersenCommitment;
  signedAttestation: string; // Ed25519 signature
}

/**
 * Commitment Issuer
 * Trusted authority that:
 * 1. Creates Pedersen commitments for user values
 * 2. Signs commitments with Ed25519 keypair
 * 3. Issues credentials that prove value bounds
 */
export class CommitmentIssuer {
  private issuerKeypair: Keypair;
  private vault: PedersenVault;

  constructor(issuerKeypair: Keypair, vault: PedersenVault) {
    this.issuerKeypair = issuerKeypair;
    this.vault = vault;
  }

  /**
   * Issue a Pedersen Commitment
   * Creates a cryptographic commitment to a user's secret value
   * The user later proves properties of this value via ZK range proof
   */
  async issueCommitment(
    request: CommitmentIssuanceRequest,
  ): Promise<CommitmentIssuanceResponse> {
    const { userId, value, attributeType, expiresInDays = 30 } = request;

    // Validate inputs
    if (!userId.match(/^[A-Z0-9]{56}$/)) {
      throw new Error("Invalid Stellar address format");
    }

    if (value < 0n || value > 2n ** 32n - 1n) {
      throw new Error("Value out of supported range (0 - 2^32-1)");
    }

    // Generate random blinding salt (prevents rainbow table attacks)
    const salt = generateBlindingSalt();

    // Create Pedersen commitment: C = v*G + r*H
    const commitmentHex = generatePedersenCommitment(value, salt);

    // Set expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    // Create commitment record
    const commitment: PedersenCommitment = {
      commitmentId: this.generateUUID(),
      userId,
      commitmentHex,
      saltHex: salt,
      attributeType: attributeType as
        | "credit_score"
        | "net_worth"
        | "account_age_days"
        | "transaction_volume",
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Add to vault
    this.vault.addCommitment(
      commitmentHex,
      userId,
      attributeType,
      salt,
      expiresAt,
    );

    // Sign the commitment with issuer's keypair
    const signedAttestation = this.signCommitment(commitment);

    return {
      commitment,
      signedAttestation,
    };
  }

  /**
   * Sign a Commitment
   * Creates Ed25519 signature over commitment hash
   * Proves issuer's authority over this credential
   */
  private signCommitment(commitment: PedersenCommitment): string {
    const message = Buffer.from(
      JSON.stringify({
        commitmentHex: commitment.commitmentHex,
        userId: commitment.userId,
        attributeType: commitment.attributeType,
        createdAt: commitment.createdAt,
        expiresAt: commitment.expiresAt,
      }),
    );

    const signature = this.issuerKeypair.sign(message);
    return signature.toString("base64");
  }

  /**
   * Verify Signed Commitment
   * Checks that signature is valid for this commitment
   * Used to prevent forged credentials
   */
  verifySignedCommitment(
    commitment: PedersenCommitment,
    signature: string,
  ): boolean {
    try {
      const message = Buffer.from(
        JSON.stringify({
          commitmentHex: commitment.commitmentHex,
          userId: commitment.userId,
          attributeType: commitment.attributeType,
          createdAt: commitment.createdAt,
          expiresAt: commitment.expiresAt,
        }),
      );

      const signatureBuffer = Buffer.from(signature, "base64");
      return this.issuerKeypair.verify(message, signatureBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Get Issuer Public Key
   * Returns the issuer's public key for verification
   */
  getIssuerPublicKey(): string {
    return this.issuerKeypair.publicKey();
  }

  /**
   * Get Vault Statistics
   * Returns information about stored commitments
   */
  getVaultStats() {
    return this.vault.getStats();
  }

  /**
   * Cleanup Expired Commitments
   * Removes expired credentials from vault
   */
  async cleanupExpired(): Promise<number> {
    return this.vault.cleanup();
  }

  /**
   * Generate UUID v4
   * Simple UUID generation for commitment IDs
   */
  private generateUUID(): string {
    return crypto.randomUUID();
  }
}

/**
 * Create Commitment Issuer from keypair seed
 * @param seedOrKeypair Either a seed string or Keypair object
 * @param vault Optional vault instance (creates new if omitted)
 */
export function createCommitmentIssuer(
  seedOrKeypair: string | Keypair,
  vault?: PedersenVault,
): CommitmentIssuer {
  const keypair =
    typeof seedOrKeypair === "string"
      ? Keypair.random() // In production, derive from seed
      : seedOrKeypair;

  return new CommitmentIssuer(keypair, vault || new PedersenVault());
}
