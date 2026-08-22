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
    /// signature, only that the timeout has elapsed. Returns the amount refunded.
    fn refund(env: Env, id: BytesN<32>) -> i128;
}
