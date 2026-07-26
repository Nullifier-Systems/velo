/**
 * Time-bounded blinded grant tokens for evidence access (#307).
 *
 * Grant tokens allow arbitrators and compliance operators to access
 * encrypted evidence during an active dispute window without learning
 * the raw trade secret. Tokens are HMAC-SHA256 signed and contain a
 * blinded version of the trade secret for KEK derivation.
 *
 * Token lifecycle:
 * 1. Issued by POST /admin/trades/:id/grant-token (admin-only)
 * 2. Presented as x-grant-token header on evidence download
 * 3. Server verifies HMAC, checks expiry, derives KEK from blinded secret
 * 4. Token expires at dispute_deadline + 24 hours
 */

import crypto from "crypto";
import { deriveKEK, blindSecret } from "./evidence-vault.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type GrantPurpose = "view" | "upload";

export interface GrantTokenPayload {
  tradeId: string;
  grantee: string;
  purpose: GrantPurpose;
  blindedSecret: string;  // hex
  issuedAt: number;
  expiresAt: number;
}

export interface GrantTokenClaims {
  payload: GrantTokenPayload;
  signature: string;
}

const HMAC_ALGORITHM = "sha256";
const TOKEN_SEPARATOR = ".";

/* ------------------------------------------------------------------ */
/*  Token issuance                                                    */
/* ------------------------------------------------------------------ */

/**
 * Issue a time-bounded grant token for evidence access.
 *
 * @param tradeSecretHex - Raw trade secret (64 hex chars)
 * @param tradeId        - Trade identifier
 * @param grantee        - Stellar address of the grantee
 * @param purpose        - "view" or "upload"
 * @param disputeDeadline - Ledger sequence or timestamp of dispute deadline
 * @param ttlMs          - Token TTL in milliseconds (default 24h past deadline)
 * @returns Base64-encoded signed token string
 */
export function issueGrantToken(
  tradeSecretHex: string,
  tradeId: string,
  grantee: string,
  purpose: GrantPurpose,
  disputeDeadline: number,
  ttlMs: number = 86_400_000, // 24 hours
): string {
  const blinded = blindSecret(tradeSecretHex);
  const now = Date.now();
  const expiresAt = Math.max(disputeDeadline, now) + ttlMs;

  const payload: GrantTokenPayload = {
    tradeId,
    grantee,
    purpose,
    blindedSecret: blinded.toString("hex"),
    issuedAt: now,
    expiresAt,
  };

  const encoded = encodePayload(payload);
  const signature = sign(encoded);
  return `${encoded}${TOKEN_SEPARATOR}${signature}`;
}

/**
 * Verify and decode a grant token.
 *
 * @param token      - Base64-encoded token string
 * @param masterSecret - HMAC signing secret (VAULT_MASTER_SECRET env var)
 * @returns Decoded payload, or null if invalid/expired/tampered
 */
export function verifyGrantToken(
  token: string,
  masterSecret: string,
): GrantTokenPayload | null {
  try {
    const lastDot = token.lastIndexOf(TOKEN_SEPARATOR);
    if (lastDot < 0) return null;

    const encoded = token.slice(0, lastDot);
    const signature = token.slice(lastDot + 1);

    const expectedSig = hmac(encoded, masterSecret);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }

    const payload = decodePayload(encoded);
    if (Date.now() > payload.expiresAt) return null;

    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function encodePayload(payload: GrantTokenPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString("base64url");
}

function decodePayload(encoded: string): GrantTokenPayload {
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  return JSON.parse(json);
}

function hmac(data: string, secret: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, secret).update(data).digest("hex");
}

function sign(data: string): string {
  const secret = process.env.VAULT_MASTER_SECRET ?? "dev-vault-secret";
  return hmac(data, secret);
}

/**
 * Derive the KEK from a grant token's blinded secret.
 * Used by the download endpoint to decrypt evidence.
 */
export function kekFromBlindedSecret(blindedSecretHex: string, tradeId: string): Buffer {
  // The blinded secret is already an HKDF output — we derive a KEK from it
  // using the same salt (tradeId) to ensure forward secrecy.
  const blinded = Buffer.from(blindedSecretHex, "hex");
  return Buffer.from(crypto.hkdfSync("sha256", blinded, Buffer.from(tradeId), "velo-evidence-v1", 32));
}
