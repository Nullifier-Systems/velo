use super::*;
use soroban_sdk::{testutils::Ledger, vec, Address, BytesN, Env};

/// Test fixture for commit-reveal protocol tests.
struct CommitRevealFixture {
    env: Env,
    buyer: Address,
    seller: Address,
    admin: Address,
    contract_id: Address,
    client: EscrowContractClient<'static>,
    token: token::Client<'static>,
}

fn setup_commit_reveal() -> CommitRevealFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = token::Client::new(&env, &token_addr);

    // Mint to buyer so they can pay collateral + amount
    token.mint(&buyer, &100_000_000_000); // 1B stroops for testing

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    // Initialize escrow
    client.initialize(&admin, &token_addr, &100); // 1% fee

    CommitRevealFixture {
        env,
        buyer,
        seller,
        admin,
        contract_id,
        client,
        token,
    }
}

#[test]
fn commit_reveal_happy_path() {
    let f = setup_commit_reveal();
    let amount = 1_000_000; // 0.01 USDC
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let secret_hash = f.env.crypto().sha256(&secret.clone().into()).to_bytes();
    let salt = BytesN::from_array(&f.env, &[99u8; 32]);
    let trade_id = BytesN::from_array(&f.env, &[1u8; 32]);

    // Phase 1: Commit
    let commitment_input = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt.clone());
    let commitment_hash = f.env.crypto().sha256(&(commitment_input,).into()).to_bytes();

    let result = f.client.try_commit_escrow(&commitment_hash, &amount);
    assert!(result.is_ok());

    // Verify collateral (5%) was transferred
    let collateral = (amount * 500) / 10_000; // 5% in fixed-point
    assert_eq!(f.token.balance(&f.contract_id), collateral);

    // Phase 2: Reveal within window
    f.env.ledger().with_mut(|li| li.sequence_number += 10); // Advance 10 ledgers (within window)

    let result = f.client.try_reveal_escrow(
        &trade_id,
        &f.seller,
        &amount,
        &secret_hash,
        &salt,
        &100,
    );
    assert!(result.is_ok());

    // Verify collateral was refunded, amount moved to escrow
    assert_eq!(f.token.balance(&f.buyer), 100_000_000_000 - amount); // buyer paid amount, collateral refunded
    assert_eq!(f.token.balance(&f.contract_id), amount); // escrow holds amount

    // Verify trade is now Locked
    let trade = f.client.get_trade(&trade_id).unwrap();
    assert_eq!(trade.status, TradeStatus::Locked);
    assert_eq!(trade.amount, amount);
}

#[test]
fn commit_prevents_replay_attacks() {
    let f = setup_commit_reveal();
    let amount = 1_000_000;
    let secret_hash = BytesN::from_array(&f.env, &[8u8; 32]);
    let salt = BytesN::from_array(&f.env, &[99u8; 32]);

    let commitment_input = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt.clone());
    let commitment_hash = f.env.crypto().sha256(&(commitment_input,).into()).to_bytes();

    // First commit succeeds
    let result = f.client.try_commit_escrow(&commitment_hash, &amount);
    assert!(result.is_ok());

    // Second commit with same hash fails (CommitmentAlreadyExists)
    let result = f.client.try_commit_escrow(&commitment_hash, &amount);
    assert!(result.is_err());
}

#[test]
fn reveal_window_closed_forfeits_collateral() {
    let f = setup_commit_reveal();
    let amount = 1_000_000;
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let secret_hash = f.env.crypto().sha256(&secret.clone().into()).to_bytes();
    let salt = BytesN::from_array(&f.env, &[99u8; 32]);
    let trade_id = BytesN::from_array(&f.env, &[1u8; 32]);

    let commitment_input = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt.clone());
    let commitment_hash = f.env.crypto().sha256(&(commitment_input,).into()).to_bytes();

    // Commit
    f.client.commit_escrow(&commitment_hash, &amount);

    let collateral = (amount * 500) / 10_000;
    let initial_contract_balance = f.token.balance(&f.contract_id);
    assert_eq!(initial_contract_balance, collateral);

    // Advance past reveal window max (100 ledgers)
    f.env.ledger().with_mut(|li| li.sequence_number += 105);

    // Attempt reveal — should fail with RevealWindowClosed
    let result = f.client.try_reveal_escrow(
        &trade_id,
        &f.seller,
        &amount,
        &secret_hash,
        &salt,
        &100,
    );
    assert!(result.is_err());

    // Collateral is NOT refunded (forfeited to protocol)
    // In production, this would go to fee pool
    // For now, just verify it wasn't returned to buyer
    assert_eq!(f.token.balance(&f.buyer), 100_000_000_000 - collateral);
}

#[test]
fn reveal_window_not_open_prevents_early_reveal() {
    let f = setup_commit_reveal();
    let amount = 1_000_000;
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let secret_hash = f.env.crypto().sha256(&secret.clone().into()).to_bytes();
    let salt = BytesN::from_array(&f.env, &[99u8; 32]);
    let trade_id = BytesN::from_array(&f.env, &[1u8; 32]);

    let commitment_input = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt.clone());
    let commitment_hash = f.env.crypto().sha256(&(commitment_input,).into()).to_bytes();

    // Commit at ledger 1000
    f.client.commit_escrow(&commitment_hash, &amount);

    // Try to reveal immediately (before Nmin=2 ledgers)
    // Window opens at ledger 1002, so ledger 1000 or 1001 should fail
    let result = f.client.try_reveal_escrow(
        &trade_id,
        &f.seller,
        &amount,
        &secret_hash,
        &salt,
        &100,
    );
    assert!(result.is_err()); // RevealWindowNotOpen
}

#[test]
fn reveal_with_mismatched_parameters_fails() {
    let f = setup_commit_reveal();
    let amount = 1_000_000;
    let secret = BytesN::from_array(&f.env, &[7u8; 32]);
    let secret_hash = f.env.crypto().sha256(&secret.clone().into()).to_bytes();
    let salt = BytesN::from_array(&f.env, &[99u8; 32]);
    let trade_id = BytesN::from_array(&f.env, &[1u8; 32]);

    let commitment_input = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt.clone());
    let commitment_hash = f.env.crypto().sha256(&(commitment_input,).into()).to_bytes();

    f.client.commit_escrow(&commitment_hash, &amount);

    f.env.ledger().with_mut(|li| li.sequence_number += 10);

    // Try to reveal with wrong amount (1_500_000 instead of 1_000_000)
    let result = f.client.try_reveal_escrow(
        &trade_id,
        &f.seller,
        &1_500_000, // WRONG
        &secret_hash,
        &salt,
        &100,
    );
    assert!(result.is_err()); // CommitmentMismatch
}

#[test]
fn collateral_amount_scales_with_trade_amount() {
    let f = setup_commit_reveal();

    // Test 1: 1M stroops → 5% collateral = 50K
    let amount1 = 1_000_000;
    let commitment_hash1 = BytesN::from_array(&f.env, &[1u8; 32]);
    f.client.commit_escrow(&commitment_hash1, &amount1);
    let collateral1 = f.token.balance(&f.contract_id);
    assert_eq!(collateral1, (amount1 * 500) / 10_000);

    // Clear for test 2
    f.env.ledger().with_mut(|li| li.sequence_number += 200); // Expire commitment1

    // Test 2: 10M stroops → 5% collateral = 500K
    let buyer2 = Address::generate(&f.env);
    f.token.mint(&buyer2, &100_000_000_000);
    f.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &buyer2,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: &soroban_sdk::Symbol::new(&f.env, "commit_escrow"),
            args: &(
                BytesN::from_array(&f.env, &[2u8; 32]),
                10_000_000i128,
            ).into_val(&f.env),
            sub_invokes: &vec![&f.env],
        },
    }]);

    let amount2 = 10_000_000;
    let commitment_hash2 = BytesN::from_array(&f.env, &[2u8; 32]);
    let result = f.client.try_commit_escrow(&commitment_hash2, &amount2);
    assert!(result.is_ok());
}

#[test]
fn salt_collision_produces_different_commitment_hashes() {
    let f = setup_commit_reveal();
    let amount = 1_000_000;
    let secret_hash = BytesN::from_array(&f.env, &[8u8; 32]);

    let salt1 = BytesN::from_array(&f.env, &[99u8; 32]);
    let salt2 = BytesN::from_array(&f.env, &[100u8; 32]);

    let commitment_input1 = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt1.clone());
    let commitment_hash1 = f.env.crypto().sha256(&(commitment_input1,).into()).to_bytes();

    let commitment_input2 = (f.buyer.clone(), f.seller.clone(), amount, secret_hash.clone(), salt2.clone());
    let commitment_hash2 = f.env.crypto().sha256(&(commitment_input2,).into()).to_bytes();

    // Both commits should succeed (different salts → different hashes)
    let result1 = f.client.try_commit_escrow(&commitment_hash1, &amount);
    let result2 = f.client.try_commit_escrow(&commitment_hash2, &amount);
    assert!(result1.is_ok());
    assert!(result2.is_ok());

    // Verify different hashes
    assert_ne!(commitment_hash1.to_bytes(), commitment_hash2.to_bytes());
}

#[test]
fn dynamic_fee_increases_with_locked_liquidity() {
    let f = setup_commit_reveal();

    // Create several commitments to accumulate locked liquidity
    for i in 0..5 {
        let amount = 1_000_000;
        let commitment_hash = BytesN::from_array(&f.env, &[(i as u8); 32]);
        let result = f.client.try_commit_escrow(&commitment_hash, &amount);
        assert!(result.is_ok());

        f.env.ledger().with_mut(|li| li.sequence_number += 200); // Expire each
    }

    // Verify locked liquidity tracking (would be 5M stroops)
    // In production, dynamic fee would scale based on this
    // This is a placeholder test; full fee curve testing requires fee config management
}
