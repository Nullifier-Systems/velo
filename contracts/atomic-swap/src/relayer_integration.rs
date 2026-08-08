#![cfg(test)]

/// Relayer integration tests for cross-chain atomic swaps.
///
/// These tests simulate real-world relayer behavior:
/// 1. Relayer observes EVM HTLC state (block height, confirmations)
/// 2. Calls record_evm_reveal() if preimage is revealed
/// 3. System may request timelock extension based on finality
/// 4. Relayer monitors Soroban for release() event to complete EVM side
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env,
};

struct SwapScenario {
    env: Env,
    client: AtomicSwapContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    seller: Address,
    buyer: Address,
    secret: BytesN<32>,
    secret_hash: BytesN<32>,
    trade_id: BytesN<32>,
}

fn setup_swap(mint_to_buyer: i128) -> SwapScenario {
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
    client.initialize(&admin, &token_addr).unwrap();

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let trade_id = BytesN::from_array(&env, &[1u8; 32]);

    SwapScenario {
        env,
        client,
        token,
        contract_id,
        seller,
        buyer,
        secret,
        secret_hash,
        trade_id,
    }
}

/// Happy path: Ethereum swap with sufficient finality (no reorg risk)
///
/// Flow:
/// 1. Buyer locks USDC on Soroban
/// 2. Relayer observes HTLC.sol preimage reveal on Ethereum (100 blocks deep)
/// 3. Finality is sufficient (100 > 64), no timelock extension
/// 4. Relayer calls release() on Soroban to complete swap
#[test]
fn relayer_eth_swap_sufficient_finality_happy_path() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &200, // 200 ledgers timeout
    );

    let trade_locked = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_locked.status, htlc_core::TradeStatus::Locked);

    // Relayer observes preimage reveal on Ethereum at block 1000
    let evm_tx_hash = BytesN::from_array(&s.env, &[11u8; 32]);
    let evm_reveal_block = 1000u32;
    let evm_current_block = 1100u32; // 100 confirmations

    let extension = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &evm_reveal_block,
            &1u32, // Ethereum
            &evm_current_block,
        )
        .unwrap();

    // No extension needed (100 > 64)
    assert_eq!(extension, 0);

    // Relayer proceeds to release on Soroban
    s.client.release(&s.trade_id, &s.secret);

    // Verify funds transferred to seller
    assert_eq!(s.token.balance(&s.seller), 5_000);
    assert_eq!(s.token.balance(&s.contract_id), 0);

    let trade_released = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_released.status, htlc_core::TradeStatus::Released);
}

/// Reorg risk scenario: Ethereum swap with insufficient finality
///
/// Flow:
/// 1. Buyer locks USDC on Soroban
/// 2. Relayer observes HTLC.sol preimage reveal on Ethereum (only 10 blocks deep)
/// 3. Finality is INSUFFICIENT (10 < 64), system requests timelock extension
/// 4. Timelock is extended by 50 ledgers (~5 min buffer)
/// 5. Relayer waits for more confirmations before releasing
/// 6. After more confirmations, relayer releases on Soroban
#[test]
fn relayer_eth_swap_reorg_risk_triggers_timelock_extension() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &200, // 200 ledgers timeout
    );

    let trade_locked = s.client.get_trade(&s.trade_id).unwrap();
    let original_timeout = trade_locked.timeout_ledger;

    // Relayer observes preimage reveal on Ethereum at block 1000,
    // but chain is reorganizing — only 10 blocks deep
    let evm_tx_hash = BytesN::from_array(&s.env, &[12u8; 32]);
    let evm_reveal_block = 1000u32;
    let evm_current_block_early = 1010u32; // Only 10 confirmations (reorg risk!)

    let extension = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &evm_reveal_block,
            &1u32, // Ethereum
            &evm_current_block_early,
        )
        .unwrap();

    // Extension triggered (10 < 64)
    assert_eq!(extension, 50);

    // Relayer should extend timelock on Soroban to protect against race condition
    let new_timeout = s.client.extend_timelock_for_reorg(&s.trade_id).unwrap();
    assert_eq!(new_timeout, original_timeout + 50);

    // Simulate waiting for more confirmations (~5 min later in real time)
    let evm_current_block_later = 1100u32; // Now 100 blocks deep
    let _further_check = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &evm_reveal_block,
            &1u32,
            &evm_current_block_later,
        )
        .unwrap();

    // Now relayer can safely release on Soroban
    s.client.release(&s.trade_id, &s.secret);

    let trade_released = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_released.status, htlc_core::TradeStatus::Released);
}

/// Arbitrum L2 scenario: Fast-finalized swap
///
/// Flow:
/// 1. Buyer locks USDC on Soroban
/// 2. Relayer observes Arbitrum HTLC preimage reveal
/// 3. Arbitrum requires 100 blocks for finality (3-5 min)
/// 4. At insufficient finality, system extends timelock
/// 5. Relayer waits and then releases
#[test]
fn relayer_arbitrum_l2_swap_finality_tracking() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &200,
    );

    let trade_locked = s.client.get_trade(&s.trade_id).unwrap();
    let original_timeout = trade_locked.timeout_ledger;

    // Relayer observes Arbitrum preimage reveal at block 50000
    let evm_tx_hash = BytesN::from_array(&s.env, &[13u8; 32]);
    let arb_reveal_block = 50_000u32;

    // Scenario 1: Early observation (only 30 blocks confirmed)
    let extension_early = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &arb_reveal_block,
            &42161u32,  // Arbitrum
            &50_030u32, // 30 blocks (< 100 required)
        )
        .unwrap();

    assert_eq!(extension_early, 50); // Extends timelock

    s.client.extend_timelock_for_reorg(&s.trade_id).unwrap();

    // Scenario 2: Later observation (now 120 blocks confirmed)
    let _extension_later = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &arb_reveal_block,
            &42161u32,  // Arbitrum
            &50_120u32, // 120 blocks (> 100 required)
        )
        .unwrap();
    // No extension returned (0), sufficient finality now

    // Relayer can release
    s.client.release(&s.trade_id, &s.secret);

    let trade_released = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_released.status, htlc_core::TradeStatus::Released);
}

/// Polygon scenario: Heavy chain with 256-block finality requirement
///
/// Tests handling of chains with very deep finality requirements.
#[test]
fn relayer_polygon_swap_deep_finality_requirement() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &300, // Longer timeout for Polygon's deep finality
    );

    // Relayer observes Polygon preimage reveal at block 100000
    let evm_tx_hash = BytesN::from_array(&s.env, &[14u8; 32]);
    let polygon_reveal_block = 100_000u32;

    // Early observation: only 100 blocks confirmed
    let extension_early = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &polygon_reveal_block,
            &137u32,     // Polygon
            &100_100u32, // 100 blocks (< 256 required)
        )
        .unwrap();

    assert_eq!(extension_early, 50); // Extends due to insufficient finality

    s.client.extend_timelock_for_reorg(&s.trade_id).unwrap();

    // Final observation: 300 blocks confirmed (well-finalized)
    let _extension_final = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &polygon_reveal_block,
            &137u32,
            &100_300u32, // 300 blocks (> 256 required)
        )
        .unwrap();

    s.client.release(&s.trade_id, &s.secret);

    let trade_released = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_released.status, htlc_core::TradeStatus::Released);
}

/// Edge case: Optimism/Base L2 chains with immediate finality
///
/// L2 optimistic rollups (Optimism, Base) have immediate finality (1 block).
/// Relayer should be able to release immediately without extension.
#[test]
fn relayer_optimism_l2_immediate_finality() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &100,
    );

    // Relayer observes Optimism preimage reveal
    let evm_tx_hash = BytesN::from_array(&s.env, &[15u8; 32]);

    // Even at block 1000 with only 1 confirmation, Optimism is finalized
    let extension = s
        .client
        .record_evm_reveal(
            &evm_tx_hash,
            &s.secret,
            &1000u32, // Block 1000
            &10u32,   // Optimism
            &1001u32, // 1 block (= 1 required)
        )
        .unwrap();

    // No extension needed (1 >= 1)
    assert_eq!(extension, 0);

    // Relayer releases immediately
    s.client.release(&s.trade_id, &s.secret);

    let trade_released = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_released.status, htlc_core::TradeStatus::Released);
}

/// Relayer error handling: Invalid secret on release attempt
///
/// If relayer reads the wrong secret from EVM (logic error or corruption),
/// release() should fail gracefully, and funds remain locked.
#[test]
fn relayer_error_wrong_secret_release_fails() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &200,
    );

    // Relayer records correct EVM reveal
    let evm_tx_hash = BytesN::from_array(&s.env, &[16u8; 32]);
    s.client
        .record_evm_reveal(&evm_tx_hash, &s.secret, &1000u32, &1u32, &1100u32)
        .unwrap();

    // But relayer submits wrong secret to Soroban (failure case)
    let wrong_secret = BytesN::from_array(&s.env, &[8u8; 32]);

    // This should panic (per contract design)
    let result = s.env.try_call_contract::<_, ()>(
        &s.contract_id,
        &Symbol::new(&s.env, "release"),
        (&s.trade_id, &wrong_secret),
    );
    assert!(result.is_err());

    // Funds remain locked (trade still in Locked state)
    let trade_still_locked = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_still_locked.status, htlc_core::TradeStatus::Locked);
}

/// Relayer timeout scenario: Preimage never revealed on EVM
///
/// If EVM HTLC refunds due to timeout before Soroban preimage is submitted,
/// relayer should not call release() and instead let Soroban refund callback trigger.
#[test]
fn relayer_timeout_no_preimage_on_evm() {
    let s = setup_swap(10_000);

    // Buyer locks USDC on Soroban
    s.client.lock(
        &s.trade_id,
        &s.seller,
        &s.buyer,
        &5_000,
        &s.secret_hash,
        &100, // Timeout in 100 ledgers
    );

    // Simulate EVM HTLC timing out (preimage never revealed)
    // Relayer would not call record_evm_reveal()

    // Advance Soroban past timeout
    s.env.ledger().with_mut(|li| li.sequence_number += 101);

    // Relayer triggers refund (or anyone can, it's permissionless)
    s.client.refund(&s.trade_id);

    // Funds returned to buyer
    assert_eq!(s.token.balance(&s.buyer), 10_000);
    let trade_refunded = s.client.get_trade(&s.trade_id).unwrap();
    assert_eq!(trade_refunded.status, htlc_core::TradeStatus::Refunded);
}
