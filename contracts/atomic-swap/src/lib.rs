//! Cross-chain HTLC — Stellar side of an ETH/BTC/SOL <-> Stellar swap.
//!
//! Implements the shared `htlc-core::Htlc` state machine (lock/release/refund)
//! so atomicity on the Stellar leg is identical to `escrow`. The one difference
//! that matters for cross-chain settlement: **`release()` publishes the revealed
//! secret as an event**, so an off-chain relayer can read the preimage and claim
//! the counterpart HTLC on the other chain (see `apps/relayer`).
//!
//! Swap flow (Stellar leg):
//!   1. `lock()` — the buyer escrows funds against `sha256(secret)` and a
//!      ledger timeout. Funds sit in the contract, held by no party.
//!   2. `release()` — the party holding the secret reveals it; funds go to the
//!      seller in full and the secret is emitted in the `released` event.
//!   3. `refund()` — permissionless once the timeout elapses; funds return to
//!      the buyer if the swap never completed.
//!
//! Unlike `escrow`, this contract charges **no platform fee** — a cross-chain
//! swap settles the counterpart value on the other chain, not via a fee here.
#![no_std]

use htlc_core::{Htlc, TradeState, TradeStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

#[contracttype]
enum DataKey {
    Admin,
    Token,
    Trade(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    TradeAlreadyExists = 3,
    TradeNotFound = 4,
    InvalidSecret = 6,
    TimeoutNotReached = 7,
    InvalidAmount = 8,
    InvalidTimeout = 9,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7; // ~7 days at 10s/ledger, sanity cap

#[contract]
pub struct AtomicSwapContract;

#[contractimpl]
impl AtomicSwapContract {
    /// One-time setup: records the admin and the settlement token (e.g. USDC on
    /// Stellar). Guarded so it can only ever run once.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        Ok(())
    }

    /// Read-only accessor for a trade's current state. Returns `None` if the id
    /// was never locked. Useful for the relayer and for clients polling status.
    pub fn get_trade(env: Env, id: BytesN<32>) -> Option<TradeState> {
        env.storage().persistent().get(&DataKey::Trade(id))
    }
}

#[contractimpl]
impl Htlc for AtomicSwapContract {
    fn lock(
        env: Env,
        id: BytesN<32>,
        seller: Address,
        buyer: Address,
        amount: i128,
        secret_hash: BytesN<32>,
        timeout_ledgers: u32,
    ) {
        buyer.require_auth();

        if amount <= 0 {
            panic_with_error(&env, Error::InvalidAmount);
        }
        if timeout_ledgers == 0 || timeout_ledgers > DEFAULT_TIMEOUT_LEDGERS_MAX {
            panic_with_error(&env, Error::InvalidTimeout);
        }

        let key = DataKey::Trade(id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error(&env, Error::TradeAlreadyExists);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error(&env, Error::NotInitialized));

        // Pull funds into the contract now — released or refunded later, never
        // held by any party in between.
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&buyer, &env.current_contract_address(), &amount);

        let timeout_ledger = env.ledger().sequence() + timeout_ledgers;

        let state = TradeState {
            seller,
            buyer,
            amount,
            secret_hash,
            timeout_ledger,
            status: TradeStatus::Locked,
        };
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, 100_000, 100_000);

        env.events()
            .publish((Symbol::new(&env, "locked"), id), amount);
    }

    /// Release funds to the seller by revealing the preimage of `secret_hash`,
    /// and publish the revealed secret so the relayer can claim the other leg.
    ///
    /// Per the `Htlc` trait: a no-op if the trade is not in `Locked` status
    /// (so release is idempotent / safe to retry). Panics on an unknown id or
    /// an incorrect secret.
    fn release(env: Env, id: BytesN<32>, secret: BytesN<32>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        // No-op if already released or refunded (trait invariant).
        if state.status != TradeStatus::Locked {
            return;
        }

        let computed = env.crypto().sha256(&secret.clone().into());
        if computed.to_bytes() != state.secret_hash {
            panic_with_error(&env, Error::InvalidSecret);
        }

        // Full amount to the seller — no platform fee on cross-chain swaps.
        // CEI pattern: update state before external calls
        state.status = TradeStatus::Released;
        env.storage().persistent().set(&key, &state);

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(
            &env.current_contract_address(),
            &state.seller,
            &state.amount,
        );

        // The revealed secret is the cross-chain payload: the relayer reads it
        // from this event and uses it to claim the counterpart HTLC.
        env.events()
            .publish((Symbol::new(&env, "released"), id), secret);
    }

    fn refund(env: Env, id: BytesN<32>) {
        let key = DataKey::Trade(id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error(&env, Error::TradeNotFound));

        // No-op if already released or refunded (trait invariant).
        if state.status != TradeStatus::Locked {
            return;
        }
        if env.ledger().sequence() < state.timeout_ledger {
            panic_with_error(&env, Error::TimeoutNotReached);
        }

        // CEI pattern: update state before external calls
        state.status = TradeStatus::Refunded;
        env.storage().persistent().set(&key, &state);

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        client.transfer(&env.current_contract_address(), &state.buyer, &state.amount);

        env.events()
            .publish((Symbol::new(&env, "refunded"), id), state.amount);
    }
}

fn panic_with_error(_env: &Env, err: Error) -> ! {
    panic!("{}", err as u32)
}

#[cfg(test)]
mod test;
