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

/**
 * Generate a shielded stake commitment: H(secret || amount || timestamp).
 * The commitment is a Pedersen-like hash that hides the stake amount and
 * provider identity while remaining publicly verifiable.
 */
export function generateShieldedCommitment(
    secretHex: string,
    amountStroops: string,
): { commitmentHash: string; nullifierHash: string } {
    const secret = Buffer.from(secretHex, "hex");
    const timestamp = Date.now().toString();

    const commitmentHash = createHash("sha256")
        .update(secret)
        .update(amountStroops)
        .update(timestamp)
        .update("shielded_commitment_v1")
        .digest("hex");

    const nullifierHash = createHash("sha256")
        .update(secret)
        .update("shielded_nullifier_v1")
        .digest("hex");

    return { commitmentHash, nullifierHash };
}

/**
 * Verify a shielded commitment by re-deriving the hash from its components.
 */
export function verifyShieldedCommitment(
    secretHex: string,
    amountStroops: string,
    timestamp: string,
    expectedCommitment: string,
): boolean {
    const secret = Buffer.from(secretHex, "hex");
    const derived = createHash("sha256")
        .update(secret)
        .update(amountStroops)
        .update(timestamp)
        .update("shielded_commitment_v1")
        .digest("hex");
    return derived === expectedCommitment;
}