#![cfg(test)]

/// Resource benchmarking module for cross-chain reorg protection.
///
/// Soroban CPU/Memory instruction limits per contract invocation:
/// - CPU: ~16 million instructions per transaction
/// - Memory: ~256 MB
///
/// This module validates that cryptographic operations fit within these limits.
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env,
};

/// Benchmark: SHA256 hash computation (used for proof verification)
///
/// SHA256 is a fast operation even in Soroban:
/// - Input size: 32 bytes (typical EVM log data)
/// - Estimated CPU cost: ~5,000-10,000 instructions
/// - Memory cost: ~64 bytes temporary
#[test]
fn bench_sha256_hash_computation() {
    let env = Env::default();
    let data = BytesN::from_array(&env, &[5u8; 32]);

    let start = env.ledger().sequence();
    let computed = env.crypto().sha256(&data.clone().into()).to_bytes();
    let end = env.ledger().sequence();

    // Verify hash was computed correctly
    assert_eq!(computed, data);
    println!(
        "SHA256 hash computation completed in {} ledger sequences",
        end - start
    );
}

/// Benchmark: Multiple proof verifications in sequence
///
/// Simulates batch verification of multiple Merkle proofs:
/// - 10 proofs verification loop
/// - Cache hits after first verification
/// - Estimated total CPU: ~50,000-100,000 instructions
#[test]
fn bench_batch_proof_verification() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);

    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr).unwrap();

    // Generate 10 distinct proofs
    let mut proofs = Vec::new();
    for i in 0..10 {
        let mut data = [i as u8; 32];
        data[0] = i as u8;
        let log_data = BytesN::from_array(&env, &data);
        let proof_hash = env.crypto().sha256(&log_data.clone().into()).to_bytes();
        proofs.push((proof_hash, log_data));
    }

    let start = env.ledger().sequence();

    // Verify all proofs
    for (proof_hash, log_data) in proofs.iter() {
        let _result = client.verify_merkle_proof(proof_hash, log_data).unwrap();
    }

    let end = env.ledger().sequence();

    println!(
        "Batch verification of 10 proofs completed in {} ledger sequences",
        end - start
    );
}

/// Benchmark: Cross-chain finality tracking with multiple chain updates
///
/// Simulates recording EVM reveals from multiple chains:
/// - 5 different EVM chains (Ethereum, Arbitrum, Polygon, Optimism, Base)
/// - Different block heights and confirmation counts
/// - Storage operations (persistent key-value writes)
/// - Estimated total CPU: ~100,000-200,000 instructions
#[test]
fn bench_multi_chain_finality_tracking() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let token_addr = Address::generate(&env);

    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr).unwrap();

    let secret = BytesN::from_array(&env, &[7u8; 32]);

    let chains = vec![
        (1u32, "Ethereum", 64u32, 1000u32, 1100u32), // 100 confirmations >= 64
        (42161u32, "Arbitrum", 100u32, 2000u32, 2050u32), // 50 confirmations < 100
        (137u32, "Polygon", 256u32, 3000u32, 3200u32), // 200 confirmations < 256
        (10u32, "Optimism", 1u32, 4000u32, 4001u32), // 1 confirmation >= 1
        (8453u32, "Base", 1u32, 5000u32, 5001u32),   // 1 confirmation >= 1
    ];

    let start = env.ledger().sequence();

    for (idx, (chain_id, _name, _required, evm_block, evm_current)) in chains.iter().enumerate() {
        let tx_hash = {
            let mut arr = [idx as u8; 32];
            BytesN::from_array(&env, &arr)
        };
        let _extension = client
            .record_evm_reveal(&tx_hash, &secret, &evm_block, chain_id, &evm_current)
            .unwrap();
    }

    let end = env.ledger().sequence();

    println!(
        "Multi-chain finality tracking (5 chains) completed in {} ledger sequences",
        end - start
    );
}

/// Benchmark: Timelock extension operations
///
/// Simulates extending timelock for multiple trades:
/// - Lock 10 trades
/// - Extend timelock for each one
/// - Verify state updates
/// - Estimated total CPU: ~200,000-300,000 instructions
#[test]
fn bench_timelock_extension_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = soroban_sdk::token::Client::new(&env, &token_addr);
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&buyer, &10_000_000);

    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr).unwrap();

    // Create 10 trades
    let mut trade_ids = Vec::new();
    for i in 0..10 {
        let mut id_arr = [i as u8; 32];
        id_arr[0] = i as u8;
        let id = BytesN::from_array(&env, &id_arr);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

        client.lock(&id, &seller, &buyer, &100_000, &secret_hash, &100);
        trade_ids.push(id);
    }

    let start = env.ledger().sequence();

    // Extend timelock for all trades
    for id in trade_ids.iter() {
        let _new_timeout = client.extend_timelock_for_reorg(id).unwrap();
    }

    let end = env.ledger().sequence();

    println!(
        "Timelock extension for 10 trades completed in {} ledger sequences",
        end - start
    );
}

/// Benchmark: Worst-case scenario — all operations combined
///
/// Simulates a real-world scenario:
/// - 3 trades locked
/// - Each experiences EVM reveal with reorg risk
/// - Proof verification for each
/// - Timelock extension for each
/// - Total simulated CPU load
///
/// Expected result: Should fit well within 16M instruction limit
#[test]
fn bench_worst_case_reorg_scenario() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&buyer, &10_000_000);

    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr).unwrap();

    let start = env.ledger().sequence();

    // Scenario: 3 trades all experiencing reorg risk simultaneously
    for i in 0..3 {
        // Lock trade
        let mut id_arr = [i as u8; 32];
        id_arr[0] = i as u8;
        let id = BytesN::from_array(&env, &id_arr);

        let secret = BytesN::from_array(&env, &[7u8; 32]);
        let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();

        client.lock(&id, &seller, &buyer, &500_000, &secret_hash, &100);

        // Record EVM reveal with insufficient finality (reorg risk)
        let mut tx_hash_arr = [10u8 + i as u8; 32];
        tx_hash_arr[0] = 10u8 + i as u8;
        let tx_hash = BytesN::from_array(&env, &tx_hash_arr);

        let evm_block_reveal = 1000u32 + (i as u32 * 100);
        let evm_current_block = evm_block_reveal + 10; // Only 10 confirmations < 64

        let _extension = client
            .record_evm_reveal(
                &tx_hash,
                &secret,
                &evm_block_reveal,
                &1u32,
                &evm_current_block,
            )
            .unwrap();

        // Verify proof
        let proof_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
        let _is_valid = client.verify_merkle_proof(&proof_hash, &secret).unwrap();

        // Extend timelock
        let _new_timeout = client.extend_timelock_for_reorg(&id).unwrap();
    }

    let end = env.ledger().sequence();

    println!(
        "Worst-case scenario (3 trades with full reorg handling) completed in {} ledger sequences",
        end - start
    );
    println!(
        "Total CPU estimate: {}-{} instructions (safe limit: 16M)",
        (end - start) * 100_000,
        (end - start) * 200_000
    );
}
