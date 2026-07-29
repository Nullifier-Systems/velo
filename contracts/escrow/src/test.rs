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

    let keys: Vec<BytesN<32>> = Vec::new(&env);
    let arb_set = ArbitratorSet {
        keys,
        threshold_epoch1: 1,
        threshold_epoch2: 1,
        t1_ledgers: 100,
        t2_ledgers: 200,
    };

    client.initialize(&admin, &token_addr, &50, &arb_set);

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
// Pause / unpause (issue #266 — time-locked circuit breaker)
// ---------------------------------------------------------------------------

#[test]
fn pause_does_not_block_lock_before_delay_elapses() {
    let f = setup();
    f.client.pause(&f.no_sigs);

    // Immediately after pause(), the delay has not elapsed — lock must still succeed.
    assert!(!f.client.is_paused());
    lock_trade(&f);
    assert_eq!(f.token.balance(&f.contract_id), 500);
}

#[test]
#[should_panic(expected = "15")]
fn pause_blocks_lock_after_delay() {
    let f = setup();
    f.client.pause(&f.no_sigs);

    f.env
        .ledger()
        .with_mut(|li| li.sequence_number += PAUSE_DELAY_LEDGERS);

    assert!(f.client.is_paused());
    let new_id = BytesN::from_array(&f.env, &[2u8; 32]);
    f.client
        .lock(&new_id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
}

#[test]
fn unpause_restores_lock() {
    let f = setup();
    f.client.pause(&f.no_sigs);
    f.env
        .ledger()
        .with_mut(|li| li.sequence_number += PAUSE_DELAY_LEDGERS);
    assert!(f.client.is_paused());

    f.client.unpause(&f.no_sigs);
    assert!(!f.client.is_paused());
    lock_trade(&f);

    assert_eq!(f.token.balance(&f.contract_id), 500);
}

#[test]
fn pause_does_not_affect_release_of_already_locked_trade() {
    let f = setup();
    lock_trade(&f);

    f.client.pause(&f.no_sigs);
    f.env
        .ledger()
        .with_mut(|li| li.sequence_number += PAUSE_DELAY_LEDGERS);
    assert!(f.client.is_paused());

    f.client.release(&f.id, &f.secret);

    let fee = (500 * 50) / 10_000;
    assert_eq!(f.token.balance(&f.seller), 500 - fee);
}

#[test]
fn pause_does_not_affect_refund_of_already_locked_trade() {
    let f = setup();
    lock_trade(&f);

    f.client.pause(&f.no_sigs);
    // Advance past both the pause delay and the trade timeout.
    f.env.ledger().with_mut(|li| {
        li.sequence_number += PAUSE_DELAY_LEDGERS.max(101);
    });
    assert!(f.client.is_paused());

    f.client.refund(&f.id);

    assert_eq!(f.token.balance(&f.buyer), 1_000);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        htlc_core::TradeStatus::Refunded
    );
}

#[test]
fn pause_schedules_effective_ledger_with_delay() {
    let f = setup();
    let before = f.env.ledger().sequence();
    f.client.pause(&f.no_sigs);

    assert_eq!(f.client.pause_delay_ledgers(), PAUSE_DELAY_LEDGERS);
    assert_eq!(
        f.client.pause_effective_ledger(),
        Some(before + PAUSE_DELAY_LEDGERS)
    );
    assert!(!f.client.is_paused());
}

#[test]
fn pause_rejects_insufficient_multisig() {
    let f = setup();
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    let s3 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [s1.clone(), s2.clone(), s3]);
    f.client.migrate_to_multisig(&ms, &2);

    // Only one authorized signer — below the 2-of-3 threshold.
    let too_few = Vec::from_array(&f.env, [s1]);
    let result = f.client.try_pause(&too_few);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));
}

#[test]
fn unpause_rejects_unauthorized_signer() {
    let f = setup();
    let s1 = Address::generate(&f.env);
    let s2 = Address::generate(&f.env);
    let ms = Vec::from_array(&f.env, [s1.clone(), s2.clone()]);
    f.client.migrate_to_multisig(&ms, &2);

    let ok = Vec::from_array(&f.env, [s1.clone(), s2]);
    f.client.pause(&ok);

    let intruder = Address::generate(&f.env);
    let bad = Vec::from_array(&f.env, [s1, intruder]);
    let result = f.client.try_unpause(&bad);
    assert_eq!(result, Err(Ok(Error::NotAuthorized)));
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

// ---------------------------------------------------------------------------
// Threshold Release Escrow tests
// ---------------------------------------------------------------------------

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use soroban_sdk::xdr::ToXdr;

fn generate_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let pub_key_bytes = signing_key.verifying_key().to_bytes();
    (signing_key, BytesN::from_array(env, &pub_key_bytes))
}

fn sign_payload(env: &Env, signing_key: &SigningKey, payload: &BytesN<32>) -> BytesN<64> {
    let signature = signing_key.sign(&payload.to_array());
    BytesN::from_array(env, &signature.to_bytes())
}

#[test]
fn test_release_escrow_threshold_success() {
    let f = setup();
    f.client.lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    let (buyer_sk, buyer_pk) = generate_keypair(&f.env);
    let (seller_sk, seller_pk) = generate_keypair(&f.env);
    let (arb_sk, arb_pk) = generate_keypair(&f.env);

    let designated_keys = vec![&f.env, buyer_pk.clone(), seller_pk.clone(), arb_pk.clone()];
    
    let nonce = 1u64;
    let payload_input = (
        f.id.clone(),
        500i128,
        f.seller.clone(),
        nonce,
    );
    let payload = f.env.crypto().sha256(&payload_input.to_xdr(&f.env));

    let sig1 = sign_payload(&f.env, &buyer_sk, &payload);
    let sig2 = sign_payload(&f.env, &arb_sk, &payload);

    let signatures = vec![&f.env, (buyer_pk, sig1), (arb_pk, sig2)];

    f.client.release_escrow(
        &f.id,
        &500,
        &f.seller,
        &nonce,
        &designated_keys,
        &signatures,
    );

    let fee = (500 * 50) / 10_000;
    let payout = 500 - fee;
    assert_eq!(f.token.balance(&f.seller), payout);
    assert_eq!(f.token.balance(&f.admin), fee);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    
    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Released);
}

#[test]
#[should_panic]
fn test_release_escrow_invalid_signature_rejection() {
    let f = setup();
    f.client.lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    let (buyer_sk, buyer_pk) = generate_keypair(&f.env);
    let (_, seller_pk) = generate_keypair(&f.env);
    let (_, arb_pk) = generate_keypair(&f.env);

    let designated_keys = vec![&f.env, buyer_pk.clone(), seller_pk.clone(), arb_pk.clone()];
    
    let nonce = 1u64;
    let payload_input = (f.id.clone(), 500i128, f.seller.clone(), nonce);
    let payload = f.env.crypto().sha256(&payload_input.to_xdr(&f.env));

    let sig1 = sign_payload(&f.env, &buyer_sk, &payload);
    
    // create an invalid signature
    let invalid_sig = BytesN::from_array(&f.env, &[0u8; 64]);

    let signatures = vec![&f.env, (buyer_pk, sig1), (seller_pk, invalid_sig)];

    f.client.release_escrow(
        &f.id,
        &500,
        &f.seller,
        &nonce,
        &designated_keys,
        &signatures,
    );
}

#[test]
#[should_panic(expected = "30")]
fn test_release_escrow_replay_rejection() {
    let f = setup();
    f.client.lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    let (buyer_sk, buyer_pk) = generate_keypair(&f.env);
    let (seller_sk, seller_pk) = generate_keypair(&f.env);
    let (_, arb_pk) = generate_keypair(&f.env);

    let designated_keys = vec![&f.env, buyer_pk.clone(), seller_pk.clone(), arb_pk.clone()];
    
    let nonce = 1u64;
    let payload_input = (f.id.clone(), 500i128, f.seller.clone(), nonce);
    let payload = f.env.crypto().sha256(&payload_input.to_xdr(&f.env));

    let sig1 = sign_payload(&f.env, &buyer_sk, &payload);
    let sig2 = sign_payload(&f.env, &seller_sk, &payload);

    let signatures = vec![&f.env, (buyer_pk.clone(), sig1.clone()), (seller_pk.clone(), sig2.clone())];

    f.client.release_escrow(
        &f.id,
        &500,
        &f.seller,
        &nonce,
        &designated_keys,
        &signatures,
    );

    // Attempt replay
    f.client.release_escrow(
        &f.id,
        &500,
        &f.seller,
        &nonce,
        &designated_keys,
        &signatures,
    );
}

#[test]
#[should_panic(expected = "29")]
fn test_release_escrow_insufficient_signatures() {
    let f = setup();
    f.client.lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    let (buyer_sk, buyer_pk) = generate_keypair(&f.env);
    let (_, seller_pk) = generate_keypair(&f.env);
    let (_, arb_pk) = generate_keypair(&f.env);

    let designated_keys = vec![&f.env, buyer_pk.clone(), seller_pk.clone(), arb_pk.clone()];
    
    let nonce = 1u64;
    let payload_input = (f.id.clone(), 500i128, f.seller.clone(), nonce);
    let payload = f.env.crypto().sha256(&payload_input.to_xdr(&f.env));

    let sig1 = sign_payload(&f.env, &buyer_sk, &payload);
    
    // Provide only 1 valid signature
    let signatures = vec![&f.env, (buyer_pk, sig1)];

    f.client.release_escrow(
        &f.id,
        &500,
        &f.seller,
        &nonce,
        &designated_keys,
        &signatures,
    );
}
