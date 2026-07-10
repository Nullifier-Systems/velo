import { randomBytes, createHash } from "node:crypto";

/** Generates a random 32-byte value, hex-encoded (64 chars). Used for trade IDs. */
export function randomHex32(): string {
    return randomBytes(32).toString("hex");
}

/**
 * Generates a random 32-byte secret plus its SHA-256 hash, both hex-encoded.
 * The hash goes into lock()'s secret_hash param; the secret itself is only
 * revealed later, at hand-off, to release()'s secret param.
 */
export function generateSecretPair(): { secretHex: string; secretHashHex: string } {
    const secret = randomBytes(32);
    const hash = createHash("sha256").update(secret).digest();
    return { secretHex: secret.toString("hex"), secretHashHex: hash.toString("hex") };
}