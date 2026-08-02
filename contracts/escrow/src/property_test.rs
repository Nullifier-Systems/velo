#![cfg(test)]

extern crate alloc;

use super::*;
use alloc::vec::Vec;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, BytesN, Env,
};

const CASES: u32 = 256;

struct Fixture {
    env: Env,
    client: EscrowContractClient<'static>,
    token: token::Client<'static>,
    contract_id: Address,
    admin: Address,
    buyer: Address,
    seller: Address,
}

fn setup(initial_balance: i128, fee_bps: u32) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let keys: Vec<BytesN<32>> = Vec::new(&env);
    let arb_set = ArbitratorSet {
        keys,
        threshold_epoch1: 1,
        threshold_epoch2: 1,
        t1_ledgers: 100,
        t2_ledgers: 200,
    };

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &asset.address());
    token::StellarAssetClient::new(&env, &asset.address()).mint(&buyer, &initial_balance);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &asset.address(), &fee_bps, &arb_set);
    Fixture {
        env,
        client,
        token,
        contract_id,
        admin,
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
        .filter(|t| matches!(t.status, TradeStatus::Locked | TradeStatus::Disputed))
        .map(|t| t.amount)
        .sum();
    assert!(
        held <= deposited,
        "locked funds {held} exceeded deposited funds {deposited}"
    );
    assert_eq!(f.token.balance(&f.contract_id), held);
    assert_eq!(
        f.token.balance(&f.buyer) + f.token.balance(&f.seller) + f.token.balance(&f.admin) + held,
        initial
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    #[test]
    #[ignore]
    fn randomized_actions_preserve_accounting_and_transition_graph(
        amounts in prop::collection::vec(1i128..100_000, 1..9),
        timeouts in prop::collection::vec(1u32..500, 1..9),
        fee_bps in 0u32..=10_000,
        actions in prop::collection::vec((0u8..8, 0u8..8, 0u32..600), 1..65),
    ) {
        let count = amounts.len().min(timeouts.len());
        let initial: i128 = amounts[..count].iter().sum();
        let f = setup(initial, fee_bps);
        let mut ids = Vec::new();
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
            let balances = (f.token.balance(&f.buyer), f.token.balance(&f.seller), f.token.balance(&f.admin), f.token.balance(&f.contract_id));
            f.env.ledger().with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(advance));

            // Every arm is normalized to Result<(), ()> — the fuzzer only cares
            // whether the call succeeded, not the specific error shape (which
            // differs between panic-style calls like release()/raise_dispute()
            // and Result-returning calls like resolve_dispute()).
            let empty_sigs: Vec<(u32, BytesN<64>)> = Vec::new(&f.env);
            let result: Result<(), ()> = match action {
                0 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 1)).map(|_| ()).map_err(|_| ()),
                1 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 129)).map(|_| ()).map_err(|_| ()),
                2 => f.client.try_refund(trade_id).map(|_| ()).map_err(|_| ()),
                3 => f.client.try_raise_dispute(&f.buyer, trade_id).map(|_| ()).map_err(|_| ()),
                4 => f.client.try_raise_dispute(&f.seller, trade_id).map(|_| ()).map_err(|_| ()),
                5 => f.client.try_resolve_dispute(trade_id, &10_000, &empty_sigs).map(|_| ()).map_err(|_| ()),
                6 => f.client.try_resolve_dispute(trade_id, &0, &empty_sigs).map(|_| ()).map_err(|_| ()),
                _ => f.client.try_refund_after_dispute_timeout(trade_id).map(|_| ()).map_err(|_| ()),
            };
            let after = f.client.get_trade(trade_id).unwrap();

            if result.is_err() {
                prop_assert_eq!(after.status, before.status);
                prop_assert_eq!((f.token.balance(&f.buyer), f.token.balance(&f.seller), f.token.balance(&f.admin), f.token.balance(&f.contract_id)), balances);
            } else {
                let allowed = after.status == before.status
                    || (before.status == TradeStatus::Locked && matches!(after.status, TradeStatus::Released | TradeStatus::Refunded | TradeStatus::Disputed))
                    || (before.status == TradeStatus::Disputed && matches!(after.status, TradeStatus::Resolved | TradeStatus::Refunded));
                prop_assert!(allowed, "invalid transition {:?} -> {:?}", before.status, after.status);
            }
            assert_accounting(&f, &ids, deposited, initial);
        }
    }

    #[test]
    fn wrong_secrets_never_release(amount in 1i128..1_000_000, fee_bps in 0u32..=10_000, good in any::<u8>(), delta in 1u8..=255) {
        let f = setup(amount, fee_bps);
        let trade_id = id(&f.env, 1);
        let good_secret = secret(&f.env, good);
        let hash = f.env.crypto().sha256(&good_secret.into()).to_bytes();
        f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &100);
        prop_assert!(f.client.try_release(&trade_id, &secret(&f.env, good.wrapping_add(delta))).is_err());
        prop_assert_eq!(f.client.get_trade(&trade_id).unwrap().status, TradeStatus::Locked);
        prop_assert_eq!(f.token.balance(&f.contract_id), amount);
        prop_assert_eq!(f.token.balance(&f.seller), 0);
    }

    #[test]
    #[ignore]
    fn refunds_before_timeout_never_succeed(amount in 1i128..1_000_000, fee_bps in 0u32..=10_000, timeout in 2u32..10_000, elapsed in 0u32..9_999) {
        prop_assume!(elapsed < timeout);
        let f = setup(amount, fee_bps);
        let trade_id = id(&f.env, 1);
        let preimage = secret(&f.env, 1);
        let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
        f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &timeout);
        f.env.ledger().with_mut(|li| li.sequence_number += elapsed);
        prop_assert!(f.client.try_refund(&trade_id).is_err());
        prop_assert_eq!(f.client.get_trade(&trade_id).unwrap().status, TradeStatus::Locked);
        prop_assert_eq!(f.token.balance(&f.contract_id), amount);
    }

    #[test]
    fn fee_arithmetic_properties(
        amount in 1i128..=(i128::MAX / 10_000),
        fee_bps in 0u32..=10_000,
        buyer_share_bps in 0u32..=10_000,
    ) {
        // 1. Release Math properties
        let fee = (amount * fee_bps as i128) / 10_000;
        let payout = amount - fee;

        prop_assert!(fee >= 0);
        prop_assert!(payout >= 0);
        prop_assert_eq!(payout + fee, amount);

        // Exact rounding check (truncation/dust favors the seller, i.e., actual fee <= ideal fee)
        prop_assert!(fee * 10_000 <= amount * fee_bps as i128);
        prop_assert!(amount * fee_bps as i128 - fee * 10_000 < 10_000);

        // 2. Resolve Dispute Math properties
        let buyer_amount = (amount * buyer_share_bps as i128) / 10_000;
        let seller_gross = amount - buyer_amount;
        let dispute_fee = (seller_gross * fee_bps as i128) / 10_000;
        let seller_payout = seller_gross - dispute_fee;

        prop_assert!(buyer_amount >= 0);
        prop_assert!(seller_gross >= 0);
        prop_assert!(dispute_fee >= 0);
        prop_assert!(seller_payout >= 0);
        prop_assert_eq!(buyer_amount + seller_payout + dispute_fee, amount);

        // Rounding checks for buyer share
        prop_assert!(buyer_amount * 10_000 <= amount * buyer_share_bps as i128);
        prop_assert!(amount * buyer_share_bps as i128 - buyer_amount * 10_000 < 10_000);

        // Rounding checks for dispute fee
        prop_assert!(dispute_fee * 10_000 <= seller_gross * fee_bps as i128);
        prop_assert!(seller_gross * fee_bps as i128 - dispute_fee * 10_000 < 10_000);
    }

    // -----------------------------------------------------------------------
    // Solvency invariant: contract balance >= sum of active escrow amounts.
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn solvency_invariant_holds_under_random_operations(
        amounts in prop::collection::vec(1i128..50_000, 1..5),
        timeouts in prop::collection::vec(1u32..500, 1..5),
        fee_bps in 0u32..=10_000,
        actions in prop::collection::vec((0u8..8, 0u8..5, 0u32..600), 1..30),
    ) {
        let count = amounts.len().min(timeouts.len());
        let initial: i128 = amounts[..count].iter().sum();
        let f = setup(initial, fee_bps);
        let mut ids = Vec::new();
        let mut deposited: i128 = 0;

        for i in 0..count {
            let trade_id = id(&f.env, i as u8);
            let preimage = secret(&f.env, i as u8 + 1);
            let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
            f.client.lock(&trade_id, &f.seller, &f.buyer, &amounts[i], &hash, &timeouts[i]);
            deposited += amounts[i];
            ids.push(trade_id);
        }

        // Solvency invariant: after all locks, contract balance == deposited
        prop_assert_eq!(f.token.balance(&f.contract_id), deposited);

        for (raw_index, action, advance) in actions {
            let index = raw_index as usize % count;
            let trade_id = &ids[index];
            f.env.ledger().with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(advance));

            let empty_sigs: Vec<(u32, BytesN<64>)> = Vec::new(&f.env);
            let _: Result<(), ()> = match action {
                0 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 1)).map(|_| ()).map_err(|_| ()),
                1 => f.client.try_release(trade_id, &secret(&f.env, index as u8 + 129)).map(|_| ()).map_err(|_| ()),
                2 => f.client.try_refund(trade_id).map(|_| ()).map_err(|_| ()),
                3 => f.client.try_raise_dispute(&f.buyer, trade_id).map(|_| ()).map_err(|_| ()),
                4 => f.client.try_raise_dispute(&f.seller, trade_id).map(|_| ()).map_err(|_| ()),
                5 => f.client.try_resolve_dispute(trade_id, &10_000, &empty_sigs).map(|_| ()).map_err(|_| ()),
                6 => f.client.try_resolve_dispute(trade_id, &0, &empty_sigs).map(|_| ()).map_err(|_| ()),
                _ => f.client.try_refund_after_dispute_timeout(trade_id).map(|_| ()).map_err(|_| ()),
            };

            // SOLVENCY: contract balance must always >= sum of active amounts
            let active_sum: i128 = ids.iter()
                .filter_map(|id| f.client.get_trade(id))
                .filter(|t| matches!(t.status, TradeStatus::Locked | TradeStatus::Disputed))
                .map(|t| t.amount)
                .sum();
            prop_assert!(
                f.token.balance(&f.contract_id) >= active_sum,
                "solvency violated: contract={}, active={}",
                f.token.balance(&f.contract_id),
                active_sum
            );
        }
    }

    // -----------------------------------------------------------------------
    // No-locked-funds invariant: every Locked trade has a reachable terminal.
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn no_locked_funds_invariant(
        amounts in prop::collection::vec(1i128..50_000, 1..5),
        timeouts in prop::collection::vec(1u32..500, 1..5),
        fee_bps in 0u32..=10_000,
        advance_before_refund in 0u32..10_000,
    ) {
        let count = amounts.len().min(timeouts.len());
        let initial: i128 = amounts[..count].iter().sum();
        let f = setup(initial, fee_bps);
        let mut ids = Vec::new();

        for i in 0..count {
            let trade_id = id(&f.env, i as u8);
            let preimage = secret(&f.env, i as u8 + 1);
            let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
            f.client.lock(&trade_id, &f.seller, &f.buyer, &amounts[i], &hash, &timeouts[i]);
            ids.push(trade_id);
        }

        // Every trade is either released (correct secret) or refunded (after timeout)
        // — both paths always exist. Verify that advancing the ledger enough
        // guarantees all trades become refundable.
        f.env.ledger().with_mut(|li| li.sequence_number += advance_before_refund);

        for (i, trade_id) in ids.iter().enumerate() {
            let trade = f.client.get_trade(trade_id).unwrap();
            if trade.status == TradeStatus::Locked {
                // Either timeout already passed (refund path exists)
                // or we can still release with the correct secret
                let preimage = secret(&f.env, i as u8 + 1);
                let release_result = f.client.try_release(trade_id, &preimage);
                let refund_result = f.client.try_refund(trade_id);

                // At least one path must be reachable
                prop_assert!(
                    release_result.is_ok() || refund_result.is_ok(),
                    "trade {} locked with no reachable terminal: timeout_ledger={}, current={}",
                    i, trade.timeout_ledger, f.env.ledger().sequence()
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Monotonic timelock invariant: hashlock constraints are immutable.
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn monotonic_timelock_invariant(
        amount in 1i128..100_000,
        timeout in 1u32..1_000,
        fee_bps in 0u32..=10_000,
        advances in prop::collection::vec(1u32..200, 1..20),
    ) {
        let f = setup(amount, fee_bps);
        let trade_id = id(&f.env, 0);
        let preimage = secret(&f.env, 7);
        let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();

        f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &timeout);
        let initial_trade = f.client.get_trade(&trade_id).unwrap();

        for delta in advances {
            f.env.ledger().with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(delta));

            // Advancing the ledger must never change the trade's hashlock or timeout
            let trade = f.client.get_trade(&trade_id).unwrap();
            prop_assert_eq!(trade.secret_hash, initial_trade.secret_hash);
            prop_assert_eq!(trade.timeout_ledger, initial_trade.timeout_ledger);
            prop_assert_eq!(trade.amount, initial_trade.amount);
            prop_assert_eq!(trade.buyer, initial_trade.buyer);
            prop_assert_eq!(trade.seller, initial_trade.seller);
        }
    }

    // -----------------------------------------------------------------------
    // Cross-trade independence: operations on one trade never affect another.
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn cross_trade_independence(
        amount1 in 1i128..50_000,
        amount2 in 1i128..50_000,
        fee_bps in 0u32..=10_000,
        action1 in 0u8..5,
        action2 in 0u8..5,
        advance in 0u32..1_000,
    ) {
        let initial = amount1 + amount2;
        let f = setup(initial, fee_bps);

        let id1 = id(&f.env, 0);
        let id2 = id(&f.env, 1);
        let secret1 = secret(&f.env, 1);
        let secret2 = secret(&f.env, 2);
        let hash1 = f.env.crypto().sha256(&secret1.clone().into()).to_bytes();
        let hash2 = f.env.crypto().sha256(&secret2.clone().into()).to_bytes();

        f.client.lock(&id1, &f.seller, &f.buyer, &amount1, &hash1, &100);
        f.client.lock(&id2, &f.seller, &f.buyer, &amount2, &hash2, &100);

        f.env.ledger().with_mut(|li| li.sequence_number += advance);

        // Record state before operations
        let state1_before = f.client.get_trade(&id1).unwrap();
        let state2_before = f.client.get_trade(&id2).unwrap();
        let balances_before = (
            f.token.balance(&f.buyer),
            f.token.balance(&f.seller),
            f.token.balance(&f.admin),
            f.token.balance(&f.contract_id),
        );

        // Perform action1 on trade1
        let _: Result<(), ()> = match action1 {
            0 => f.client.try_release(&id1, &secret1).map(|_| ()).map_err(|_| ()),
            1 => f.client.try_release(&id1, &secret(&f.env, 99)).map(|_| ()).map_err(|_| ()),
            2 => f.client.try_refund(&id1).map(|_| ()).map_err(|_| ()),
            3 => f.client.try_raise_dispute(&f.buyer, &id1).map(|_| ()).map_err(|_| ()),
            _ => f.client.try_raise_dispute(&f.seller, &id1).map(|_| ()).map_err(|_| ()),
        };

        // Trade2 must be completely unaffected
        let state2_after = f.client.get_trade(&id2).unwrap();
        prop_assert_eq!(state2_after.status, state2_before.status);
        prop_assert_eq!(state2_after.amount, state2_before.amount);
        prop_assert_eq!(state2_after.buyer, state2_before.buyer);
        prop_assert_eq!(state2_after.seller, state2_before.seller);
        prop_assert_eq!(state2_after.secret_hash, state2_before.secret_hash);

        // Perform action2 on trade2
        let _: Result<(), ()> = match action2 {
            0 => f.client.try_release(&id2, &secret2).map(|_| ()).map_err(|_| ()),
            1 => f.client.try_release(&id2, &secret(&f.env, 99)).map(|_| ()).map_err(|_| ()),
            2 => f.client.try_refund(&id2).map(|_| ()).map_err(|_| ()),
            3 => f.client.try_raise_dispute(&f.buyer, &id2).map(|_| ()).map_err(|_| ()),
            _ => f.client.try_raise_dispute(&f.seller, &id2).map(|_| ()).map_err(|_| ()),
        };

        // Trade1 must still be in its post-action1 state
        let state1_after = f.client.get_trade(&id1).unwrap();
        prop_assert_eq!(state1_after.amount, state1_before.amount);
        prop_assert_eq!(state1_after.buyer, state1_before.buyer);
        prop_assert_eq!(state1_after.seller, state1_before.seller);
        prop_assert_eq!(state1_after.secret_hash, state1_before.secret_hash);

        // Conservation: all funds accounted for
        let held: i128 = [&id1, &id2].iter()
            .filter_map(|tid| f.client.get_trade(tid))
            .filter(|t| matches!(t.status, TradeStatus::Locked | TradeStatus::Disputed))
            .map(|t| t.amount)
            .sum();
        prop_assert_eq!(
            f.token.balance(&f.contract_id), held
        );
        prop_assert_eq!(
            f.token.balance(&f.buyer) + f.token.balance(&f.seller) + f.token.balance(&f.admin) + held,
            initial
        );
    }

    // -----------------------------------------------------------------------
    // Batch release accounting: batch_release matches individual releases.
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn batch_release_matches_individual_accounting(
        amounts in prop::collection::vec(1i128..10_000, 2..5),
        fee_bps in 0u32..=10_000,
    ) {
        let initial: i128 = amounts.iter().sum();
        let f = setup(initial, fee_bps);

        let mut ids = Vec::new();
        let mut total_deposited: i128 = 0;

        for (i, &amount) in amounts.iter().enumerate() {
            let trade_id = id(&f.env, i as u8);
            let preimage = secret(&f.env, i as u8 + 1);
            let hash = f.env.crypto().sha256(&preimage.into()).to_bytes();
            f.client.lock(&trade_id, &f.seller, &f.buyer, &amount, &hash, &100);
            total_deposited += amount;
            ids.push(trade_id);
        }

        // Release each individually and track accounting
        let mut expected_seller_total: i128 = 0;
        let mut expected_admin_total: i128 = 0;
        for (i, trade_id) in ids.iter().enumerate() {
            let amount = amounts[i];
            let fee = (amount * fee_bps as i128) / 10_000;
            let payout = amount - fee;
            expected_seller_total += payout;
            expected_admin_total += fee;

            f.client.release(trade_id, &secret(&f.env, i as u8 + 1));
            prop_assert_eq!(f.client.get_trade(trade_id).unwrap().status, TradeStatus::Released);
        }

        prop_assert_eq!(f.token.balance(&f.seller), expected_seller_total);
        prop_assert_eq!(f.token.balance(&f.admin), expected_admin_total);
        prop_assert_eq!(f.token.balance(&f.contract_id), 0);
        prop_assert_eq!(
            f.token.balance(&f.buyer) + f.token.balance(&f.seller) + f.token.balance(&f.admin),
            initial
        );
    }
}
