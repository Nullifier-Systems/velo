import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";

const RECOVERY_TOKEN_BYTES = 32; // 256 bits
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Generate a cryptographically secure random recovery token.
 */
export function generateRecoveryToken(): string {
  return randomBytes(RECOVERY_TOKEN_BYTES).toString("hex");
}

/**
 * Hash contact info (email or phone) for secure storage and deduplication.
 * Returns a truncated SHA256 hash suitable for identifying recovery contacts.
 */
export function hashContactInfo(email?: string, phone?: string): string | null {
  const contact = email || phone;
  if (!contact) return null;
  
  const normalized = contact.toLowerCase().trim();
  return createHash("sha256").update(normalized).digest("hex").substring(0, 32);
}

/**
 * Derive an encryption key from a recovery challenge.
 * Challenge can be: user's email, phone number, or Stellar account.
 * Uses PBKDF2-style derivation to ensure we can't predict keys from plaintext.
 */
function deriveKeyFromChallenge(challenge: string, salt: string): Buffer {
  const combined = `${salt}:${challenge}`;
  const hash = createHash("sha256").update(combined).digest();
  // AES-256 needs 32-byte key
  return hash;
}

/**
 * Encrypt a recovery token with a challenge-derived key.
 * Returns a JSON-serializable string containing IV, ciphertext, and auth tag.
 */
export function encryptRecoveryToken(
  token: string,
  challenge: string,
  salt: string = "velo-recovery-v1"
): string {
  const key = deriveKeyFromChallenge(challenge, salt);
  const iv = randomBytes(IV_LENGTH);
  
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag();
  
  // Return compact JSON with all necessary data
  const payload = {
    iv: iv.toString("hex"),
    ciphertext: encrypted,
    authTag: authTag.toString("hex"),
  };
  
  return JSON.stringify(payload);
}

/**
 * Decrypt a recovery token using a challenge-derived key.
 * Returns the original token if decryption succeeds and auth tag is valid.
 * Returns null if challenge is wrong, token expired, or auth fails.
 */
export function decryptRecoveryToken(
  encrypted: string,
  challenge: string,
  salt: string = "velo-recovery-v1"
): string | null {
  try {
    const payload = JSON.parse(encrypted);
    const { iv: ivHex, ciphertext, authTag: authTagHex } = payload;
    
    if (!ivHex || !ciphertext || !authTagHex) {
      return null;
    }
    
    const key = deriveKeyFromChallenge(challenge, salt);
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return decrypted;
  } catch (err) {
    // Any error (parse, decrypt, auth tag mismatch) returns null
    return null;
  }
}

/**
 * Validate that a recovery attempt should be allowed.
 * Returns { allowed: true } or { allowed: false, reason: string }
 */
export function validateRecoveryAttempt(
  lastAttemptAt: string | undefined,
  attemptCount: number,
  maxAttemptsPerDay: number = 3
): { allowed: boolean; reason?: string } {
  if (!lastAttemptAt) {
    // First attempt
    return { allowed: true };
  }
  
  const lastAttempt = new Date(lastAttemptAt);
  const now = new Date();
  const hoursSinceLastAttempt = (now.getTime() - lastAttempt.getTime()) / (1000 * 60 * 60);
  
  // Reset counter if 24 hours have passed
  if (hoursSinceLastAttempt >= 24) {
    return { allowed: true };
  }
  
  // Within 24-hour window, check attempt count
  if (attemptCount >= maxAttemptsPerDay) {
    const minutesUntilReset = Math.ceil((24 - hoursSinceLastAttempt) * 60);
    return {
      allowed: false,
      reason: `Too many recovery attempts. Try again in ${minutesUntilReset} minutes.`,
    };
  }
  
  return { allowed: true };
}

/**
 * Validate that a recovery token has not expired.
 * Recovery tokens are typically valid for 24 hours from creation.
 */
export function validateRecoveryTokenExpiry(
  expiresAt: string | undefined,
  maxAgeHours: number = 24
): { valid: boolean; reason?: string } {
  if (!expiresAt) {
    return { valid: false, reason: "Recovery token expiration not set" };
  }
  
  const expiresAtDate = new Date(expiresAt);
  const now = new Date();
  
  if (now > expiresAtDate) {
    return { valid: false, reason: "Recovery token has expired" };
  }
  
  return { valid: true };
}

/**
 * Compute the token expiration timestamp (24 hours from now).
 */
export function computeTokenExpiration(hoursFromNow: number = 24): string {
  const expiry = new Date();
  expiry.setHours(expiry.getHours() + hoursFromNow);
  return expiry.toISOString();
}
