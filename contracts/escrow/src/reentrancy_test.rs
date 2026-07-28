//! Adversarial SEP-41 reentrancy tests for MicopayEscrow (issue #273).
//!
//! Builds a malicious token that attempts to call back into escrow during
//! `transfer`, exercises major transfer sites, and asserts there is no
//! unintended state corruption or double-payout.
//!
//! See docs/escrow-sep41-reentrancy-audit.md for the written analysis.

#![cfg(test)]

use crate::malicious_token::{AttackKind, MaliciousToken, MaliciousTokenClient};
use crate::{ArbitratorSet, BatchReleaseItem, EscrowContract, EscrowContractClient, TradeStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, BytesN, Env, Vec,
};

struct EvilFixture {
    env: Env,
    client: EscrowContractClient<'static>,
    token: MaliciousTokenClient<'static>,
    /// SEP-41 client view of the same malicious contract (what escrow uses).
    token_iface: token::Client<'static>,
    contract_id: Address,
    admin: Address,
    seller: Address,
    buyer: Address,
    secret: BytesN<32>,
    secret_hash: BytesN<32>,
    id: BytesN<32>,
}

fn empty_arb_set(env: &Env) -> ArbitratorSet {
    ArbitratorSet {
        keys: Vec::new(env),
        threshold_epoch1: 1,
        threshold_epoch2: 1,
        t1_ledgers: 100,
        t2_ledgers: 200,
    }
}

fn setup(mint_to_buyer: i128, fee_bps: u32) -> EvilFixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let token_id = env.register_contract(None, MaliciousToken);
    let token = MaliciousTokenClient::new(&env, &token_id);
    let token_iface = token::Client::new(&env, &token_id);
    token.mint(&buyer, &mint_to_buyer);

    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &fee_bps, &empty_arb_set(&env));

    let secret = BytesN::from_array(&env, &[7u8; 32]);
    let secret_hash = env.crypto().sha256(&secret.clone().into()).to_bytes();
    let id = BytesN::from_array(&env, &[1u8; 32]);

    EvilFixture {
        env,
        client,
        token,
        token_iface,
        contract_id,
        admin,
        seller,
        buyer,
        secret,
        secret_hash,
        id,
    }
}

fn arm(f: &EvilFixture, kind: AttackKind, amount: i128, timeout_ledgers: u32) {
    f.token.configure_attack(
        &f.contract_id,
        &kind,
        &f.id,
        &f.secret,
        &f.seller,
        &f.buyer,
        &amount,
        &f.secret_hash,
        &timeout_ledgers,
    );
}

/// Lock/release succeed when the token is disarmed (baseline for the fake token).
#[test]
fn malicious_token_behaves_when_disarmed() {
    let f = setup(1_000, 100);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    assert_eq!(f.token.balance(&f.buyer), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        TradeStatus::Locked
    );

    f.client.release(&f.id, &f.secret);
    assert_eq!(f.token.balance(&f.seller), 495);
    assert_eq!(f.token.balance(&f.admin), 5);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        TradeStatus::Released
    );
}

/// During `release`, token tries to reenter `release`.
/// Host blocks re-entry → outer call traps → full rollback. No double-payout.
#[test]
fn reenter_release_during_release_no_double_payout() {
    let f = setup(1_000, 100);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    arm(&f, AttackKind::Release, 500, 100);

    let result = f.client.try_release(&f.id, &f.secret);
    assert!(
        result.is_err(),
        "reentrant release attempt must fail the outer release"
    );

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(
        trade.status,
        TradeStatus::Locked,
        "failed release must not leave Released status"
    );
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.token.balance(&f.seller), 0);
    assert_eq!(f.token.balance(&f.admin), 0);
}

/// During `refund`, token tries to reenter `refund`.
#[test]
fn reenter_refund_during_refund_no_corruption() {
    let f = setup(1_000, 0);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    f.env.ledger().with_mut(|li| {
        li.sequence_number += 101;
    });

    arm(&f, AttackKind::Refund, 500, 100);

    let result = f.client.try_refund(&f.id);
    assert!(result.is_err());

    let trade = f.client.get_trade(&f.id).unwrap();
    assert_eq!(trade.status, TradeStatus::Locked);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.token.balance(&f.buyer), 500);
}

/// During `lock`, token tries to reenter `lock` for a second trade id.
#[test]
fn reenter_lock_during_lock_no_second_trade() {
    let f = setup(2_000, 0);
    arm(&f, AttackKind::Lock, 500, 100);

    let result = f
        .client
        .try_lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);
    assert!(result.is_err());

    // Neither the primary nor the attacker's alternate id may be locked.
    assert!(f.client.get_trade(&f.id).is_none());
    let mut bytes = [9u8; 32];
    bytes[0] = 0xaa;
    let other_id = BytesN::from_array(&f.env, &bytes);
    assert!(f.client.get_trade(&other_id).is_none());
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.token.balance(&f.buyer), 2_000);
}

/// During outbound payout, token tries to reenter `lock` — still no corruption.
#[test]
fn reenter_lock_during_release_no_corruption() {
    let f = setup(1_000, 0);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    arm(&f, AttackKind::Lock, 500, 100);

    assert!(f.client.try_release(&f.id, &f.secret).is_err());
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        TradeStatus::Locked
    );
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.token.balance(&f.seller), 0);
}

/// `batch_release` with a malicious token attempting reentry on the payout.
#[test]
fn reenter_during_batch_release_no_partial_payout() {
    let f = setup(1_000, 0);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    arm(&f, AttackKind::Release, 500, 100);

    let item = BatchReleaseItem {
        id: f.id.clone(),
        secret: f.secret.clone(),
    };
    let releases = vec![&f.env, item];
    // A trapping transfer fails the whole call; atomicity restores Locked.
    let result = f.client.try_batch_release(&releases);
    assert!(result.is_err());
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        TradeStatus::Locked
    );
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.token.balance(&f.seller), 0);
}

/// After a failed reentrancy attempt, a disarmed token can still settle normally.
#[test]
fn recovery_after_failed_reentrancy_attempt() {
    let f = setup(1_000, 100);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &500, &f.secret_hash, &100);

    arm(&f, AttackKind::Release, 500, 100);
    assert!(f.client.try_release(&f.id, &f.secret).is_err());

    f.token.disarm();
    f.client.release(&f.id, &f.secret);

    assert_eq!(f.token.balance(&f.seller), 495);
    assert_eq!(f.token.balance(&f.admin), 5);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(
        f.client.get_trade(&f.id).unwrap().status,
        TradeStatus::Released
    );
}

/// Sanity: `token_iface` (what escrow binds) sees the same balances as the
/// malicious client — proves we are exercising the SEP-41 `transfer` path.
#[test]
fn sep41_client_balance_matches_malicious_client() {
    let f = setup(1_000, 0);
    f.token.disarm();
    f.client
        .lock(&f.id, &f.seller, &f.buyer, &400, &f.secret_hash, &50);
    assert_eq!(
        f.token_iface.balance(&f.contract_id),
        f.token.balance(&f.contract_id)
    );
}
