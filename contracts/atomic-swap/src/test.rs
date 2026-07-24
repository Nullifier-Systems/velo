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
