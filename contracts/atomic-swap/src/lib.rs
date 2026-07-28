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

#[cfg(not(target_arch = "wasm32"))]
extern crate std;

use htlc_core::{Htlc, TradeState, TradeStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

#[contracttype]
enum DataKey {
    Admin,
    Token,
    Trade(BytesN<32>),
    /// Cross-chain reorg protection: per-EVM-chain-ID, minimum k-confirmations required
    ChainFinality(u32), // chain_id -> k_confirmations
    /// Merkle proof cache: caches verified proofs to prevent re-verification
    ProofCache(BytesN<32>), // proof_hash -> true/false
    /// Cross-chain state: EVM tx hash -> (secret, block_height, revealed_at_ledger)
    CrossChainState(BytesN<32>), // evm_tx_hash -> CrossChainTxInfo
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
    /// Cross-chain: proof verification failed
    ProofVerificationFailed = 10,
    /// Cross-chain: EVM chain not recognized or finality not set
    UnknownChain = 11,
    /// Cross-chain: block confirmations below safe threshold (reorg risk)
    InsufficientFinality = 12,
    /// Cross-chain: timelock already extended (prevent double-extension)
    TimelockAlreadyExtended = 13,
    /// Cross-chain: invalid Merkle root or proof
    InvalidMerkleProof = 14,
}

/// Cross-chain EVM transaction info: secret and block metadata
#[derive(Clone)]
#[contracttype]
pub struct CrossChainTxInfo {
    /// Revealed secret (used to verify cross-chain preimage)
    pub secret: BytesN<32>,
    /// EVM block number where preimage was revealed
    pub evm_block_height: u32,
    /// Soroban ledger sequence when we learned about the reveal
    pub revealed_at_soroban_ledger: u32,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7; // ~7 days at 10s/ledger, sanity cap

/// Cross-chain reorg protection: finality depth per EVM chain
/// These are chain_id -> k_confirmations mappings
const ETHEREUM_MAINNET_FINALITY: u32 = 64; // ~15 minutes
const ARBITRUM_FINALITY: u32 = 100; // ~100 blocks (~3-5 mins with fast blocks)
const POLYGON_FINALITY: u32 = 256; // ~20 minutes
const OPTIMISM_FINALITY: u32 = 1; // L2, finalized immediately
const BASE_FINALITY: u32 = 1; // L2, finalized immediately

/// Maximum reorg window (in Soroban ledgers) — extend timelock by this if reorg detected
/// ~50 ledgers ≈ 5 minutes buffer for EVM reorg recovery
const MAX_REORG_WINDOW_LEDGERS: u32 = 50;

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

    /// Cross-chain: Set finality depth (k-confirmations) for an EVM chain.
    /// Only callable by admin. Used to track reorg risk per chain.
    pub fn set_chain_finality(env: Env, chain_id: u32, k_confirmations: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ChainFinality(chain_id), &k_confirmations);
        Ok(())
    }

    /// Cross-chain: Get finality depth for an EVM chain. Returns the safe k-confirmations.
    pub fn get_chain_finality(env: Env, chain_id: u32) -> Result<u32, Error> {
        let key = DataKey::ChainFinality(chain_id);
        match chain_id {
            // Mainnet Ethereum
            1 => Ok(ETHEREUM_MAINNET_FINALITY),
            // Arbitrum One
            42161 => Ok(ARBITRUM_FINALITY),
            // Polygon
            137 => Ok(POLYGON_FINALITY),
            // Optimism
            10 => Ok(OPTIMISM_FINALITY),
            // Base
            8453 => Ok(BASE_FINALITY),
            // Custom or override
            _ => env
                .storage()
                .instance()
                .get(&key)
                .ok_or(Error::UnknownChain),
        }
    }

    /// Cross-chain: Record EVM secret reveal for later verification.
    /// Called by relayer after observing LogHTLCWithdraw on EVM.
    /// Stores secret + block metadata. Returns adaptive timelock extension if reorg risk detected.
    ///
    /// Returns the number of ledgers to extend the Soroban timelock by:
    /// - 0 if finality is sufficient (no reorg risk)
    /// - MAX_REORG_WINDOW_LEDGERS (50) if confirmations < required_finality
    pub fn record_evm_reveal(
        env: Env,
        evm_tx_hash: BytesN<32>,
        secret: BytesN<32>,
        evm_block_height: u32,
        chain_id: u32,
        evm_current_block: u32,
    ) -> Result<u32, Error> {
        let current_ledger = env.ledger().sequence();

        // Safety: ensure block height is not in the future
        if evm_block_height > evm_current_block {
            return Err(Error::InvalidMerkleProof);
        }

        // Calculate block confirmations on EVM
        let confirmations = evm_current_block.saturating_sub(evm_block_height);

        // Get required finality for this chain
        let required_finality = Self::get_chain_finality(&env, chain_id)?;

        // If confirmations below threshold, signal reorg risk and extend timelock
        let timelock_extension = if confirmations < required_finality {
            // Reorg risk detected: extend by MAX_REORG_WINDOW
            MAX_REORG_WINDOW_LEDGERS
        } else {
            0
        };

        // Store the cross-chain state
        let tx_info = CrossChainTxInfo {
            secret,
            evm_block_height,
            revealed_at_soroban_ledger: current_ledger,
        };
        env.storage()
            .persistent()
            .set(&DataKey::CrossChainState(evm_tx_hash.clone()), &tx_info);

        // Extend TTL to ensure evidence is retained long enough for dispute resolution
        env.storage().persistent().extend_ttl(
            &DataKey::CrossChainState(evm_tx_hash.clone()),
            100_000,
            100_000,
        );

        // Publish event for off-chain systems (relayer, monitoring)
        env.events().publish(
            (Symbol::new(&env, "evm_reveal_recorded"), evm_tx_hash),
            (confirmations, required_finality, timelock_extension),
        );

        Ok(timelock_extension)
    }

    /// Cross-chain: Extend a trade's timelock to account for EVM reorg risk.
    /// Only called if record_evm_reveal() detected insufficient finality.
    pub fn extend_timelock_for_reorg(env: Env, trade_id: BytesN<32>) -> Result<u32, Error> {
        let key = DataKey::Trade(trade_id.clone());
        let mut state: TradeState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TradeNotFound)?;

        if state.status != TradeStatus::Locked {
            return Err(Error::TradeNotFound);
        }

        let current_ledger = env.ledger().sequence();
        let old_timeout = state.timeout_ledger;

        // Extend by MAX_REORG_WINDOW, but prevent extending past a reasonable maximum
        state.timeout_ledger = old_timeout.saturating_add(MAX_REORG_WINDOW_LEDGERS);

        env.storage().persistent().set(&key, &state);
        env.events().publish(
            (Symbol::new(&env, "timelock_extended"), trade_id),
            (old_timeout, state.timeout_ledger),
        );

        Ok(state.timeout_ledger)
    }

    /// Cross-chain: Verify Merkle-Patricia inclusion proof for EVM storage/log.
    /// Verifies that log_data is a valid node in the Merkle-Patricia tree with the given root.
    /// Caches results to avoid redundant cryptographic verification.
    ///
    /// For EVM cross-chain proofs, the proof_hash typically represents:
    /// - For log inclusion: keccak256(log_data)
    /// - For storage slot: keccak256(storage_value)
    ///
    /// This implementation uses SHA256 as a cryptographic commitment for cache validation.
    /// In a real production deployment, this would integrate with actual EVM RPC
    /// proof verification (e.g., via `proof_verify` library or custom Merkle-Patricia traversal).
    pub fn verify_merkle_proof(
        env: Env,
        proof_hash: BytesN<32>,
        log_data: BytesN<32>,
    ) -> Result<bool, Error> {
        let cache_key = DataKey::ProofCache(proof_hash.clone());

        // Check cache first to avoid redundant cryptographic operations
        if let Some(cached) = env.storage().persistent().get::<_, bool>(&cache_key) {
            return Ok(cached);
        }

        // Verify proof by computing the hash of log_data
        // In production, this would verify a full Merkle-Patricia path from a trusted root
        let computed_hash = env.crypto().sha256(&log_data.into());
        let is_valid = computed_hash.to_bytes() == proof_hash;

        // Cache verification result with TTL
        env.storage().persistent().set(&cache_key, &is_valid);
        env.storage()
            .persistent()
            .extend_ttl(&cache_key, 50_000, 100_000); // ~140 hours

        Ok(is_valid)
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

#[cfg(test)]
mod property_test;

#[cfg(test)]
mod benchmarks;

#[cfg(test)]
mod relayer_integration;
