/**
 * Encrypted Evidence Vault (#307).
 *
 * Envelope encryption for dispute evidence and provider documents.
 * Files are encrypted with a random Data Encryption Key (DEK), and the
 * DEK is wrapped with a Key Encryption Key (KEK) derived via HKDF from
 * the trade secret. The server stores only ciphertext + wrapped DEK +
 * Merkle root — it cannot decrypt without the trade secret or a grant
 * token.
 *
 * All cryptography uses Node.js built-in crypto module (no dependencies).
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;          // 256-bit AES key
const IV_BYTES = 12;           // 96-bit GCM nonce
const TAG_BYTES = 16;          // GCM auth tag
const CHUNK_SIZE = 65536;      // 64KB Merkle chunks
const HKDF_INFO = "velo-evidence-v1";
const HKDF_HASH = "sha256";
const PEpper = "velo-evidence-blinding";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface EncryptedFile {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export interface WrappedKey {
  wrappedKey: Buffer;
  nonce: Buffer;
}

/* ------------------------------------------------------------------ */
/*  Key generation                                                    */
/* ------------------------------------------------------------------ */

/** Generate a random 256-bit Data Encryption Key. */
export function generateDEK(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/**
 * Derive a Key Encryption Key (KEK) from the trade secret via HKDF.
 *
 * @param tradeSecretHex - 64-char hex trade secret (32 bytes)
 * @param tradeId        - Trade identifier used as HKDF salt
 * @returns 256-bit KEK
 */
export function deriveKEK(tradeSecretHex: string, tradeId: string): Buffer {
  const secret = Buffer.from(tradeSecretHex, "hex");
  if (secret.length !== KEY_BYTES) {
    throw new Error(`tradeSecretHex must be ${KEY_BYTES} bytes (64 hex chars)`);
  }
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, secret, Buffer.from(tradeId), HKDF_INFO, KEY_BYTES));
}

/**
 * Blind a trade secret for grant token inclusion.
 * HKDF(secret, salt="blinding", info="velo-evidence-blinding")
 * This produces a derived value that cannot be reversed to find the
 * original secret, allowing arbitrators to derive the KEK without
 * learning the raw trade secret.
 */
export function blindSecret(tradeSecretHex: string): Buffer {
  const secret = Buffer.from(tradeSecretHex, "hex");
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, secret, Buffer.from("blinding"), PEpper, KEY_BYTES));
}

/* ------------------------------------------------------------------ */
/*  DEK wrapping                                                      */
/* ------------------------------------------------------------------ */

/** Encrypt (wrap) a DEK under a KEK using AES-256-GCM. */
export function wrapDEK(dek: Buffer, kek: Buffer): WrappedKey {
  const nonce = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, kek, nonce);
  const wrappedKey = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { wrappedKey: Buffer.concat([wrappedKey, tag]), nonce };
}

/** Decrypt (unwrap) a DEK using a KEK. */
export function unwrapDEK(wrapped: WrappedKey, kek: Buffer): Buffer {
  const ct = wrapped.wrappedKey.subarray(0, wrapped.wrappedKey.length - TAG_BYTES);
  const tag = wrapped.wrappedKey.subarray(wrapped.wrappedKey.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, kek, wrapped.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/* ------------------------------------------------------------------ */
/*  File encryption / decryption                                      */
/* ------------------------------------------------------------------ */

/** Encrypt a file buffer using AES-256-GCM with a DEK. */
export function encryptFile(plaintext: Buffer, dek: Buffer): EncryptedFile {
  const nonce = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

/** Decrypt a file buffer using a DEK. */
export function decryptFile(encrypted: EncryptedFile, dek: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, dek, encrypted.nonce);
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

/* ------------------------------------------------------------------ */
/*  Merkle tree proof                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute the SHA-256 Merkle tree root of a buffer.
 * Each leaf is the SHA-256 hash of a 64KB chunk.
 * The root is SHA-256 of the concatenated leaf hashes.
 */
export function merkleRoot(data: Buffer): string {
  const leaves: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + CHUNK_SIZE);
    leaves.push(crypto.createHash("sha256").update(chunk).digest());
  }
  if (leaves.length === 0) {
    leaves.push(crypto.createHash("sha256").update(Buffer.alloc(0)).digest());
  }
  if (leaves.length === 1) return leaves[0].toString("hex");
  const combined = Buffer.concat(leaves);
  return crypto.createHash("sha256").update(combined).digest("hex");
}

/**
 * Verify a Merkle proof for a specific chunk.
 * Not implemented as a full inclusion proof — instead the root
 * is checked at upload time against the full file, and the root
 * is stored alongside the ciphertext.
 */
export function verifyFileIntegrity(data: Buffer, expectedRoot: string): boolean {
  return merkleRoot(data) === expectedRoot;
}

/* ------------------------------------------------------------------ */
/*  Memory sanitization helper                                        */
/* ------------------------------------------------------------------ */

/** Overwrite a buffer with zeros to clear sensitive data from memory. */
export function clearBuffer(buf: Buffer): void {
  buf.fill(0);
}
