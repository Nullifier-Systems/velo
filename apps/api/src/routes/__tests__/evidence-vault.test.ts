import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateDEK,
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  encryptFile,
  decryptFile,
  merkleRoot,
  verifyFileIntegrity,
  blindSecret,
} from "../../../lib/crypto/evidence-vault";
import { issueGrantToken, verifyGrantToken } from "../../../lib/crypto/grant-token";

/* ------------------------------------------------------------------ */
/*  Evidence Vault                                                    */
/* ------------------------------------------------------------------ */

describe("EvidenceVault", () => {
  const tradeSecret = "a".repeat(64); // 32 bytes hex
  const tradeId = "test-trade-001";
  const testFile = Buffer.from("Hello, evidence vault!", "utf8");
  const largeFile = Buffer.alloc(200_000, "x"); // > 3 chunks × 64KB

  /* ---- DEK ---- */

  it("generateDEK produces 32-byte key", () => {
    const dek = generateDEK();
    expect(dek.length).toBe(32);
  });

  it("generateDEK produces unique keys each call", () => {
    const a = generateDEK();
    const b = generateDEK();
    expect(a.equals(b)).toBe(false);
  });

  /* ---- HKDF derivation ---- */

  it("deriveKEK produces deterministic output", () => {
    const a = deriveKEK(tradeSecret, tradeId);
    const b = deriveKEK(tradeSecret, tradeId);
    expect(a.equals(b)).toBe(true);
  });

  it("deriveKEK produces different keys for different trades", () => {
    const a = deriveKEK(tradeSecret, "trade-1");
    const b = deriveKEK(tradeSecret, "trade-2");
    expect(a.equals(b)).toBe(false);
  });

  it("deriveKEK throws on invalid secret length", () => {
    expect(() => deriveKEK("tooshort", tradeId)).toThrow();
  });

  /* ---- DEK wrapping ---- */

  it("wrapDEK / unwrapDEK round-trips", () => {
    const dek = generateDEK();
    const kek = deriveKEK(tradeSecret, tradeId);
    const wrapped = wrapDEK(dek, kek);
    const unwrapped = unwrapDEK(wrapped, kek);
    expect(dek.equals(unwrapped)).toBe(true);
  });

  it("unwrapDEK rejects wrong KEK", () => {
    const dek = generateDEK();
    const kek1 = deriveKEK(tradeSecret, "trade-1");
    const kek2 = deriveKEK(tradeSecret, "trade-2");
    const wrapped = wrapDEK(dek, kek1);
    expect(() => unwrapDEK(wrapped, kek2)).toThrow();
  });

  /* ---- File encryption ---- */

  it("encryptFile / decryptFile round-trips small file", () => {
    const dek = generateDEK();
    const encrypted = encryptFile(testFile, dek);
    const decrypted = decryptFile(encrypted, dek);
    expect(decrypted.equals(testFile)).toBe(true);
  });

  it("encryptFile / decryptFile round-trips large file", () => {
    const dek = generateDEK();
    const encrypted = encryptFile(largeFile, dek);
    const decrypted = decryptFile(encrypted, dek);
    expect(decrypted.equals(largeFile)).toBe(true);
  });

  it("decryptFile rejects tampered ciphertext", () => {
    const dek = generateDEK();
    const encrypted = encryptFile(testFile, dek);
    encrypted.ciphertext[0] ^= 0xff; // flip a bit
    expect(() => decryptFile(encrypted, dek)).toThrow();
  });

  it("decryptFile rejects tampered tag", () => {
    const dek = generateDEK();
    const encrypted = encryptFile(testFile, dek);
    encrypted.tag[0] ^= 0xff;
    expect(() => decryptFile(encrypted, dek)).toThrow();
  });

  /* ---- Merkle tree ---- */

  it("merkleRoot is deterministic", () => {
    const a = merkleRoot(testFile);
    const b = merkleRoot(testFile);
    expect(a).toBe(b);
  });

  it("merkleRoot differs for different content", () => {
    const a = merkleRoot(Buffer.from("hello"));
    const b = merkleRoot(Buffer.from("world"));
    expect(a).not.toBe(b);
  });

  it("verifyFileIntegrity accepts valid content", () => {
    const root = merkleRoot(testFile);
    expect(verifyFileIntegrity(testFile, root)).toBe(true);
  });

  it("verifyFileIntegrity rejects tampered content", () => {
    const root = merkleRoot(testFile);
    const tampered = Buffer.from("tampered!");
    expect(verifyFileIntegrity(tampered, root)).toBe(false);
  });

  it("merkleRoot handles empty buffer", () => {
    const root = merkleRoot(Buffer.alloc(0));
    expect(root.length).toBe(64);
  });

  /* ---- Blind secret ---- */

  it("blindSecret produces deterministic output", () => {
    const a = blindSecret(tradeSecret);
    const b = blindSecret(tradeSecret);
    expect(a.equals(b)).toBe(true);
  });

  it("blindSecret output differs from raw secret", () => {
    const raw = Buffer.from(tradeSecret, "hex");
    const blinded = blindSecret(tradeSecret);
    expect(blinded.equals(raw)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Grant tokens                                                      */
/* ------------------------------------------------------------------ */

describe("GrantToken", () => {
  const tradeSecret = "b".repeat(64);
  const tradeId = "grant-test-trade";
  const grantee = "GCXKG6RN4ON6MJG5VQZ2KQ3X4Y5P6Q7R8A9B0C1D2E3F4G5H6I7J8K9L0M";
  const deadline = Date.now() + 86_400_000; // 24h from now

  process.env.VAULT_MASTER_SECRET = "test-master-secret-for-grant-token-testing";

  it("issueGrantToken produces a non-empty token", () => {
    const token = issueGrantToken(tradeSecret, tradeId, grantee, "view", deadline);
    expect(token.length).toBeGreaterThan(0);
    expect(token).toContain(".");
  });

  it("verifyGrantToken returns valid payload", () => {
    const token = issueGrantToken(tradeSecret, tradeId, grantee, "view", deadline);
    const payload = verifyGrantToken(token, "test-master-secret-for-grant-token-testing");
    expect(payload).not.toBeNull();
    expect(payload!.tradeId).toBe(tradeId);
    expect(payload!.grantee).toBe(grantee);
    expect(payload!.purpose).toBe("view");
  });

  it("verifyGrantToken rejects expired token", () => {
    const past = Date.now() - 10_000;
    const token = issueGrantToken(tradeSecret, tradeId, grantee, "view", past, 1);
    const payload = verifyGrantToken(token, "test-master-secret-for-grant-token-testing");
    expect(payload).toBeNull();
  });

  it("verifyGrantToken rejects tampered token", () => {
    const token = issueGrantToken(tradeSecret, tradeId, grantee, "view", deadline);
    const tampered = token.slice(0, -1) + "x";
    const payload = verifyGrantToken(tampered, "test-master-secret-for-grant-token-testing");
    expect(payload).toBeNull();
  });

  it("verifyGrantToken rejects wrong master secret", () => {
    const token = issueGrantToken(tradeSecret, tradeId, grantee, "view", deadline);
    const payload = verifyGrantToken(token, "wrong-secret");
    expect(payload).toBeNull();
  });
});
