#![cfg(test)]
extern crate alloc;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env,
};

const CASES: u32 = 256;

struct Fixture {
    env: Env,
    client: AtomicSwapContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    buyer: Address,
    seller: Address,
}

fn setup(initial_balance: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &asset.address());
    token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &initial_balance);
    let contract_id = env.register_contract(None, AtomicSwapContract);
    let client = AtomicSwapContractClient::new(&env, &contract_id);
    client.initialize(&admin, &asset.address());
    Fixture {
        env,
        client,
        token,
        contract_id,
        buyer,
        seller,
    }
}

fn id(env: &Env, n: u8) -> BytesN<32> {
    let mut bytes = [0; 32];
    bytes[0] = n;
    BytesN::from_array(env, &bytes)
}

fn secret(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn assert_accounting(f: &Fixture, ids: &[BytesN<32>], deposited: i128, initial: i128) {
    let held: i128 = ids
        .iter()
        .filter_map(|id| f.client.get_trade(id))
        .filter(|t| t.status == TradeStatus::Locked)
        .map(|t| t.amount)
        .sum();
    assert!(
        held <= deposited,
        "locked funds {held} exceeded deposited funds {deposited}"
    );
    assert_eq!(f.token.balance(&f.contract_id), held);
    assert_eq!(
        f.token.balance(&f.buyer) + f.token.balance(&f.seller) + held,
        initial
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    #[test]
    fn randomized_actions_preserve_accounting_and_transition_graph(
        amounts in prop::collection::vec(1i128..100_000, 1..9),
        timeouts in prop::collection::vec(1u32..500, 1..9),
        actions in prop::collection::vec((0u8..8, 0u8..5, 0u32..600), 1..65),
    ) {
        let count = amounts.len().min(timeouts.len());
        let initial: i128 = amounts[..count].iter().sum();
        let f = setup(initial);
        let mut ids = alloc::vec::Vec::new();
        let mut deposited = 0;

        for i in 0..count {
            let trade_id = id(&f.env, i as u8);
            let preimage = secret(&f.env, i as u8 + 1);
            let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
            f.client.lock(&trade_id, &f.seller, &f.buyer, &amounts[i], &hash, &timeouts[i]);
            deposited += amounts[i];
            ids.push(trade_id);
            assert_accounting(&f, &ids, deposited, initial);
        }

        for (raw_index, action, advance) in actions {
            let index = raw_index as usize % count;
            let trade_id = &ids[index];
            let before = f.client.get_trade(trade_id).unwrap();
            let balances = (f.token.balance(&f.buyer), f.token.balance(&f.seller), f.token.balance(&f.contract_id));
            f.env.ledger().with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(advance));

            let result = match action {
                0 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 1)).map(|_| ()),
                1 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 129)).map(|_| ()),
                _ => f.client.try_refund(trade_id).map(|_| ()),
            };
            let after = f.client.get_trade(trade_id).unwrap();

            if result.is_err() {
                prop_assert_eq!(after.status, before.status);
                prop_assert_eq!((f.token.balance(&f.buyer), f.token.balance(&f.seller), f.token.balance(&f.contract_id)), balances);
            } else {
                let allowed = after.status == before.status
                    || (before.status == TradeStatus::Locked && matches!(after.status, TradeStatus::Released | TradeStatus::Refunded));
                prop_assert!(allowed, "invalid transition {:?} -> {:?}", before.status, after.status);
            }
            assert_accounting(&f, &ids, deposited, initial);
        }
    }

    #[test]
    fn wrong_secrets_never_release(amount in 1i128..1_000_000, good in any::<u8>(), wrong in any::<u8>().prop_filter("different secret", |w| *w != 0)) {
        let f = setup(amount);
        let trade_id = id(&f.env, 1);
        let good_secret = secret(&f.env, good);
        let hash = f.env.crypto().sha256(&good_secret.into()).to_bytes();
        f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &100);
        let wrong_secret = secret(&f.env, good.wrapping_add(wrong));
        prop_assert!(matches!(f.client.try_release(&trade_id, &wrong_secret), Err(_) | Ok(Err(_))));
        prop_assert_eq!(f.client.get_trade(&trade_id).unwrap().status, TradeStatus::Locked);
        prop_assert_eq!(f.token.balance(&f.contract_id), amount);
        prop_assert_eq!(f.token.balance(&f.seller), 0);
    }

    #[test]
    fn refunds_before_timeout_never_succeed(amount in 1i128..1_000_000, timeout in 2u32..10_000, elapsed in 0u32..9_999) {
        prop_assume!(elapsed < timeout);
        let f = setup(amount);
        let trade_id = id(&f.env, 1);
        let preimage = secret(&f.env, 1);
        let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
        f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &timeout);
        f.env.ledger().with_mut(|li| li.sequence_number += elapsed);
        prop_assert!(matches!(f.client.try_refund(&trade_id), Err(_) | Ok(Err(_))));
        prop_assert_eq!(f.client.get_trade(&trade_id).unwrap().status, TradeStatus::Locked);
        prop_assert_eq!(f.token.balance(&f.contract_id), amount);
    }
}
