/**
 * KMS driver interface for hardware-backed signing (#401).
 * Drivers never handle cleartext private keys — they delegate signing to
 * AWS KMS, GCP KMS, or Vault Transit and return a Stellar-compatible
 * decorated signature payload.
 */

export interface KmsSignRequest {
  /** Key id / resource name in the provider. */
  keyId: string;
  /** 32-byte hash or serialized transaction hash to sign (hex). */
  payloadHex: string;
}

export interface KmsSignResult {
  /** Raw 64-byte Ed25519 signature as hex. */
  signatureHex: string;
  /** Optional key version / alias echoed back. */
  keyId: string;
}

export interface KmsDriver {
  readonly provider: "aws" | "gcp" | "vault";
  /** Sign without exposing private key material. */
  sign(request: KmsSignRequest): Promise<KmsSignResult>;
  /** Verify driver is configured (env / credentials present). */
  isConfigured(): boolean;
}
