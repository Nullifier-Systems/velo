import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { randomHex32, generateSecretPair } from "./crypto.js";

describe("randomHex32", () => {
  it("returns a string of length 64 (32 bytes hex-encoded)", () => {
    expect(randomHex32()).toHaveLength(64);
  });

  it("returns only valid hex characters", () => {
    expect(randomHex32()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different values on successive calls", () => {
    const results = new Set(Array.from({ length: 10 }, () => randomHex32()));
    expect(results.size).toBe(10);
  });
});

describe("generateSecretPair", () => {
  it("returns an object with secretHex and secretHashHex", () => {
    const pair = generateSecretPair();
    expect(pair).toHaveProperty("secretHex");
    expect(pair).toHaveProperty("secretHashHex");
  });

  it("secretHex is 64 characters of valid hex", () => {
    const { secretHex } = generateSecretPair();
    expect(secretHex).toHaveLength(64);
    expect(secretHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("secretHashHex is 64 characters of valid hex", () => {
    const { secretHashHex } = generateSecretPair();
    expect(secretHashHex).toHaveLength(64);
    expect(secretHashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("secretHashHex matches SHA-256 of the secret bytes", () => {
    const { secretHex, secretHashHex } = generateSecretPair();
    const secretBytes = Buffer.from(secretHex, "hex");
    const expectedHash = createHash("sha256").update(secretBytes).digest("hex");
    expect(secretHashHex).toBe(expectedHash);
  });

  it("returns different values on successive calls", () => {
    const results = Array.from({ length: 10 }, () => generateSecretPair());
    const secrets = new Set(results.map((r) => r.secretHex));
    const hashes = new Set(results.map((r) => r.secretHashHex));
    expect(secrets.size).toBe(10);
    expect(hashes.size).toBe(10);
  });
});
