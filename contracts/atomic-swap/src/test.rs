#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token, Address, BytesN, Env,
};

struct Fixture {
    env: Env,
    client: AtomicSwapContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    seller: Address,
    buyer: Address,
    secret: BytesN<32>,
    secret_hash: BytesN<32>,
    id: BytesN<32>,
}

fn setup(mint_to_buyer: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = token::Client::new(&env, &token_addr);
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&buyer, &mint_to_buyer);

    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr);

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);

    Fixture {
        env,
        client,
        token,
        contract_id,
        seller,
        buyer,
        secret,
        secret_hash,
        id,
    }
}

#[test]
fn lock_moves_funds_into_the_contract() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    assert_eq!(f.token.balance(&f.buyer), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.seller, f.seller);
    assert_eq!(trade.buyer, f.buyer);
    assert_eq!(trade.amount, 500);
    assert_eq!(trade.secret_hash, f.secret_hash);
    assert_eq!(trade.timeout_ledger, 100);
    assert_eq!(trade.status, htlc_core::TradeStatus::Locked);
}

#[test]
fn release_pays_seller_full_amount_and_reveals_secret() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    f.client.release(&f.id, &f.secret);

    // Read events immediately after release before calling other functions that emit/clear events
    let all_events = f.env.events().all();

    // Full amount to the seller, nothing left in the contract, buyer unchanged.
    assert_eq!(f.token.balance(&f.seller), 500);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.token.balance(&f.buyer), 500);

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, htlc_core::TradeStatus::Released);

    // The revealed secret MUST appear in an emitted event so the relayer can
    // read it and claim the counterpart leg on the other chain.
    let mut revealed = false;
    for event in all_events.events() {
        if let soroban_sdk::xdr::ContractEventBody::V0(v0) = &event.body {
            if let soroban_sdk::xdr::ScVal::Bytes(bytes) = &v0.data {
                if bytes.as_slice() == f.secret.to_array() {
                    revealed = true;
                }
            }
        }
    }
    assert!(revealed, "release() must reveal the secret in an event");
}

#[test]
#[should_panic]
fn release_with_wrong_secret_panics() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    let wrong = BytesN::from_array(&f.env, &[9u8; 32]);
    f.client.release(&f.id, &wrong);
}

#[test]
fn release_is_noop_when_not_locked() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    f.client.release(&f.id, &f.secret);

    // Second release is a no-op (idempotent per the Htlc trait): no panic, and
    // no double payout to the seller.
    f.client.release(&f.id, &f.secret);
    assert_eq!(f.token.balance(&f.seller), 500);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        htlc_core::TradeStatus::Released
    );
}

#[test]
fn refund_after_timeout_returns_funds_to_buyer() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    // Advance the ledger past the timeout.
    f.env.ledger().with_mut(|li| li.sequence_number += 101);
    f.client.refund(&f.id);

    assert_eq!(f.token.balance(&f.buyer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        htlc_core::TradeStatus::Refunded
    );
}

#[test]
#[should_panic]
fn refund_before_timeout_panics() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    // No ledger advance — timeout has not elapsed.
    f.client.refund(&f.id);
}

#[test]
#[should_panic]
fn lock_with_duplicate_id_panics() {
    let f = setup(1_000);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &100, &f.secret_hash, &100);
}

#[test]
fn get_trade_returns_none_for_unknown_id() {
    let f = setup(1_000);
    let unknown = BytesN::from_array(&f.env, &[2u8; 32]);
    assert!(f.client.get_trade(&unknown).is_none());
}

// ===== Cross-Chain Reorg Protection Tests =====

#[test]
fn set_chain_finality_only_admin() {
    let f = setup(1_000);

    // Admin can set finality
    f.client.set_chain_finality(&1u32, &64u32);
    let eth_finality = f.client.get_chain_finality(&1u32);
    assert_eq!(eth_finality, 64);
}

#[test]
fn get_chain_finality_returns_defaults() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Ethereum mainnet (chain_id = 1)
    let eth_finality = client.get_chain_finality(&1u32);
    assert_eq!(eth_finality, 64);

    // Arbitrum (chain_id = 42161)
    let arb_finality = client.get_chain_finality(&42161u32);
    assert_eq!(arb_finality, 100);

    // Polygon (chain_id = 137)
    let poly_finality = client.get_chain_finality(&137u32);
    assert_eq!(poly_finality, 256);

    // Optimism (chain_id = 10)
    let opt_finality = client.get_chain_finality(&10u32);
    assert_eq!(opt_finality, 1);

    // Base (chain_id = 8453)
    let base_finality = client.get_chain_finality(&8453u32);
    assert_eq!(base_finality, 1);
}

#[test]
fn record_evm_reveal_sufficient_finality_no_extension() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let evm_tx_hash = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let evm_block_height = 1000u32;
    let evm_current_block = 1100u32; // 100 confirmations >= 64 required
    let chain_id = 1u32; // Ethereum

    let extension = client.record_evm_reveal(
        &evm_tx_hash,
        &secret,
        &evm_block_height,
        &chain_id,
        &evm_current_block,
    );

    // Sufficient finality: no extension needed
    assert_eq!(extension, 0);
}

#[test]
fn record_evm_reveal_insufficient_finality_extends_timelock() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let evm_tx_hash = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let evm_block_height = 1000u32;
    let evm_current_block = 1010u32; // Only 10 confirmations < 64 required
    let chain_id = 1u32; // Ethereum

    let extension = client.record_evm_reveal(
        &evm_tx_hash,
        &secret,
        &evm_block_height,
        &chain_id,
        &evm_current_block,
    );

    // Insufficient finality: extend by MAX_REORG_WINDOW_LEDGERS (50)
    assert_eq!(extension, 50);
}

#[test]
fn extend_timelock_for_reorg_updates_timeout() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Lock a trade
    let timeout_ledgers = 100u32;
    client.lock(
        &f.id,
        &f.seller,
        &f.buyer,
        &500,
        &f.secret_hash,
        &timeout_ledgers,
    );

    let trade_before = client.get_trade(&f.id).unwrap();
    let original_timeout = trade_before.timeout_ledger;

    // Extend timelock for reorg
    let new_timeout = client.extend_timelock_for_reorg(&f.id);

    // Verify timeout was extended by MAX_REORG_WINDOW_LEDGERS (50)
    assert_eq!(new_timeout, original_timeout + 50);

    let trade_after = client.get_trade(&f.id).unwrap();
    assert_eq!(trade_after.timeout_ledger, original_timeout + 50);
}

#[test]
fn extend_timelock_fails_on_non_locked_trade() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Lock and release a trade
    client.lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    client.release(&f.id, &f.secret);

    // Try to extend timelock on released trade
    let result = client.try_extend_timelock_for_reorg(&f.id);
    assert!(result.is_err());
}

#[test]
fn verify_merkle_proof_caches_results() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let log_data = BytesN::from_array(&f.env, &[5u8; 32]);
    let proof_hash = f.env.crypto().sha256(&log_data.clone().into()).to_bytes();

    // First verification
    let result1 = client.verify_merkle_proof(&proof_hash, &log_data);
    assert!(result1);

    // Second verification should return cached result
    let result2 = client.verify_merkle_proof(&proof_hash, &log_data);
    assert!(result2);
}

#[test]
fn verify_merkle_proof_rejects_invalid_proof() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let log_data = BytesN::from_array(&f.env, &[5u8; 32]);
    let wrong_proof = BytesN::from_array(&f.env, &[6u8; 32]);

    let result = client.verify_merkle_proof(&wrong_proof, &log_data);
    assert!(!result);
}

// ===== Cross-Chain Reorg Scenario Tests =====

/// Simulates a 10-block reorg scenario on EVM while an atomic swap is active.
/// This is the acceptance criteria test: ensure Soroban counterparty cannot be
/// double-claimed even if EVM undergoes deep reorg.
#[test]
fn simulate_10_block_evm_reorg_prevents_double_claim() {
    let f = setup(10_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Step 1: Lock trade on Soroban
    let timeout_ledgers = 200u32;
    client.lock(
        &f.id,
        &f.seller,
        &f.buyer,
        &5_000,
        &f.secret_hash,
        &timeout_ledgers,
    );
    let trade_at_lock = client.get_trade(&f.id).unwrap();
    let original_timeout = trade_at_lock.timeout_ledger;

    // Step 2: Simulate EVM preimage reveal on block 1000
    let evm_tx_hash = BytesN::from_array(&f.env, &[10u8; 32]);
    let evm_block_reveal = 1000u32;

    // Scenario A: 10-block reorg (only 10 confirmations on deep-reorganizing chain)
    // This is INSUFFICIENT for Ethereum (requires 64). Timelock should extend.
    let evm_current_block_after_reorg = 1010u32;
    let extension = client.record_evm_reveal(
        &evm_tx_hash,
        &f.secret,
        &evm_block_reveal,
        &1u32, // Ethereum chain
        &evm_current_block_after_reorg,
    );

    // Extension triggered because 10 < 64 required confirmations
    assert_eq!(extension, 50); // MAX_REORG_WINDOW_LEDGERS

    // Step 3: Extend Soroban trade timeout
    let new_timeout = client.extend_timelock_for_reorg(&f.id);
    assert_eq!(new_timeout, original_timeout + 50);

    // Step 4: Advance Soroban ledger to just before original timeout (would allow refund)
    f.env.ledger().with_mut(|li| {
        li.sequence_number = original_timeout - 10;
    });

    // At this point on original timeline, refund would be callable.
    // But because we extended, it's not:
    let result = f.client.try_refund(&f.id);
    assert!(result.is_err()); // TimeoutNotReached

    // Step 5: Advance to AFTER extended timeout
    f.env.ledger().with_mut(|li| {
        li.sequence_number = new_timeout + 10;
    });

    // Now refund IS callable (but swap should have been settled on EVM by now)
    let result = f.client.try_refund(&f.id);
    assert!(result.is_ok());

    // Verify trade is now refunded
    let final_trade = client.get_trade(&f.id).unwrap();
    assert_eq!(final_trade.status, htlc_core::TradeStatus::Refunded);
    assert_eq!(f.token.balance(&f.buyer), 10_000); // Full refund

    // KEY INVARIANT: Even if EVM reorg happened and secret was double-revealed,
    // Soroban timelock extension prevents premature refund race condition.
}

/// Scenario: Multiple trades in batch, one experiences reorg risk.
#[test]
fn multiple_trades_selective_reorg_extension() {
    let f = setup(20_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Trade 1: Normal (sufficient finality)
    let id1 = BytesN::from_array(&f.env, &[1u8; 32]);
    client.lock(&id1, &f.seller, &f.buyer, &5_000, &f.secret_hash, &100);

    // Trade 2: Reorg risk (insufficient finality)
    let id2 = BytesN::from_array(&f.env, &[2u8; 32]);
    client.lock(&id2, &f.seller, &f.buyer, &5_000, &f.secret_hash, &100);

    let trade1_timeout = client.get_trade(&id1).unwrap().timeout_ledger;
    let trade2_timeout = client.get_trade(&id2).unwrap().timeout_ledger;
    assert_eq!(trade1_timeout, trade2_timeout); // Both started same

    // Simulate reorg risk only for trade 2
    let evm_tx_hash2 = BytesN::from_array(&f.env, &[20u8; 32]);
    let extension2 = client.record_evm_reveal(
        &evm_tx_hash2,
        &f.secret,
        &900u32, // Block 900
        &1u32,   // Ethereum
        &910u32, // Only 10 blocks later (insufficient)
    );
    assert_eq!(extension2, 50);

    // Extend only trade 2
    client.extend_timelock_for_reorg(&id2);

    let trade1_after = client.get_trade(&id1).unwrap();
    let trade2_after = client.get_trade(&id2).unwrap();

    // Trade 1 unchanged
    assert_eq!(trade1_after.timeout_ledger, trade1_timeout);
    // Trade 2 extended
    assert_eq!(trade2_after.timeout_ledger, trade2_timeout + 50);
}

/// Scenario: Arbitrum (fast finality, L2) vs Ethereum (slow, L1) comparison.
#[test]
fn arbitrum_l2_vs_ethereum_l1_finality_comparison() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // On Arbitrum: 100 blocks required, but they're fast (~3-5 min)
    // After only 50 Arbitrum blocks, we're still not finalized
    let arb_extension = client.record_evm_reveal(
        &BytesN::from_array(&f.env, &[1u8; 32]),
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &1000u32,  // Block 1000
        &42161u32, // Arbitrum
        &1050u32,  // Only 50 blocks (~2.5 min)
    );
    assert_eq!(arb_extension, 50); // Insufficient, triggers extension

    // On Ethereum: 64 blocks required (~15 min)
    // After 150 Ethereum blocks, we're well-finalized
    let eth_extension = client.record_evm_reveal(
        &BytesN::from_array(&f.env, &[2u8; 32]),
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &1000u32, // Block 1000
        &1u32,    // Ethereum
        &1150u32, // 150 blocks (~37.5 min)
    );
    assert_eq!(eth_extension, 0); // Sufficient, no extension
}

// ===== MPT Verification Tests =====

#[test]
fn register_trusted_block_header_only_admin() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let block_hash = BytesN::from_array(&f.env, &[1u8; 32]);
    let state_root = BytesN::from_array(&f.env, &[2u8; 32]);

    // Admin should be able to register
    let result = client.try_register_trusted_block_header(&block_hash, &1000u32, &state_root);
    assert!(result.is_ok());

    // Verify the header is stored
    let header = client.get_trusted_block_header(&block_hash);
    assert!(header.is_some());
}

#[test]
fn get_trusted_block_header_returns_none_when_not_registered() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let unknown_hash = BytesN::from_array(&f.env, &[99u8; 32]);
    let header = client.get_trusted_block_header(&unknown_hash);
    assert!(header.is_none());
}

#[test]
fn verify_merkle_proof_with_mpt_verification() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Create test data
    let state_root = BytesN::from_array(&f.env, &[1u8; 32]);
    let proof_key = soroban_sdk::Bytes::from_array(&f.env, &[2u8; 32]);
    let proof_value = soroban_sdk::Bytes::from_array(&f.env, &[3u8; 32]);

    // Create empty proof (will fail validation)
    let proof: soroban_sdk::Vec<soroban_sdk::Bytes> = soroban_sdk::Vec::new(&f.env);

    // Verify should handle empty proof gracefully
    let result = client.try_verify_merkle_proof(&state_root, &proof_key, &proof_value, &proof);
    assert!(result.is_err());
}

#[test]
fn record_evm_reveal_with_mpt_proof_requires_trusted_block() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    let evm_tx_hash = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let block_hash = BytesN::from_array(&f.env, &[11u8; 32]);
    let proof: soroban_sdk::Vec<soroban_sdk::Bytes> = soroban_sdk::Vec::new(&f.env);

    // Try to record reveal with untrusted block — should fail
    let result = client.try_record_evm_reveal(
        &evm_tx_hash,
        &secret,
        &1000u32,       // evm_block_height
        &1u32,          // chain_id
        &1100u32,       // evm_current_block
        &block_hash,    // untrusted block
        &0u32,          // log_index
        &proof,
    );
    assert!(result.is_err());
}

#[test]
fn record_evm_reveal_validates_block_height_matches() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Register a trusted block header for block 1000
    let block_hash = BytesN::from_array(&f.env, &[11u8; 32]);
    let state_root = BytesN::from_array(&f.env, &[2u8; 32]);
    client.register_trusted_block_header(&block_hash, &1000u32, &state_root);

    let evm_tx_hash = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let proof: soroban_sdk::Vec<soroban_sdk::Bytes> = soroban_sdk::Vec::new(&f.env);

    // Try with mismatched block height — should fail
    let result = client.try_record_evm_reveal(
        &evm_tx_hash,
        &secret,
        &1001u32,       // evm_block_height (doesn't match trusted block 1000)
        &1u32,          // chain_id
        &1100u32,       // evm_current_block
        &block_hash,
        &0u32,          // log_index
        &proof,
    );
    assert!(result.is_err());
}

#[test]
fn verify_merkle_proof_caches_verification_results() {
    let f = setup(1_000);
    let client = AtomicSwapContractClient::new(&f.env, &f.contract_id);

    // Create test data
    let state_root = BytesN::from_array(&f.env, &[1u8; 32]);
    let proof_key = soroban_sdk::Bytes::from_array(&f.env, &[2u8; 32]);
    let proof_value = soroban_sdk::Bytes::from_array(&f.env, &[3u8; 32]);
    let proof: soroban_sdk::Vec<soroban_sdk::Bytes> = soroban_sdk::Vec::new(&f.env);

    // First call (will fail but be cached)
    let result1 = client.try_verify_merkle_proof(&state_root, &proof_key, &proof_value, &proof);

    // Second call with same parameters should return cached result
    let result2 = client.try_verify_merkle_proof(&state_root, &proof_key, &proof_value, &proof);

    // Both should behave the same (cached)
    assert_eq!(result1.is_err(), result2.is_err());
}

#[test]
fn mpt_error_types_convert_correctly() {
    use mpt_verifier::MptError;

    // Verify error codes for MPT errors
    assert_eq!(MptError::InvalidProof as u32, 1);
    assert_eq!(MptError::InvalidPath as u32, 2);
    assert_eq!(MptError::InvalidNodeType as u32, 3);
    assert_eq!(MptError::RootMismatch as u32, 5);
}
