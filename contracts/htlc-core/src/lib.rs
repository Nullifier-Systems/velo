//! htlc-core
//!
//! Shared types and trait for hashed-timelock contracts on Soroban.
//! `escrow` (P2P cash-out) and `atomic-swap` (cross-chain) both implement
//! this so the on-chain state machine stays consistent across products.
#![no_std]

use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum TradeStatus {
    Locked,
    Released,
    Refunded,
    Disputed,
    /// A disputed trade whose funds were split (or fully allocated) by an
    /// arbitrator via `resolve_dispute`. Distinct from `Released`/`Refunded`
    /// so a resolved dispute is never confused with the ordinary HTLC
    /// release/refund paths.
    Resolved,
}

/// A single tranche within a trade: an amount with its own secret hash.
/// Multiple tranches allow partial, incremental releases.
#[derive(Clone)]
#[contracttype]
pub struct Tranche {
    pub amount: i128,
    pub secret_hash: BytesN<32>,
    pub released: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct TradeState {
    pub seller: Address,
    pub buyer: Address,
    /// Total locked amount across all tranches. Immutable after lock().
    pub amount: i128,
    /// List of tranches, each with its own amount and secret hash.
    /// The sum of tranche amounts must equal `amount` at lock() time.
    pub tranches: Vec<Tranche>,
    pub timeout_ledger: u32,
    pub status: TradeStatus,
    /// For backward compatibility: single secret_hash field.
    /// When tranches are used, this field is ignored.
    /// For single-tranche trades, this can still be used.
    pub secret_hash: BytesN<32>,
}

/// Every HTLC-based contract in this workspace implements this trait so
/// the lock/release/refund state machine — and its invariants — stay
/// identical whether the funds are settling a P2P cash trade or a
/// cross-chain swap.
pub trait Htlc {
    /// Lock funds against a secret hash and a ledger-based timeout.
    /// MUST require_auth() from the funding party and MUST reject if a
    /// trade already exists under this id (no overwrite of active state).
    fn lock(
        env: Env,
        id: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    );

    /// Release funds to the buyer by revealing the preimage of secret_hash.
    /// MUST verify sha256(secret) == secret_hash and MUST be a no-op if
    /// the trade is not in `Locked` status.
    fn release(env: Env, id: BytesN<32>, secret: BytesN<32>);

    /// Permissionless refund back to the buyer once timeout_ledger has
    /// passed. Anyone can call this — it does not require the buyer's
    /// signature, only that the timeout has elapsed.
    fn refund(env: Env, id: BytesN<32>);
}

/// Denominator for basis-point arithmetic: 10_000 bps == 100%.
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Maximum platform fee accepted in basis points (100%).
pub const MAX_FEE_BPS: u32 = 10_000;

/// Why a checked basis-point computation failed (issue #381).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeeMathError {
    /// An intermediate product exceeded what i128 can represent. In a
    /// Soroban contract this must surface as a recoverable contract
    /// error — never as an arithmetic panic, which would freeze the
    /// escrow's locked funds behind a permanently-failing call path.
    Overflow,
}

/// Computes the platform fee in stroops for `amount` at `fee_bps`,
/// i.e. `amount * fee_bps / 10_000`, without ever using raw `*` or `/`
/// on stroop values (issue #381).
///
/// Two properties matter here:
///
/// 1. **No panics.** Every intermediate step is checked. Amounts near
///    `i128::MAX / 10_000` combined with large fee configs would
///    otherwise overflow and trap already-locked funds behind a
///    permanently-panicking release path.
/// 2. **No fee-free micro-tranches.** Integer division truncates
///    toward zero, so `amount * fee_bps < BPS_DENOMINATOR` used to
///    settle for a zero fee — letting tiny tranches process volume
///    without paying the platform anything. Any positive product that
///    truncates to zero is rounded UP to the minimum 1-stroop fee.
///
/// Returns `Ok(0)` when either input is zero/negative so callers never
/// need a special case for fee-free or empty amounts.
pub fn calculate_fee(amount: i128, fee_bps: u32) -> Result<i128, FeeMathError> {
    if amount <= 0 || fee_bps == 0 {
        return Ok(0);
    }
    let gross = amount
        .checked_mul(fee_bps as i128)
        .ok_or(FeeMathError::Overflow)?;
    let mut fee = gross
        .checked_div(BPS_DENOMINATOR)
        .ok_or(FeeMathError::Overflow)?;
    // Micro-tranche anti-evasion bound (issue #381).
    if fee == 0 {
        fee = 1;
    }
    Ok(fee)
}

/// Splits `amount` proportionally at `bps / 10_000` (e.g. a dispute's
/// `buyer_share_bps`) with checked math. Unlike [`calculate_fee`] this
/// performs no round-up: truncation of a proportional split favors the
/// counterparty receiving the remainder, matching the documented
/// "truncation rounds down" invariant.
pub fn apply_bps(amount: i128, bps: u32) -> Result<i128, FeeMathError> {
    let product = amount
        .checked_mul(bps as i128)
        .ok_or(FeeMathError::Overflow)?;
    product
        .checked_div(BPS_DENOMINATOR)
        .ok_or(FeeMathError::Overflow)
}

/// Subtracts a fee from a gross amount, refusing to go negative — a
/// negative "payout" can never be transferred, so it surfaces as an
/// overflow-class error instead.
pub fn net_of(gross: i128, fee: i128) -> Result<i128, FeeMathError> {
    let net = gross.checked_sub(fee).ok_or(FeeMathError::Overflow)?;
    if net < 0 {
        return Err(FeeMathError::Overflow);
    }
    Ok(net)
}

#[cfg(test)]
mod fee_math_tests {
    use super::*;

    #[test]
    fn zero_inputs_are_fee_free() {
        assert_eq!(calculate_fee(0, 250), Ok(0));
        assert_eq!(calculate_fee(1_000, 0), Ok(0));
        assert_eq!(calculate_fee(-5, 250), Ok(0));
    }

    #[test]
    fn exact_and_truncated_fees() {
        assert_eq!(calculate_fee(1_000, 250), Ok(25));
        assert_eq!(calculate_fee(150, 100), Ok(1)); // 1.5 truncated
        assert_eq!(apply_bps(150, 100), Ok(1));
    }

    #[test]
    fn micro_amounts_round_up_to_one_stroop() {
        // 99 * 100 / 10_000 = 0 raw — must charge the 1-stroop minimum.
        assert_eq!(calculate_fee(99, 100), Ok(1));
        assert_eq!(calculate_fee(1, 1), Ok(1));
    }

    #[test]
    fn boundary_amount_at_max_lock_is_exact() {
        // The largest amount lock() accepts times the largest legal fee
        // config lands just under i128::MAX — must not report overflow.
        let max_lockable = i128::MAX / BPS_DENOMINATOR;
        assert_eq!(calculate_fee(max_lockable, MAX_FEE_BPS), Ok(max_lockable));
        assert_eq!(apply_bps(max_lockable, MAX_FEE_BPS), Ok(max_lockable));
    }

    #[test]
    fn overflow_returns_error_instead_of_panicking() {
        // Old code: `amount * fee_bps` on these inputs panics the WASM
        // runtime and freezes the escrow.
        assert_eq!(calculate_fee(i128::MAX, 2), Err(FeeMathError::Overflow));
        assert_eq!(apply_bps(i128::MAX, 2), Err(FeeMathError::Overflow));
        assert_eq!(net_of(0, 1), Err(FeeMathError::Overflow));
    }
}
