import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Client-side amount-commitment primitive for confidential trade amounts
 * (issue #276).
 *
 * Today TradeState.amount is a plain i128 sent to lock() in the clear and
 * emitted in contract events. This module lets a client commit to the amount
 * with a hiding, binding hash commitment and publish only the 32-byte
 * commitment on-chain, then reveal a witness at release() time that anyone can
 * check for consistency (the "revealed-amount-plus-proof-of-consistency"
 * approach the issue allows).
 *
 * It is deliberately standalone: it imports nothing from the escrow contract
 * or the live settlement path, and changes no existing behaviour. See
 * docs/amount-commitment-privacy.md for the honest privacy boundary -- in
 * particular, the underlying token transfer still leaks the amount at
 * settlement, so this is not end-to-end confidentiality.
 */

const COMMITMENT_DOMAIN = Buffer.from("velo.amount-commitment.v1", "utf8");
const BLINDING_BYTES = 32;
const I128_BYTES = 16;
const I128_MAX = (1n << 127n) - 1n;
const BPS_DENOMINATOR = 10_000n;
const HEX64 = /^[0-9a-f]{64}$/i;

/** A commitment to a trade amount, plus the secret opening material. */
export interface AmountCommitment {
  /** SHA-256 commitment, hex-encoded (64 chars). This is what goes on-chain. */
  commitmentHex: string;
  /** Random 32-byte blinding factor, hex-encoded. Keep this secret until release. */
  blindingHex: string;
  /** The committed amount, in stroops. Never published at lock() time. */
  amountStroops: bigint;
}

/** The fee/payout split the contract will apply, derived off-chain. */
export interface FeeSplit {
  feeStroops: bigint;
  payoutStroops: bigint;
}

/** Opening material revealed at release() so a verifier can check consistency. */
export interface ReleaseWitness {
  amountStroops: bigint;
  blindingHex: string;
  feeStroops: bigint;
  payoutStroops: bigint;
}

/** Encode a non-negative i128 amount as 16 big-endian bytes. */
function encodeAmount(amountStroops: bigint): Buffer {
  if (amountStroops < 0n) {
    throw new RangeError("amountStroops must be non-negative");
  }
  if (amountStroops > I128_MAX) {
    throw new RangeError("amountStroops exceeds i128 max");
  }
  const buf = Buffer.alloc(I128_BYTES);
  let v = amountStroops;
  for (let i = I128_BYTES - 1; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** commitment = SHA-256(DOMAIN || amount_be128 || blinding). */
function computeDigest(amountStroops: bigint, blinding: Buffer): Buffer {
  return createHash("sha256")
    .update(COMMITMENT_DOMAIN)
    .update(encodeAmount(amountStroops))
    .update(blinding)
    .digest();
}

/**
 * Commit to an amount. Generates a fresh random blinding factor unless one is
 * supplied (supplying one is intended for tests / deterministic re-derivation).
 */
export function commitAmount(amountStroops: bigint, blindingHex?: string): AmountCommitment {
  let blinding: Buffer;
  if (blindingHex === undefined) {
    blinding = randomBytes(BLINDING_BYTES);
  } else {
    if (!HEX64.test(blindingHex)) {
      throw new TypeError("blindingHex must be a 32-byte hex string (64 chars)");
    }
    blinding = Buffer.from(blindingHex, "hex");
  }
  const commitment = computeDigest(amountStroops, blinding);
  return {
    commitmentHex: commitment.toString("hex"),
    blindingHex: blinding.toString("hex"),
    amountStroops,
  };
}

/**
 * Check that (amountStroops, blindingHex) opens the given commitment. Returns
 * false (never throws) on malformed input so it is safe to call on untrusted
 * witness data. Uses a constant-time comparison.
 */
export function openCommitment(
  commitmentHex: string,
  amountStroops: bigint,
  blindingHex: string,
): boolean {
  if (!HEX64.test(commitmentHex) || !HEX64.test(blindingHex)) {
    return false;
  }
  if (amountStroops < 0n || amountStroops > I128_MAX) {
    return false;
  }
  const expected = Buffer.from(commitmentHex, "hex");
  const actual = computeDigest(amountStroops, Buffer.from(blindingHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Derive fee and payout using the SAME integer math the escrow contract uses:
 * fee = amount * fee_bps / 10000 (truncating toward zero), payout = amount - fee.
 */
export function deriveFeeSplit(amountStroops: bigint, feeBps: number): FeeSplit {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError("feeBps must be an integer between 0 and 10000");
  }
  if (amountStroops < 0n || amountStroops > I128_MAX) {
    throw new RangeError("amountStroops out of range");
  }
  const feeStroops = (amountStroops * BigInt(feeBps)) / BPS_DENOMINATOR;
  return { feeStroops, payoutStroops: amountStroops - feeStroops };
}

/** Build the witness revealed at release() from a commitment and the fee rate. */
export function buildReleaseWitness(commitment: AmountCommitment, feeBps: number): ReleaseWitness {
  const { feeStroops, payoutStroops } = deriveFeeSplit(commitment.amountStroops, feeBps);
  return {
    amountStroops: commitment.amountStroops,
    blindingHex: commitment.blindingHex,
    feeStroops,
    payoutStroops,
  };
}

/**
 * Verify a release witness against the published commitment and fee rate:
 * the witness must open the commitment AND its fee/payout must match the
 * contract-derived split and sum back to the committed amount. A witness for a
 * different amount, or with a doctored split, fails here.
 */
export function verifyReleaseWitness(
  commitmentHex: string,
  witness: ReleaseWitness,
  feeBps: number,
): boolean {
  if (!openCommitment(commitmentHex, witness.amountStroops, witness.blindingHex)) {
    return false;
  }
  let split: FeeSplit;
  try {
    split = deriveFeeSplit(witness.amountStroops, feeBps);
  } catch {
    return false;
  }
  return (
    split.feeStroops === witness.feeStroops &&
    split.payoutStroops === witness.payoutStroops &&
    witness.feeStroops + witness.payoutStroops === witness.amountStroops
  );
}