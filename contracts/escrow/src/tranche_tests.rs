//! Tests for tranche-based partial releases

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env, Vec,
};

fn setup(initial_balance: i128, platform_fee_bps: u32) -> TestFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token::Client::new(&env, &sac.address());
    let token_admin_client = token::StellarAssetClient::new(&env, &sac.address());
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    token_admin_client.mint(&buyer, &initial_balance);

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);

    let arb_set = ArbitratorSet {
        keys: Vec::new(&env),
        threshold_epoch1: 1,
        threshold_epoch2: 2,
        t1_ledgers: 100,
        t2_ledgers: 200,
    };

    client.initialize(&admin, &token.address, &platform_fee_bps, &arb_set);

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);

    TestFixture {
        env,
        client,
        token,
        admin,
        seller,
        buyer,
        contract_id,
        secret,
        secret_hash,
        id,
    }
}

struct TestFixture {
    env: Env,
    client: EscrowContractClient<'static>,
    token: token::Client<'static>,
    admin: Address,
    seller: Address,
    buyer: Address,
    contract_id: Address,
    secret: BytesN<32>,
    secret_hash: BytesN<32>,
    id: BytesN<32>,
}

#[test]
fn test_lock_with_3_tranches_and_release_one_by_one() {
    let f = setup(2_000, 100); // 1% fee

    // Create 3 tranches: 200, 150, 150 (total 500)
    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret2 = BytesN::from_array(&f.env, &[11u8; 32]);
    let secret3 = BytesN::from_array(&f.env, &[12u8; 32]);

    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
    let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
    let hash3 = f.env.crypto().sha256(&secret3.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 200,
        secret_hash: hash1,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 150,
        secret_hash: hash2,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 150,
        secret_hash: hash3,
        released: false,
    });

    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);

    // Initial balances
    assert_eq!(f.token.balance(&f.buyer), 1_500);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.token.balance(&f.seller), 0);

    // Release tranche 0 (200 - 1% = 198)
    let payout1 = f.client.release_tranche(&f.id, &0, &secret1);
    assert_eq!(payout1, 198);
    assert_eq!(f.token.balance(&f.seller), 198);
    assert_eq!(f.token.balance(&f.admin), 2);

    // Trade should still be Locked (not fully released)
    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Locked);

    // Release tranche 1 (150 - 1% = 149, fee = 1)
    let payout2 = f.client.release_tranche(&f.id, &1, &secret2);
    assert_eq!(payout2, 149);
    assert_eq!(f.token.balance(&f.seller), 347);
    assert_eq!(f.token.balance(&f.admin), 3);

    // Still locked
    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Locked);

    // Release tranche 2 (150 - 1% = 149, fee = 1)
    let payout3 = f.client.release_tranche(&f.id, &2, &secret3);
    assert_eq!(payout3, 149);
    assert_eq!(f.token.balance(&f.seller), 496);
    assert_eq!(f.token.balance(&f.admin), 4);

    // Now fully released
    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Released);

    // Contract should be empty
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn test_release_tranche_twice_fails() {
    let f = setup(1_000, 100);

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret2 = BytesN::from_array(&f.env, &[11u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
    let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 250,
        secret_hash: hash1,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 250,
        secret_hash: hash2,
        released: false,
    });

    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);

    // Release tranche 0
    f.client.release_tranche(&f.id, &0, &secret1);

    // Attempt to release tranche 0 again
    let result = f.client.try_release_tranche(&f.id, &0, &secret1);
    assert_eq!(result.unwrap_err().unwrap(), Error::TrancheAlreadyReleased);
}

#[test]
fn test_partial_release_then_timeout_refunds_remainder() {
    let f = setup(1_000, 100);

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret2 = BytesN::from_array(&f.env, &[11u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
    let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 300,
        secret_hash: hash1,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 200,
        secret_hash: hash2,
        released: false,
    });

    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);

    // Release only tranche 0
    f.client.release_tranche(&f.id, &0, &secret1);

    // Seller got first tranche (300 - 1% = 297)
    assert_eq!(f.token.balance(&f.seller), 297);
    assert_eq!(f.token.balance(&f.admin), 3);

    // Contract still holds the unreleased tranche (200)
    assert_eq!(f.token.balance(&f.contract_id), 200);

    // Pass timeout
    f.env.ledger().with_mut(|li| li.sequence_number += 101);

    // Refund should return only the unreleased amount (200)
    f.client.refund(&f.id);

    // Buyer gets back only the unreleased tranche
    assert_eq!(f.token.balance(&f.buyer), 700); // 500 initial + 200 refund

    // Contract is now empty
    assert_eq!(f.token.balance(&f.contract_id), 0);

    // Trade is refunded
    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Refunded);
}

#[test]
fn test_tranche_sum_mismatch_rejected() {
    let f = setup(1_000, 100);

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret2 = BytesN::from_array(&f.env, &[11u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
    let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 250,
        secret_hash: hash1,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 200, // Total 450, but we claim 500
        secret_hash: hash2,
        released: false,
    });

    let result = f
        .client
        .try_lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);
    assert_eq!(result.unwrap_err().unwrap(), Error::TrancheSumMismatch);
}

#[test]
fn test_invalid_tranche_index() {
    let f = setup(1_000, 100);

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 500,
        secret_hash: hash1,
        released: false,
    });

    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);

    // Try to release tranche index 1 (doesn't exist)
    let result = f.client.try_release_tranche(&f.id, &1, &secret1);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidTrancheIndex);
}

#[test]
fn test_tranche_accounting_invariant() {
    // Test that total payouts (released tranches + refund) = original locked amount
    let f = setup(2_000, 100); // 1% fee

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let secret2 = BytesN::from_array(&f.env, &[11u8; 32]);
    let secret3 = BytesN::from_array(&f.env, &[12u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
    let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();
    let hash3 = f.env.crypto().sha256(&secret3.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 100,
        secret_hash: hash1,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 200,
        secret_hash: hash2,
        released: false,
    });
    tranches.push_back(Tranche {
        amount: 300,
        secret_hash: hash3,
        released: false,
    });

    let total_locked = 600i128;
    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &total_locked, &tranches, &100);

    // Release first two tranches
    let payout1 = f.client.release_tranche(&f.id, &0, &secret1); // 100 - 1 = 99
    let payout2 = f.client.release_tranche(&f.id, &1, &secret2); // 200 - 2 = 198

    let total_paid_to_seller = payout1 + payout2; // 297

    // Timeout and refund
    f.env.ledger().with_mut(|li| li.sequence_number += 101);
    f.client.refund(&f.id);

    let refunded_to_buyer = 300i128; // unreleased tranche
    let total_fees = 3i128; // 1 + 2

    // Critical invariant: seller payouts + buyer refund + fees = original locked amount
    assert_eq!(
        total_paid_to_seller + refunded_to_buyer + total_fees,
        total_locked
    );

    // Verify actual balances
    assert_eq!(f.token.balance(&f.seller), total_paid_to_seller);
    assert_eq!(
        f.token.balance(&f.buyer),
        2_000 - total_locked + refunded_to_buyer
    );
    assert_eq!(f.token.balance(&f.admin), total_fees);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn test_empty_tranches_rejected() {
    let f = setup(1_000, 100);

    let tranches = Vec::new(&f.env);

    let result = f
        .client
        .try_lock_with_tranches(&f.id, &f.seller, &f.buyer, &500, &tranches, &100);
    assert_eq!(result.unwrap_err().unwrap(), Error::NoTranches);
}

// ---------------------------------------------------------------------------
// Issue #381 — precision truncation & i128 stroop overflow in fee math.
//
// The old `amount * fee_bps / 10_000` arithmetic had two failure modes:
//   * amounts near i128::MAX (or an out-of-range fee config) overflowed
//     i128 and panicked the WASM runtime, freezing locked funds;
//   * micro-tranches truncated down to a 0-stroop fee, letting tiny
//     releases settle entirely fee-free.
// ---------------------------------------------------------------------------

#[test]
fn test_micro_tranche_fee_rounds_up_to_minimum_one_stroop() {
    // fee_bps = 1 on a 100-stroop tranche: the raw quotient is
    // 100 * 1 / 10_000 = 0, which used to settle fee-free. The fee must
    // round UP to the 1-stroop minimum instead.
    let f = setup(1_000, 1);

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: 100,
        secret_hash: hash1,
        released: false,
    });

    f.client
        .lock_with_tranches(&f.id, &f.seller, &f.buyer, &100, &tranches, &100);

    let payout = f.client.release_tranche(&f.id, &0, &secret1);
    assert_eq!(payout, 99); // 100 − 1 (rounded-up minimum fee)
    assert_eq!(f.token.balance(&f.seller), 99);
    assert_eq!(f.token.balance(&f.admin), 1); // never zero
    assert_eq!(f.token.balance(&f.contract_id), 0);

    // Conservation invariant: payout + fee == gross amount exactly.
    assert_eq!(payout + f.token.balance(&f.admin), 100);
}

#[test]
fn test_release_max_lockable_amount_does_not_overflow() {
    // lock_with_tranches caps amounts at i128::MAX / 10_000; at the maximum
    // legal fee of 10_000 bps the product `amount * fee_bps` lands exactly
    // at the i128 boundary. Checked math must settle this release cleanly
    // instead of panicking the WASM runtime and freezing the escrow.
    let max_amount = i128::MAX / 10_000;
    let f = setup(max_amount, 10_000); // 100% fee — the boundary case

    let secret1 = BytesN::from_array(&f.env, &[10u8; 32]);
    let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();

    let mut tranches = Vec::new(&f.env);
    tranches.push_back(Tranche {
        amount: max_amount,
        secret_hash: hash1,
        released: false,
    });

    f.client.lock_with_tranches(
        &f.id,
        &f.seller,
        &f.buyer,
        &max_amount,
        &tranches,
        &100,
    );

    // At a 100% fee everything goes to the platform; payout is 0 but the
    // release itself must succeed without any arithmetic panic.
    let payout = f.client.release_tranche(&f.id, &0, &secret1);
    assert_eq!(payout, 0);
    assert_eq!(f.token.balance(&f.seller), 0);
    assert_eq!(f.token.balance(&f.admin), max_amount);
    assert_eq!(f.token.balance(&f.contract_id), 0);

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Released);
}

#[test]
fn test_fee_helpers_reject_overflow_instead_of_panicking() {
    use htlc_core::{calculate_fee, FeeMathError};

    // Directly exercise the shared checked-math helpers at values the
    // public entry points refuse at lock time — proving the math itself
    // can never panic if a future code path reaches it with such input.
    assert_eq!(
        calculate_fee(i128::MAX, 2),
        Err(FeeMathError::Overflow)
    );
    assert_eq!(
        calculate_fee(i128::MAX, u32::MAX),
        Err(FeeMathError::Overflow)
    );

    // The exact boundary that CAN occur must compute precisely.
    let max_lockable = i128::MAX / 10_000;
    assert_eq!(calculate_fee(max_lockable, 10_000), Ok(max_lockable));

    // Micro-tranche floor applies to the helper too.
    assert_eq!(calculate_fee(99, 1), Ok(1));
    assert_eq!(calculate_fee(0, 250), Ok(0));
}

#[test]
fn test_set_platform_fee_rejects_above_max_bps() {
    // Issue #381: set_platform_fee() silently accepted fees above 100%,
    // which made every subsequent release overflow and panic. It must
    // reject them with InvalidFee, matching initialize().
    let f = setup(1_000, 100);

    let result = f
        .client
        .try_set_platform_fee(&10_001, &Vec::new(&f.env));
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidFee);

    // The boundary value itself remains legal.
    f.client.set_platform_fee(&10_000, &Vec::new(&f.env));
}
