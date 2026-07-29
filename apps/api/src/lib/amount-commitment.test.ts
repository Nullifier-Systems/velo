import { describe, it, expect } from "vitest";
import {
  commitAmount,
  openCommitment,
  deriveFeeSplit,
  buildReleaseWitness,
  verifyReleaseWitness,
} from "./amount-commitment.js";

const BLINDING_A = "a".repeat(64);
const BLINDING_B = "b".repeat(64);

describe("commitAmount", () => {
  it("returns a 64-char hex commitment and blinding factor", () => {
    const c = commitAmount(10_000_000n);
    expect(/^[0-9a-f]{64}$/.test(c.commitmentHex)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(c.blindingHex)).toBe(true);
    expect(c.amountStroops).toBe(10_000_000n);
  });

  it("is deterministic for a fixed amount and blinding factor", () => {
    const a = commitAmount(500n, BLINDING_A);
    const b = commitAmount(500n, BLINDING_A);
    expect(a.commitmentHex).toBe(b.commitmentHex);
  });

  it("hides the amount: random blindings yield different commitments", () => {
    const a = commitAmount(500n);
    const b = commitAmount(500n);
    expect(a.commitmentHex).not.toBe(b.commitmentHex);
  });

  it("is binding: different amounts under the same blinding differ", () => {
    const a = commitAmount(500n, BLINDING_A);
    const b = commitAmount(501n, BLINDING_A);
    expect(a.commitmentHex).not.toBe(b.commitmentHex);
  });

  it("rejects negative and out-of-range amounts", () => {
    expect(() => commitAmount(-1n)).toThrow();
    expect(() => commitAmount(1n << 127n)).toThrow();
  });
});

describe("openCommitment", () => {
  it("accepts the correct opening", () => {
    const c = commitAmount(42n, BLINDING_A);
    expect(openCommitment(c.commitmentHex, 42n, BLINDING_A)).toBe(true);
  });

  it("rejects a different amount than was committed", () => {
    const c = commitAmount(42n, BLINDING_A);
    expect(openCommitment(c.commitmentHex, 43n, BLINDING_A)).toBe(false);
  });

  it("rejects a different blinding factor", () => {
    const c = commitAmount(42n, BLINDING_A);
    expect(openCommitment(c.commitmentHex, 42n, BLINDING_B)).toBe(false);
  });

  it("rejects malformed hex without throwing", () => {
    expect(openCommitment("nope", 42n, BLINDING_A)).toBe(false);
  });
});

describe("deriveFeeSplit", () => {
  it("matches the contract's integer fee math", () => {
    const { feeStroops, payoutStroops } = deriveFeeSplit(10_000_000n, 250);
    expect(feeStroops).toBe(250_000n);
    expect(payoutStroops).toBe(9_750_000n);
  });

  it("always sums back to the original amount", () => {
    const amount = 123_456_789n;
    const { feeStroops, payoutStroops } = deriveFeeSplit(amount, 137);
    expect(feeStroops + payoutStroops).toBe(amount);
  });

  it("truncates toward zero like Soroban i128 division", () => {
    expect(deriveFeeSplit(9_999n, 1).feeStroops).toBe(0n);
  });

  it("rejects an out-of-range fee", () => {
    expect(() => deriveFeeSplit(1n, 10_001)).toThrow();
  });
});

describe("release witness", () => {
  it("round-trips an honest witness", () => {
    const c = commitAmount(10_000_000n, BLINDING_A);
    const w = buildReleaseWitness(c, 250);
    expect(verifyReleaseWitness(c.commitmentHex, w, 250)).toBe(true);
  });

  it("rejects a witness that claims a different amount", () => {
    const c = commitAmount(10_000_000n, BLINDING_A);
    const w = buildReleaseWitness(c, 250);
    const tampered = { ...w, amountStroops: 9_000_000n };
    expect(verifyReleaseWitness(c.commitmentHex, tampered, 250)).toBe(false);
  });

  it("rejects a witness whose fee split was tampered with", () => {
    const c = commitAmount(10_000_000n, BLINDING_A);
    const w = buildReleaseWitness(c, 250);
    const tampered = { ...w, feeStroops: 0n, payoutStroops: 10_000_000n };
    expect(verifyReleaseWitness(c.commitmentHex, tampered, 250)).toBe(false);
  });

  it("independently confirms the payout the contract would compute", () => {
    const c = commitAmount(10_000_000n, BLINDING_A);
    const w = buildReleaseWitness(c, 250);
    expect(w.payoutStroops).toBe(9_750_000n);
    expect(w.feeStroops).toBe(250_000n);
  });
});