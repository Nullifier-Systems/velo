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

use htlc_core::{Htlc, TradeState, TradeStatus, Tranche};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Symbol,
};

mod mpt_verifier;
use mpt_verifier::{MptError, MptVerifier};

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
    /// Track if timelock was extended for a trade
    TimelockExtended(BytesN<32>),
    /// Trusted EVM block headers: block_hash -> (block_number, state_root)
    TrustedBlockHeader(BytesN<32>), // block_hash -> (u32, BytesN<32>)
    /// MPT root for state at a specific EVM block: (chain_id, block_hash) -> state_root
    MptStateRoot((u32, BytesN<32>)), // (chain_id, block_hash) -> state_root
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
    /// MPT verification: invalid proof structure
    MptInvalidProof = 15,
    /// MPT verification: proof path doesn't match expected key
    MptInvalidPath = 16,
    /// MPT verification: root hash mismatch
    MptRootMismatch = 17,
    /// Block header not trusted or not found
    UntrustedBlockHeader = 18,
    /// Invalid block height or block not finalized
    InvalidBlockHeight = 19,
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

/// Trusted EVM block header information
#[derive(Clone)]
#[contracttype]
pub struct TrustedBlockHeaderInfo {
    /// Block number on the EVM chain
    pub block_number: u32,
    /// State root (MPT root) for this block
    pub state_root: BytesN<32>,
    /// Timestamp when this header was first trusted (Soroban ledger sequence)
    pub trusted_at_ledger: u32,
}

const DEFAULT_TIMEOUT_LEDGERS_MAX: u32 = 6 * 60 * 24 * 7; // ~7 days at 10s/ledger, sanity cap

/// TTL extension (in ledgers) for persistent storage entries — ~5.8 days at
/// ~5s/ledger. Applied on every active interaction that writes a persistent key
/// so the entry remains observable until settlement completes.
const TTL_EXTEND: u32 = 100_000;

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

    /// Cross-chain: Register a trusted EVM block header.
    /// Only callable by admin. This establishes a trusted state root for MPT verification.
    ///
    /// # Arguments
    /// * `block_hash` - The keccak256 hash of the EVM block header
    /// * `block_number` - The block number on the EVM chain
    /// * `state_root` - The Merkle root of the EVM state trie for this block
    pub fn register_trusted_block_header(
        env: Env,
        block_hash: BytesN<32>,
        block_number: u32,
        state_root: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let current_ledger = env.ledger().sequence();
        let header_info = TrustedBlockHeaderInfo {
            block_number,
            state_root,
            trusted_at_ledger: current_ledger,
        };

        let key = DataKey::TrustedBlockHeader(block_hash.clone());
        env.storage().persistent().set(&key, &header_info);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "block_header_trusted"), block_hash),
            block_number,
        );

        Ok(())
    }

    /// Cross-chain: Get trusted block header information.
    /// Returns None if the block header is not trusted.
    pub fn get_trusted_block_header(
        env: Env,
        block_hash: BytesN<32>,
    ) -> Option<TrustedBlockHeaderInfo> {
        env.storage()
            .persistent()
            .get(&DataKey::TrustedBlockHeader(block_hash))
    }

    /// Cross-chain: Record EVM secret reveal with MPT proof verification.
    /// Called by relayer after observing LogHTLCWithdraw on EVM with cryptographic proof.
    /// Validates the secret against the EVM state using Merkle-Patricia Trie proofs.
    /// Stores secret + block metadata. Returns adaptive timelock extension if reorg risk detected.
    ///
    /// # Arguments
    /// * `evm_tx_hash` - Hash of the EVM transaction revealing the secret
    /// * `secret` - The revealed preimage
    /// * `evm_block_height` - Block number where the secret was revealed on EVM
    /// * `chain_id` - Chain ID of the EVM network
    /// * `evm_current_block` - Current block number on the EVM network
    /// * `block_hash` - Hash of the EVM block containing the reveal
    /// * `log_index` - Index of the log in the transaction
    /// * `mpt_proof` - Merkle-Patricia Trie proof nodes
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
        block_hash: BytesN<32>,
        log_index: u32,
        mpt_proof: soroban_sdk::Vec<soroban_sdk::Bytes>,
    ) -> Result<u32, Error> {
        let current_ledger = env.ledger().sequence();

        // Safety: ensure block height is not in the future
        if evm_block_height > evm_current_block {
            return Err(Error::InvalidBlockHeight);
        }

        // Get trusted block header for this block
        let block_header = Self::get_trusted_block_header(env.clone(), block_hash.clone())
            .ok_or(Error::UntrustedBlockHeader)?;

        // Verify block height matches
        if block_header.block_number != evm_block_height {
            return Err(Error::InvalidBlockHeight);
        }

        // Verify the MPT proof
        let state_root = block_header.state_root;
        Self::verify_mpt_log_inclusion(
            &env,
            &state_root,
            &secret,
            &log_index.to_le_bytes().to_vec(),
            &mpt_proof,
        )?;

        // Calculate block confirmations on EVM
        let confirmations = evm_current_block.saturating_sub(evm_block_height);

        // Get required finality for this chain
        let required_finality = Self::get_chain_finality(env.clone(), chain_id)?;

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

    /// Helper: Verify MPT log inclusion proof
    /// Verifies that a log with the given secret is included in the state trie
    fn verify_mpt_log_inclusion(
        env: &Env,
        state_root: &BytesN<32>,
        secret: &BytesN<32>,
        log_key: &soroban_sdk::Bytes,
        mpt_proof: &soroban_sdk::Vec<soroban_sdk::Bytes>,
    ) -> Result<(), Error> {
        let verifier = MptVerifier::new(state_root.clone());

        let secret_bytes = soroban_sdk::Bytes::from_slice(&env, secret.as_ref());

        match verifier.verify(env, &log_key, &secret_bytes, &mpt_proof) {
            Ok(true) => Ok(()),
            Ok(false) => Err(Error::ProofVerificationFailed),
            Err(MptError::InvalidProof) => Err(Error::MptInvalidProof),
            Err(MptError::InvalidPath) => Err(Error::MptInvalidPath),
            Err(MptError::RootMismatch) => Err(Error::MptRootMismatch),
            Err(_) => Err(Error::ProofVerificationFailed),
        }
    }

    /// Cross-chain: Extend a trade's timelock to account for EVM reorg risk.
    /// Only called if record_evm_reveal() detected insufficient finality.
    /// Prevents double-extension for the same trade to protect against DoS attacks.
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

        let ext_key = DataKey::TimelockExtended(trade_id.clone());
        if env.storage().persistent().has(&ext_key) {
            return Err(Error::TimelockAlreadyExtended);
        }

        let _current_ledger = env.ledger().sequence();
        let old_timeout = state.timeout_ledger;

        // Extend by MAX_REORG_WINDOW, but prevent extending past a reasonable maximum
        state.timeout_ledger = old_timeout.saturating_add(MAX_REORG_WINDOW_LEDGERS);

        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

        env.storage().persistent().set(&ext_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&ext_key, TTL_EXTEND, TTL_EXTEND);

        env.events().publish(
            (Symbol::new(&env, "timelock_extended"), trade_id),
            (old_timeout, state.timeout_ledger),
        );

        Ok(state.timeout_ledger)
    }

    /// Cross-chain: Verify Merkle-Patricia inclusion proof for EVM storage/log.
    /// Verifies that log_data is a valid node in the Merkle-Patricia tree with the given root.
    /// Uses deterministic MPT traversal for cryptographic security.
    ///
    /// # Arguments
    /// * `state_root` - The MPT root hash (from a trusted block header)
    /// * `proof_key` - The key path in the MPT (typically keccak256(storage_slot))
    /// * `proof_value` - The expected value at this key
    /// * `mpt_proof` - Vector of encoded MPT nodes representing the Merkle path
    ///
    /// Returns `Ok(true)` if the value is correctly included in the MPT
    pub fn verify_merkle_proof(
        env: Env,
        state_root: BytesN<32>,
        proof_key: soroban_sdk::Bytes,
        proof_value: soroban_sdk::Bytes,
        mpt_proof: soroban_sdk::Vec<soroban_sdk::Bytes>,
    ) -> Result<bool, Error> {
        // Compute cache key from proof components to detect duplicate verifications
        let cache_input = soroban_sdk::Bytes::from_slice(
            &env,
            &[
                state_root.as_ref(),
                proof_key.as_ref(),
                proof_value.as_ref(),
            ]
            .concat(),
        );
        let cache_hash = env.crypto().sha256(&cache_input);
        let cache_key_bytes: BytesN<32> = cache_hash.try_into().unwrap_or_else(|_| BytesN::new());
        let cache_key = DataKey::ProofCache(cache_key_bytes);

        // Check cache first to avoid redundant cryptographic operations
        if let Some(cached) = env.storage().persistent().get::<_, bool>(&cache_key) {
            return Ok(cached);
        }

        // Perform MPT verification
        let verifier = MptVerifier::new(state_root);
        let is_valid = match verifier.verify(&env, &proof_key, &proof_value, &mpt_proof) {
            Ok(result) => result,
            Err(MptError::InvalidProof) => return Err(Error::MptInvalidProof),
            Err(MptError::InvalidPath) => return Err(Error::MptInvalidPath),
            Err(MptError::RootMismatch) => return Err(Error::MptRootMismatch),
            Err(_) => return Err(Error::ProofVerificationFailed),
        };

        // Cache verification result with TTL for 140 hours
        env.storage().persistent().set(&cache_key, &is_valid);
        env.storage()
            .persistent()
            .extend_ttl(&cache_key, 50_000, 100_000);

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

        let mut tranches = soroban_sdk::Vec::new(&env);
        tranches.push_back(Tranche {
            amount,
            secret_hash: secret_hash.clone(),
            released: false,
        });

        let state = TradeState {
            seller,
            buyer,
            amount,
            tranches,
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
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

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
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_EXTEND, TTL_EXTEND);

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
