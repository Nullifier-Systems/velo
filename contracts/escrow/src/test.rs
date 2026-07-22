#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env, Vec,
};

struct Fixture {
    env: Env,
    client: EscrowContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    admin: Address,
    seller: Address,
    buyer: Address,
    secret: BytesN<32>,
    secret_hash: BytesN<32>,
    id: BytesN<32>,
    no_sigs: Vec<Address>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = token::Client::new(&env, &token_addr);
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);
    token_admin.mint(&buyer, &1_000);

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_addr, &50);

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);

    let no_sigs: Vec<Address> = Vec::new(&env);

    Fixture {
        env,
        client,
        token,
        contract_id,
        admin,
        seller,
        buyer,
        secret,
        secret_hash,
        id,
        no_sigs,
    }
}

fn lock_trade(f: &Fixture) {
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
}

// ---------------------------------------------------------------------------
// HTLC state-machine tests
// ---------------------------------------------------------------------------

#[test]
fn lock_moves_funds_into_contract() {
    let f = setup();
    lock_trade(&f);

    assert_eq!(f.token.balance(&f.buyer), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, htlc_core::TradeStatus::Locked);
    assert_eq!(trade.amount, 500);
}

#[test]
fn release_pays_seller_minus_fee() {
    let f = setup();
    lock_trade(&f);
    f.client.release(&f.id, &f.secret);

    let fee = (500 * 50) / 10_000;
    let payout = 500 - fee;
    assert_eq!(f.token.balance(&f.seller), payout);
    assert_eq!(f.token.balance(&f.admin), fee);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
#[should_panic]
fn release_with_wrong_secret_panics() {
    let f = setup();
    lock_trade(&f);
    let wrong = BytesN::from_array(&f.env, &[9u8; 32]);
    f.client.release(&f.id, &wrong);
}

#[test]
fn refund_after_timeout_returns_funds_to_buyer() {
    let f = setup();
    lock_trade(&f);

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
fn get_trade_returns_none_for_unknown_id() {
    let f = setup();
    let unknown = BytesN::from_array(&f.env, &[2u8; 32]);
    assert!(f.client.get_trade(&unknown).is_none());
}

// ---------------------------------------------------------------------------
// Pause / unpause
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "11")]
fn pause_blocks_lock() {
    let f = setup();
    f.client.pause(&f.no_sigs);

    let new_id = BytesN::from_array(&f.env, &[2u8; 32]);
    f.client
        .lock(&new_id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
}

#[test]
fn unpause_restores_lock() {
    let f = setup();
    f.client.pause(&f.no_sigs);
    f.client.unpause(&f.no_sigs);
    lock_trade(&f);

    assert_eq!(f.token.balance(&f.contract_id), 500);
}

#[test]
fn pause_does_not_affect_release_of_already_locked_trade() {
    let f = setup();
    lock_trade(&f);

    f.client.pause(&f.no_sigs);
    f.client.release(&f.id, &f.secret);

    let fee = (500 * 50) / 10_000;
    assert_eq!(f.token.balance(&f.seller), 500 - fee);
}

// ---------------------------------------------------------------------------
// set_platform_fee (single-admin mode)
// ---------------------------------------------------------------------------

#[test]
fn set_platform_fee_zero() {
    let f = setup();
    f.client.set_platform_fee(&0, &f.no_sigs);
    lock_trade(&f);
    f.client.release(&f.id, &f.secret);

    assert_eq!(f.token.balance(&f.seller), 500);
    assert_eq!(f.token.balance(&f.admin), 0);
}

#[test]
fn set_platform_fee_full() {
    let f = setup();
    f.client.set_platform_fee(&10_000, &f.no_sigs);
    lock_trade(&f);
    f.client.release(&f.id, &f.secret);

    assert_eq!(f.token.balance(&f.seller), 0);
    assert_eq!(f.token.balance(&f.admin), 500);
}

// ---------------------------------------------------------------------------
// set_fee_recipient (single-admin mode)
// ---------------------------------------------------------------------------

#[test]
fn set_fee_recipient_changes_who_receives_fees() {
    let f = setup();
    let new_recipient = Address::generate(&f.env);
    f.client.set_fee_recipient(&new_recipient, &f.no_sigs);
    lock_trade(&f);
    f.client.release(&f.id, &f.secret);

    let fee = (500 * 50) / 10_000;
    assert_eq!(f.token.balance(&f.admin), 0);
    assert_eq!(f.token.balance(&new_recipient), fee);
}

// ---------------------------------------------------------------------------
// migrate_to_multisig
// ---------------------------------------------------------------------------

#[test]
fn migrate_to_multisig_enables_multisig_governance() {
    let f = setup();
    let signer1 = Address::generate(&f.env);
    let signer2 = Address::generate(&f.env);
    let signer3 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [signer1.clone(), signer2.clone(), signer3.clone()]);

    f.client.migrate_to_multisig(&ms, &2);

    let approval = Vec::from_array(&f.env, [signer1, signer2]);
    f.client.set_platform_fee(&100, &approval);

    // Verify by executing a trade — 100 bps fee means 1% goes to admin
    lock_trade(&f);
    f.client.release(&f.id, &f.secret);
    let fee = (500 * 100) / 10_000;
    assert_eq!(f.token.balance(&f.admin), fee);
}

#[test]
#[should_panic]
fn migrate_to_multisig_fails_when_already_migrated() {
    let f = setup();
    let signer1 = Address::generate(&f.env);
    let signer2 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [signer1, signer2]);

    f.client.migrate_to_multisig(&ms, &2);
    f.client.migrate_to_multisig(&ms, &2);
}

// ---------------------------------------------------------------------------
// set_signers after multisig
// ---------------------------------------------------------------------------

#[test]
fn set_signers_updates_multisig_config() {
    let f = setup();
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    let s3 = Address::generate(&f.env);
    let s4 = Address::generate(&f.env);

    let first = Vec::from_array(&f.env, [s1, s2.clone(), s3.clone()]);
    f.client.migrate_to_multisig(&first, &2);

    let updated = Vec::from_array(&f.env, [s2.clone(), s4.clone()]);
    let auth = Vec::from_array(&f.env, [s2, s3]);
    f.client.set_signers(&updated, &1, &auth);

    let approval = Vec::from_array(&f.env, [s4]);
    f.client.set_platform_fee(&200, &approval);

    lock_trade(&f);
    f.client.release(&f.id, &f.secret);
    let fee = (500 * 200) / 10_000;
    assert_eq!(f.token.balance(&f.admin), fee);
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "10")]
fn unauthorized_signer_rejected() {
    let f = setup();
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [s1.clone(), s2]);
    f.client.migrate_to_multisig(&ms, &2);

    let intruder = Address::generate(&f.env);
    let bad = Vec::from_array(&f.env, [s1, intruder]);
    f.client.set_platform_fee(&300, &bad);
}

#[test]
#[should_panic(expected = "10")]
fn insufficient_signers_rejected() {
    let f = setup();
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    let s3 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [s1.clone(), s2.clone(), s3]);
    f.client.migrate_to_multisig(&ms, &3);

    let too_few = Vec::from_array(&f.env, [s1, s2]);
    f.client.set_platform_fee(&400, &too_few);
}
