/**
 * ZK Range-Proof Attestation Types
 * Pedersen commitments, Bulletproof range proofs, and verified credentials
 */

/**
 * Pedersen Commitment: C = v*G + r*H
 * v = secret value (e.g., credit score)
 * r = random blinding factor (salt)
 * G, H = EC curve points
 */
export interface PedersenCommitment {
  commitmentId: string; // UUID
  userId: string; // 56-char Stellar address
  commitmentHex: string; // 64-char hex (sha256 of v*G + r*H)
  saltHex: string; // 64-char hex (blinding factor r, base64url-encoded)
  attributeType: "credit_score" | "net_worth" | "account_age_days" | "transaction_volume";
  createdAt: string; // ISO8601
  expiresAt?: string; // ISO8601
}

/**
 * ZK Range Proof Request
 * User submits after generating proof locally via WASM
 */
export interface ZkRangeProofRequest {
  commitmentId: string; // References pedersen_commitments row
  proofHex: string; // Serialized Bulletproof range proof
  rangeMin: bigint; // Lower bound (inclusive)
  rangeMax: bigint; // Upper bound (inclusive)
}

/**
 * ZK Range Proof Submission
 * Database representation of a proof submission
 */
export interface ZkRangeProof {
  proofId: string; // UUID
  commitmentId: string;
  userId: string;
  proofHex: string;
  rangeMin: bigint;
  rangeMax: bigint;
  status: "pending" | "verified" | "rejected";
  errorMessage?: string;
  verificationTime?: string; // ISO8601
  expiresAt?: string; // ISO8601
  createdAt: string; // ISO8601
}

/**
 * Verified ZK Attestation
 * Issued by backend after proof verification succeeds
 */
export interface ZkAttestation {
  attestationId: string; // UUID
  proofId: string;
  userId: string;
  issuerPublicKey: string; // 56-char Ed25519 public key
  attestationHex: string; // Serialized signed attestation
  attestationHash: string; // 64-char sha256 hash for deduplication
  expiresAt: string; // ISO8601
  createdAt: string; // ISO8601
}

/**
 * Range Proof Verification Response
 * Returned by /api/v1/zk/verify-range-proof
 */
export interface ZkVerificationResponse {
  proofId: string;
  status: "verified" | "rejected";
  attestation?: ZkAttestation; // Only if status === "verified"
  error?: string; // Error description if rejected
}

/**
 * WASM Worker Message: Generate Range Proof
 * Sent from main thread to Web Worker
 */
export interface WasmRangeProofRequest {
  commitmentHex: string; // Public Pedersen commitment
  secret: bigint; // Secret value (never leaves main thread in production)
  salt: string; // Blinding factor (base64url)
  rangeMin: bigint;
  rangeMax: bigint;
  attributeType: string;
}

/**
 * WASM Worker Message: Range Proof Generated
 * Returned from Web Worker to main thread
 */
export interface WasmRangeProofResponse {
  proofHex: string; // Serialized Bulletproof range proof
  generationTimeMs: number;
}

/**
 * Credential Wallet State
 * Manages multiple Pedersen commitments and their proofs
 */
export interface CredentialWalletState {
  commitments: PedersenCommitment[];
  activeProofs: Map<string, ZkRangeProof>; // commitmentId -> proof
  attestations: Map<string, ZkAttestation>; // proofId -> attestation
  isGeneratingProof: boolean;
  lastError?: string;
}

/**
 * Range Proof Parameters (for WASM circuit)
 * Must match Bulletproof constants
 */
export const RANGE_PROOF_PARAMS = {
  MIN_VALUE: 0n,
  MAX_VALUE: 2n ** 32n - 1n, // 32-bit range (0 - 4,294,967,295)
  BULLETPROOF_BITS: 32,
  TIMEOUT_MS: 1500, // Max time to generate proof in Web Worker
};

/**
 * Attribute Ranges (Predefined bounds for common attributes)
 */
export const ATTRIBUTE_RANGES = {
  credit_score: { min: 300n, max: 850n, description: "FICO credit score" },
  net_worth: { min: 0n, max: 2n ** 32n - 1n, description: "Net worth in USD (millions)" },
  account_age_days: { min: 0n, max: 36500n, description: "Account age in days (~100 years)" },
  transaction_volume: { min: 0n, max: 2n ** 32n - 1n, description: "Transaction volume in satoshis" },
};
