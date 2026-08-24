/**
 * Safe stroop fee arithmetic for the API layer (issue #381).
 *
 * Mirrors `contracts/htlc-core/src/lib.rs` (`calculate_fee` / `net_of`)
 * so every off-chain pre-check agrees exactly with on-chain behavior:
 *
 * - NEVER use raw `*` on stroop values without an explicit i128 bound
 *   check — JS numbers silently lose precision long before that, and
 *   even BigInt arithmetic must mirror the contract's checked math.
 * - Micro-tranches (amount * fee_bps < 10_000) round UP to a minimum
 *   1-stroop fee instead of truncating to 0, closing the fee-evasion
 *   hole where tiny releases settled fee-free.
 */

export const BPS_DENOMINATOR = 10_000n;
export const MAX_FEE_BPS = 10_000;

/** Largest value a Soroban i128 can hold (stroops are i128 on-chain). */
export const I128_MAX = (1n << 127n) - 1n;

/**
 * Thrown when a tranche fee computation would overflow i128 or use an
 * invalid configuration. Routes translate this into
 * HTTP 422 `FEE_ARITHMETIC_OVERFLOW`.
 */
export class FeeArithmeticOverflowError extends Error {
  readonly code = "FEE_ARITHMETIC_OVERFLOW";

  constructor(
    message = "Tranche fee calculation resulted in arithmetic overflow or invalid precision.",
  ) {
    super(message);
    this.name = "FeeArithmeticOverflowError";
  }
}

/**
 * Computes the platform fee in stroops: `amount * fee_bps / 10_000`,
 * rounded up to a minimum of 1 stroop for any positive product.
 *
 * @throws FeeArithmeticOverflowError when `feeBps` is out of range or
 * the intermediate product would exceed i128 (the contract's checked
 * math returns its own error in the same situation, never a panic).
 */
export function computeTrancheFeeStroops(
  amountStroops: bigint,
  feeBps: number,
): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new FeeArithmeticOverflowError(
      `fee_bps out of range [0, ${MAX_FEE_BPS}]: ${feeBps}`,
    );
  }
  if (amountStroops <= 0n) return 0n;
  if (amountStroops > I128_MAX) {
    throw new FeeArithmeticOverflowError(
      "amount exceeds the on-chain i128 stroop range",
    );
  }
  const gross = amountStroops * BigInt(feeBps);
  if (gross > I128_MAX) {
    throw new FeeArithmeticOverflowError(
      "tranche amount times fee_bps overflows i128",
    );
  }
  let fee = gross / BPS_DENOMINATOR;
  // Micro-tranche anti-evasion floor (issue #381).
  if (fee === 0n) fee = 1n;
  return fee;
}

/** Gross minus fee; refuses negative payouts like the contract does. */
export function applyNetPayout(grossStroops: bigint, feeStroops: bigint): bigint {
  const net = grossStroops - feeStroops;
  if (net < 0n) {
    throw new FeeArithmeticOverflowError("fee exceeds gross tranche amount");
  }
  return net;
}

/** Invariant check used by the auditor: `gross === fee + net`, all non-negative. */
export function verifyFeeInvariant(
  grossStroops: bigint,
  feeStroops: bigint,
  netPayoutStroops: bigint,
): boolean {
  return (
    feeStroops >= 0n &&
    netPayoutStroops >= 0n &&
    grossStroops === feeStroops + netPayoutStroops
  );
}
